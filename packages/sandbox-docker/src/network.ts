import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectNet, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { SandboxError } from "./errors.js";

const PRIVATE_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const;

const ipv4ToInt = (ip: string) => ip.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;

const inCidr = (ip: string, base: string, bits: number) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
};

/** True for loopback, link-local, private, multicast, and metadata addresses. */
export const isPrivateAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) return PRIVATE_V4.some(([base, bits]) => inCidr(address, base, bits));
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  return false;
};

export interface AllowlistPolicy {
  allowedDomains: readonly string[];
  allowedPorts: readonly number[];
  allowPrivateNetworks?: boolean;
}

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const normalizeAllowlist = (policy: AllowlistPolicy): { domains: string[]; ports: number[] } => {
  const domains = [...new Set(policy.allowedDomains.map(domain => domain.toLowerCase()))].sort();
  const ports = [...new Set(policy.allowedPorts)].sort((left, right) => left - right);
  if (domains.length === 0 || ports.length === 0) {
    throw new SandboxError("NETWORK_ALLOWLIST_EMPTY", "Network allowlist requires at least one domain and one port.");
  }
  for (const domain of domains) {
    if (domain === "localhost" || !domainPattern.test(domain) || isIP(domain)) {
      throw new SandboxError("NETWORK_ALLOWLIST_DOMAIN", `Allowlist domain "${domain}" is not a public DNS name.`);
    }
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxError("NETWORK_ALLOWLIST_PORT", `Allowlist port "${String(port)}" is outside 1-65535.`);
    }
  }
  return { domains, ports };
};

export interface AllowlistProxy {
  readonly port: number;
  close(): Promise<void>;
}

export const startAllowlistProxy = async (options: {
  policy: AllowlistPolicy;
  host?: string;
  resolveHost?: (hostname: string) => Promise<string[]>;
}): Promise<AllowlistProxy> => {
  const normalized = normalizeAllowlist(options.policy);
  const domains = new Set(normalized.domains);
  const ports = new Set(normalized.ports);
  const resolveHost = options.resolveHost ?? (async (hostname: string) => {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map(record => record.address);
  });

  const authorize = async (host: string, port: number) => {
    if (!domains.has(host.toLowerCase()) || !ports.has(port)) {
      throw new SandboxError("NETWORK_DENIED", `Egress to ${host}:${port} is not on the sandbox allowlist.`);
    }
    const addresses = await resolveHost(host);
    if (addresses.length === 0) {
      throw new SandboxError("NETWORK_DENIED", `Allowlist host ${host} did not resolve.`);
    }
    if (!options.policy.allowPrivateNetworks && addresses.some(isPrivateAddress)) {
      throw new SandboxError("NETWORK_DENIED", `Allowlist host ${host} resolves to a private address.`);
    }
    return addresses;
  };

  const server: Server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(405);
    response.end("Sandbox allowlist proxy accepts CONNECT only.");
  });

  server.on("connect", (request, clientSocket, head) => {
    const socket = clientSocket as Socket;
    void (async () => {
      const [host, rawPort] = (request.url ?? "").split(":");
      const port = Number(rawPort);
      try {
        if (!host) throw new SandboxError("NETWORK_DENIED", "CONNECT target is missing a host.");
        const addresses = await authorize(host, port);
        const upstream = connectNet(port, addresses[0]);
        await new Promise<void>((resolve, reject) => {
          upstream.once("connect", () => resolve());
          upstream.once("error", reject);
        });
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      } catch {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new SandboxError("NETWORK_PROXY", "Allowlist proxy did not bind a TCP port.");
  }
  return {
    port: address.port,
    close: () => new Promise(resolve => server.close(() => resolve()))
  };
};
