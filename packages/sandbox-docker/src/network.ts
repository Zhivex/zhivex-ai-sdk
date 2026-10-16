import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectNet, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";

import { isPrivateNetworkHostname } from "@zhivex-ai/core";

import { SandboxError } from "./errors.js";

const CONNECT_TIMEOUT_MS = 10_000;

/** Host-side limits for one allowlist proxy. These are enforced before any tunnel bytes flow. */
export const allowlistProxyQuotaDefaults = Object.freeze({
  maxConnections: 16,
  maxInFlight: 4,
  maxRequests: 128,
  maxBytes: 8_388_608,
  idleMs: 30_000,
  tunnelMs: 60_000
});

export interface AllowlistProxyQuotas {
  maxConnections: number;
  maxInFlight: number;
  maxRequests: number;
  maxBytes: number;
  idleMs: number;
  tunnelMs: number;
}

const bareAddress = (address: string) =>
  address.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").split("%")[0] ?? "";

const dottedIPv4 = (value: string): [number, number] | undefined => {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return undefined;
  const numbers = parts.map(Number);
  if (numbers.some(part => part > 255)) return undefined;
  return [(numbers[0]! << 8) | numbers[1]!, (numbers[2]! << 8) | numbers[3]!];
};

/** Parse an IPv6 literal to 16 bytes, including dotted and hex IPv4 tails. */
const ipv6Bytes = (address: string): Uint8Array | undefined => {
  let value = bareAddress(address);
  if (!value.includes(":") || value.includes(":::")) return undefined;
  const compression = value.indexOf("::");
  if (compression !== value.lastIndexOf("::")) return undefined;
  const expand = (side: string): number[] | undefined => {
    if (side === "") return [];
    const labels = side.split(":");
    const groups: number[] = [];
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index]!;
      if (label.includes(".")) {
        if (index !== labels.length - 1) return undefined;
        const tail = dottedIPv4(label);
        if (!tail) return undefined;
        groups.push(tail[0], tail[1]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(label)) return undefined;
      groups.push(Number.parseInt(label, 16));
    }
    return groups;
  };
  let groups: number[];
  if (compression === -1) {
    const parsed = expand(value);
    if (!parsed || parsed.length !== 8) return undefined;
    groups = parsed;
  } else {
    const left = expand(value.slice(0, compression));
    const right = expand(value.slice(compression + 2));
    if (!left || !right || left.length + right.length > 7) return undefined;
    groups = [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
};

const isDocumentationIPv4 = (address: string) => {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false;
  const numbers = parts.map(Number);
  if (numbers.some(part => part > 255)) return false;
  const [a, b, c] = numbers;
  return (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
};

const prefix = (bytes: Uint8Array, expected: readonly number[]) =>
  expected.every((value, index) => bytes[index] === value);

/** Documentation, discard-only, and deprecated site-local ranges the shared classifier does not cover. */
const isSpecialIPv6 = (bytes: Uint8Array) =>
  prefix(bytes, [0x20, 0x01, 0x0d, 0xb8]) ||
  prefix(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) ||
  prefix(bytes, [0x20, 0x01, 0x00, 0x02, 0x00, 0x00]) ||
  (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0);

/**
 * True for non-global addresses. Unparseable input is rejected.
 * Classification of private, mapped, compatible, NAT64, 6to4, and Teredo
 * addresses goes through the shared hostname helper, then local special ranges.
 */
export const isPrivateAddress = (address: string): boolean => {
  const bare = bareAddress(address);
  if (!bare || isPrivateNetworkHostname(bare)) return true;
  const version = isIP(bare);
  if (version === 4) return isDocumentationIPv4(bare);
  if (version !== 6) return true;
  const bytes = ipv6Bytes(bare);
  if (!bytes) return true;
  return isSpecialIPv6(bytes);
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

const resolveQuotas = (input: Partial<AllowlistProxyQuotas> | undefined): AllowlistProxyQuotas => {
  const quotas = { ...allowlistProxyQuotaDefaults, ...input };
  for (const [name, value] of Object.entries(quotas)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new SandboxError("LIMIT", `Allowlist proxy quota ${name} must be a positive integer.`);
    }
  }
  return quotas;
};

export const startAllowlistProxy = async (options: {
  policy: AllowlistPolicy;
  host?: string;
  resolveHost?: (hostname: string) => Promise<string[]>;
  quotas?: Partial<AllowlistProxyQuotas>;
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
    const addresses = await resolveWithin(resolveHost(host));
    if (addresses.length === 0) {
      throw new SandboxError("NETWORK_DENIED", `Allowlist host ${host} did not resolve.`);
    }
    if (!options.policy.allowPrivateNetworks && addresses.some(isPrivateAddress)) {
      throw new SandboxError("NETWORK_DENIED", `Allowlist host ${host} resolves to a private address.`);
    }
    return addresses;
  };

  const quotas = resolveQuotas(options.quotas);
  const tracked = new Set<Socket>();
  let inFlight = 0;
  let requests = 0;
  let transferred = 0;
  const server: Server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(405);
    response.end("Sandbox allowlist proxy accepts CONNECT only.");
  });
  server.on("connection", socket => {
    if (tracked.size >= quotas.maxConnections) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    tracked.add(socket);
    socket.setTimeout(quotas.idleMs);
    socket.on("timeout", () => socket.destroy());
    socket.on("data", () => socket.setTimeout(quotas.idleMs));
    socket.on("close", () => tracked.delete(socket));
  });

  server.on("connect", (request, clientSocket, head) => {
    const socket = clientSocket as Socket;
    socket.on("error", () => undefined);
    void (async () => {
      const target = connectTarget(request.url ?? "");
      let upstream: Socket | undefined;
      let counted = false;
      let tunnelTimer: ReturnType<typeof setTimeout> | undefined;
      const closeBoth = () => {
        if (tunnelTimer) clearTimeout(tunnelTimer);
        if (!socket.destroyed) socket.destroy();
        if (upstream && !upstream.destroyed) upstream.destroy();
      };
      try {
        if (!tracked.has(socket)) {
          socket.destroy();
          return;
        }
        requests += 1;
        if (requests > quotas.maxRequests || transferred >= quotas.maxBytes) {
          throw new SandboxError("NETWORK_DENIED", "Allowlist proxy quota is exhausted.");
        }
        if (inFlight >= quotas.maxInFlight) {
          throw new SandboxError("NETWORK_DENIED", "Allowlist proxy connection limit reached.");
        }
        if (!target) throw new SandboxError("NETWORK_DENIED", "CONNECT target is missing a host.");
        inFlight += 1;
        counted = true;
        await authorize(target.host, target.port);
        const fresh = await resolveWithin(resolveHost(target.host));
        const chosen = fresh[0];
        if (!chosen || (!options.policy.allowPrivateNetworks && fresh.some(isPrivateAddress))) {
          throw new SandboxError("NETWORK_DENIED", `Allowlist host ${target.host} resolves to a private address.`);
        }
        upstream = connectNet(target.port, chosen);
        upstream.on("error", () => undefined);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            upstream?.destroy();
            reject(new SandboxError("NETWORK_DENIED", "Allowlist connection timed out."));
          }, CONNECT_TIMEOUT_MS);
          upstream?.once("connect", () => {
            clearTimeout(timer);
            resolve();
          });
          upstream?.once("error", error => {
            clearTimeout(timer);
            reject(error);
          });
        });
        if (!options.policy.allowPrivateNetworks && isPrivateAddress(chosen)) {
          throw new SandboxError("NETWORK_DENIED", `Allowlist host ${target.host} resolves to a private address.`);
        }
        inFlight -= 1;
        counted = false;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) {
          transferred += head.length;
          if (transferred > quotas.maxBytes) throw new SandboxError("NETWORK_DENIED", "Allowlist proxy byte quota is exhausted.");
          upstream.write(head);
        }
        tunnelTimer = setTimeout(closeBoth, quotas.tunnelMs);
        const relay = (from: Socket, to: Socket) => {
          from.on("data", (chunk: Buffer) => {
            transferred += chunk.length;
            if (transferred > quotas.maxBytes) {
              closeBoth();
              return;
            }
            from.setTimeout(quotas.idleMs);
            if (!to.write(chunk)) from.pause();
          });
          to.on("drain", () => from.resume());
        };
        upstream.setTimeout(quotas.idleMs);
        upstream.on("timeout", closeBoth);
        relay(socket, upstream);
        relay(upstream, socket);
        socket.on("close", () => upstream?.destroy());
        upstream.on("close", () => socket.destroy());
        socket.on("error", closeBoth);
        upstream.on("error", closeBoth);
      } catch {
        if (counted) inFlight -= 1;
        upstream?.destroy();
        if (!socket.destroyed) socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
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
    close: () => new Promise(resolve => {
      for (const socket of [...tracked]) socket.destroy();
      server.close(() => resolve());
    })
  };
};

const connectTarget = (value: string): { host: string; port: number } | undefined => {
  const target = value.trim();
  if (target.startsWith("[")) {
    const end = target.indexOf("]");
    if (end <= 1 || target[end + 1] !== ":") return undefined;
    const port = Number(target.slice(end + 2));
    return { host: target.slice(1, end), port };
  }
  const colon = target.lastIndexOf(":");
  if (colon <= 0) return undefined;
  return { host: target.slice(0, colon), port: Number(target.slice(colon + 1)) };
};

const resolveWithin = async (pending: Promise<string[]>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string[]>((resolve, reject) => {
      timer = setTimeout(() => reject(new SandboxError("NETWORK_DENIED", "Allowlist DNS lookup exceeded its deadline.")), CONNECT_TIMEOUT_MS);
      pending.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
};
