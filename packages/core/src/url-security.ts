import { ConfigurationError } from "./errors.js";

export interface TrustedEndpointOptions {
  label?: string;
  protocols: readonly string[];
  /**
   * Exact application-controlled DNS names. This synchronous validation cannot
   * pin DNS answers; server runtimes still need resolver/egress controls when a
   * trusted hostname itself could be rebound.
   */
  allowedHosts?: readonly string[];
  allowedHostSuffixes?: readonly string[];
  allowLoopback?: boolean;
  allowUnsafe?: boolean;
}

interface IpToken {
  value: number;
  base: "dec" | "hex" | "oct";
}

const METADATA_HOSTS = ["metadata.google.internal", "metadata.goog"];

const normalizedHostname = (hostname: string) =>
  hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");

const isMetadataHostname = (hostname: string) =>
  METADATA_HOSTS.some((name) => hostname === name || hostname.endsWith(`.${name}`));

/** Private, loopback, link-local, CGNAT, benchmarking, and non-unicast IPv4. */
const isDisallowedIPv4 = (octets: readonly number[]) => {
  const [a, b] = octets;
  if (a === undefined || b === undefined || octets.length !== 4) return false;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

const parseIpToken = (part: string): IpToken | undefined => {
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const value = Number.parseInt(part, 16);
    return Number.isSafeInteger(value) ? { value, base: "hex" } : undefined;
  }
  if (!/^\d+$/.test(part)) return undefined;
  if (part.length > 1 && part.startsWith("0")) {
    if (/[89]/.test(part)) return undefined;
    const value = Number.parseInt(part, 8);
    return Number.isSafeInteger(value) ? { value, base: "oct" } : undefined;
  }
  const value = Number(part);
  return Number.isSafeInteger(value) ? { value, base: "dec" } : undefined;
};

const octetsFrom32 = (value: number): number[] => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255
];

/** glibc inet_aton shapes: a, a.b, a.b.c, and a.b.c.d, including hex and octal. */
const inetOctets = (tokens: readonly IpToken[]): number[] | undefined => {
  const values = tokens.map((token) => token.value);
  if (values.some((value) => value < 0 || value > 0xffffffff)) return undefined;
  if (tokens.length === 1) {
    return values[0]! <= 0xffffffff ? octetsFrom32(values[0]!) : undefined;
  }
  if (tokens.length === 2 && values[0]! <= 0xff && values[1]! <= 0xffffff) {
    return octetsFrom32(values[0]! * 2 ** 24 + values[1]!);
  }
  if (tokens.length === 3 && values[0]! <= 0xff && values[1]! <= 0xff && values[2]! <= 0xffff) {
    return octetsFrom32(values[0]! * 2 ** 24 + values[1]! * 2 ** 16 + values[2]!);
  }
  if (tokens.length === 4 && values.every((value) => value <= 0xff)) {
    return values;
  }
  return undefined;
};

const singleLabelDisallowed = (token: IpToken) => {
  const encodedAddress = token.base !== "dec" || token.value > 255;
  if (!encodedAddress || token.value > 0xffffffff) return false;
  return isDisallowedIPv4(octetsFrom32(token.value));
};

/**
 * Reject lexical private addresses, including DNS-alias forms such as
 * 127.0.0.1.nip.io and 2130706433.nip.io. Sub-windows inside a longer dotted
 * address are not reparsed, so a public octet sequence is not flagged because
 * one of its pieces would be private on its own.
 */
const hasDisallowedIPv4Encoding = (hostname: string) => {
  const labels = hostname.split(".");
  let index = 0;
  while (index < labels.length) {
    const tokens: IpToken[] = [];
    while (index < labels.length) {
      const token = parseIpToken(labels[index]!);
      if (!token) break;
      tokens.push(token);
      index += 1;
    }
    if (tokens.length >= 4) {
      for (let offset = 0; offset <= tokens.length - 4; offset += 1) {
        const octets = inetOctets(tokens.slice(offset, offset + 4));
        if (octets && isDisallowedIPv4(octets)) return true;
      }
    } else if (tokens.length === 2 || tokens.length === 3) {
      const octets = inetOctets(tokens);
      if (octets && isDisallowedIPv4(octets)) return true;
    } else if (tokens.length === 1 && singleLabelDisallowed(tokens[0]!)) {
      return true;
    }
    if (!tokens.length) index += 1;
  }
  return false;
};

const parseDottedIPv4 = (value: string): number[] | undefined => {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : undefined;
};

const parseIPv6 = (hostname: string): Uint8Array | undefined => {
  let value = hostname;
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) return undefined;
    value = value.slice(1, -1);
  }
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
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
        const ipv4 = parseDottedIPv4(label);
        if (!ipv4) return undefined;
        groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
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

const bytesEqual = (bytes: Uint8Array, start: number, expected: readonly number[]) =>
  expected.every((value, index) => bytes[start + index] === value);

const embeddedIPv4 = (bytes: Uint8Array): number[] | undefined => {
  if (bytesEqual(bytes, 0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) {
    return [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  }
  if (bytes.subarray(0, 12).every((value) => value === 0)) {
    return [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return [bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!];
  }
  const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;
  const wellKnown = nat64 && bytes.subarray(4, 12).every((value) => value === 0);
  const localUse = nat64 && bytes[4] === 0x00 && bytes[5] === 0x01;
  if (wellKnown || localUse) return [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return [bytes[12]! ^ 0xff, bytes[13]! ^ 0xff, bytes[14]! ^ 0xff, bytes[15]! ^ 0xff];
  }
  return undefined;
};

const isDisallowedIPv6 = (bytes: Uint8Array) => {
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true;
  if ((bytes[0]! & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xff) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    const server = [bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!];
    const client = embeddedIPv4(bytes);
    return isDisallowedIPv4(server) || (client ? isDisallowedIPv4(client) : false);
  }
  const embedded = embeddedIPv4(bytes);
  return embedded ? isDisallowedIPv4(embedded) : false;
};

const isIPv6Loopback = (bytes: Uint8Array) =>
  bytes.every((value, index) => value === (index === 15 ? 1 : 0));

const entireHostnameIPv4 = (hostname: string): number[] | undefined => {
  const labels = hostname.split(".");
  const tokens = labels.map(parseIpToken);
  if (tokens.some((token) => !token) || tokens.length < 1 || tokens.length > 4) return undefined;
  return inetOctets(tokens as IpToken[]);
};

export const isPrivateNetworkHostname = (hostname: string): boolean => {
  const normalized = normalizedHostname(hostname);
  if (
    isMetadataHostname(normalized) ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "localtest.me" ||
    normalized.endsWith(".localtest.me")
  ) {
    return true;
  }
  if (hasDisallowedIPv4Encoding(normalized)) return true;
  const ipv6 = parseIPv6(normalized);
  return ipv6 ? isDisallowedIPv6(ipv6) : false;
};

export const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = normalizedHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  const ipv4 = entireHostnameIPv4(normalized);
  if (ipv4?.[0] === 127) return true;
  const ipv6 = parseIPv6(normalized);
  if (!ipv6) return false;
  if (isIPv6Loopback(ipv6)) return true;
  const embedded = embeddedIPv4(ipv6);
  return embedded?.[0] === 127;
};

const normalizedProtocols = (protocols: readonly string[]) =>
  new Set(protocols.map((protocol) => protocol.endsWith(":") ? protocol.toLowerCase() : `${protocol.toLowerCase()}:`));

export const assertTrustedEndpoint = (
  value: string | URL,
  options: TrustedEndpointOptions
): URL => {
  const label = options.label ?? "Endpoint";
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch (error) {
    throw new ConfigurationError(`${label} must be an absolute URL.`, { cause: error });
  }

  if (url.username || url.password) {
    throw new ConfigurationError(`${label} must not contain embedded credentials.`);
  }
  const protocols = normalizedProtocols(options.protocols);
  const protocol = url.protocol.toLowerCase();
  const unsafeProtocolEquivalent =
    options.allowUnsafe === true &&
    ((protocol === "http:" && protocols.has("https:")) ||
      (protocol === "ws:" && protocols.has("wss:")));
  if (!protocols.has(protocol) && !unsafeProtocolEquivalent) {
    throw new ConfigurationError(
      `${label} must use ${options.protocols.map((item) => item.replace(/:$/, "")).join(" or ")}.`
    );
  }
  if (options.allowUnsafe) {
    return url;
  }

  const hostname = normalizedHostname(url.hostname);
  if (!hostname || (isPrivateNetworkHostname(hostname) && !(options.allowLoopback && isLoopbackHostname(hostname)))) {
    throw new ConfigurationError(`${label} must not target a private, loopback, link-local, or metadata host.`);
  }

  const allowedHosts = new Set((options.allowedHosts ?? []).map(normalizedHostname));
  const allowedBySuffix = (options.allowedHostSuffixes ?? []).some((suffix) => {
    const normalizedSuffix = normalizedHostname(suffix).replace(/^\./, "");
    return hostname === normalizedSuffix || hostname.endsWith(`.${normalizedSuffix}`);
  });
  if ((allowedHosts.size > 0 || (options.allowedHostSuffixes?.length ?? 0) > 0) &&
      !allowedHosts.has(hostname) &&
      !allowedBySuffix) {
    throw new ConfigurationError(`${label} host "${url.hostname}" is not trusted.`);
  }

  return url;
};
