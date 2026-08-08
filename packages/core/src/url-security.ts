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

const ipv4Parts = (hostname: string): number[] | undefined => {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return undefined;
  }
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : undefined;
};

const isPrivateIPv4 = (hostname: string) => {
  const parts = ipv4Parts(hostname);
  if (!parts) {
    return false;
  }
  const [a, b] = parts;
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

const normalizedHostname = (hostname: string) =>
  hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");

const hasEmbeddedPrivateIPv4 = (hostname: string) => {
  const labels = hostname.split(".");
  for (let index = 0; index <= labels.length - 4; index += 1) {
    if (isPrivateIPv4(labels.slice(index, index + 4).join("."))) {
      return true;
    }
  }
  return false;
};

export const isPrivateNetworkHostname = (hostname: string): boolean => {
  const normalized = normalizedHostname(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "localtest.me" ||
    normalized.endsWith(".localtest.me") ||
    normalized === "::" ||
    normalized === "::1"
  ) {
    return true;
  }
  // Reject DNS alias services such as 127.0.0.1.nip.io without performing a
  // racy preflight lookup. Arbitrary DNS rebinding still requires host
  // allowlists plus resolver/egress enforcement by the server runtime.
  if (isPrivateIPv4(normalized) || hasEmbeddedPrivateIPv4(normalized)) {
    return true;
  }
  if (!normalized.includes(":")) {
    return false;
  }
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isPrivateIPv4(mapped)) {
      return true;
    }
    const groups = mapped.split(":");
    if (
      groups.length === 2 &&
      groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
    ) {
      const high = Number.parseInt(groups[0]!, 16);
      const low = Number.parseInt(groups[1]!, 16);
      return isPrivateIPv4(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
      );
    }
  }
  return (
    /^f[cd][0-9a-f]{0,2}:/.test(normalized) ||
    /^fe[89ab]/.test(normalized)
  );
};

export const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = normalizedHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
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
    url = value instanceof URL ? new URL(value) : new URL(value);
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
      `${label} must use ${options.protocols.map((protocol) => protocol.replace(/:$/, "")).join(" or ")}.`
    );
  }
  if (options.allowUnsafe) {
    return url;
  }

  const hostname = normalizedHostname(url.hostname);
  if (isPrivateNetworkHostname(hostname) && !(options.allowLoopback && isLoopbackHostname(hostname))) {
    throw new ConfigurationError(`${label} must not target a private, loopback, or link-local host.`);
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
