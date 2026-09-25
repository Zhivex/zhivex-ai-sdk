import { z } from "zod";
import { checkMcpDestination, McpHttpError, mcpPositiveInteger, readMcpJson, withMcpAbort, type McpAuthorizationChallenge, type McpDestinationPolicy } from "./mcp-http-common.js";
import type { McpHttpAuthProvider } from "./mcp-http-common.js";

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Exact authorization server and protected resource binding. */
  issuer: string;
  resource: string;
  clientId: string;
}
export interface McpOAuthTokenStore {
  load(): Promise<McpOAuthTokens | undefined>;
  save(tokens: McpOAuthTokens): Promise<void>;
  clear(): Promise<void>;
}
export interface McpOAuthOptions {
  resource: string;
  /** Host-selected trusted issuer. Discovered metadata cannot change this binding. */
  issuer: string;
  clientId: string;
  redirectUri: string;
  tokenStore: McpOAuthTokenStore;
  /** Explicit host allowlist, required for all discovered endpoints. */
  destinationPolicy: McpDestinationPolicy;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  scopes?: string[];
}
export interface McpOAuthProvider extends McpHttpAuthProvider {
  /** Returns a URL for the host to open only after its own approval flow. */
  beginAuthorization(input?: { wwwAuthenticate?: string; challenge?: McpAuthorizationChallenge; abortSignal?: AbortSignal }): Promise<{ authorizationUrl: string; state: string }>;
  completeAuthorization(callbackUrl: string, input?: { abortSignal?: AbortSignal }): Promise<void>;
  clear(): Promise<void>;
}
const metadataSchema = z.object({
  issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(),
  code_challenge_methods_supported: z.array(z.string())
});
const tokenSchema = z.object({ access_token: z.string().min(1), token_type: z.string(), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive().finite().optional() });
const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** OAuth public-client authorization code + S256 PKCE. Credential storage and browser navigation belong to the host. */
export function createMcpOAuthProvider(options: McpOAuthOptions): McpOAuthProvider {
  const fetcher = options.fetch ?? globalThis.fetch;
  const resource = new URL(options.resource).href;
  const issuer = options.issuer;
  const redirect = new URL(options.redirectUri);
  if (redirect.username || redirect.password || redirect.hash || redirect.search || (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(redirect.hostname)))) throw new McpHttpError("DESTINATION_REJECTED", "OAuth callback must use HTTPS or an IP loopback URI.");
  if (!options.clientId) throw new McpHttpError("PROTOCOL_ERROR", "OAuth client identifier is required.");
  const maxBytes = mcpPositiveInteger(options.maxResponseBytes, 64 * 1024);
  const timeout = mcpPositiveInteger(options.timeoutMs, 30_000);
  let metadata: z.infer<typeof metadataSchema> | undefined;
  let pending: { state: string; verifier: string; expiresAt: number; generation: number } | undefined;
  let refreshing: Promise<string> | undefined;
  let generation = 0;
  let writes: Promise<void> = Promise.resolve();
  const write = (operation: () => Promise<void>) => {
    const next = writes.then(operation);
    writes = next.catch(() => {});
    return next;
  };
  async function request(url: string, purpose: "discovery" | "token", signal: AbortSignal, body?: URLSearchParams): Promise<unknown | undefined> {
    signal.throwIfAborted();
    await checkMcpDestination(url, purpose, options.destinationPolicy);
    let response: Response;
    try { response = await fetcher(url, { method: body ? "POST" : "GET", redirect: "error", signal, headers: body ? { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } : { Accept: "application/json" }, ...(body ? { body: body.toString() } : {}) }); }
    catch { throw new McpHttpError("AUTH_REJECTED", "OAuth endpoint request failed."); }
    if (!response.ok) {
      await response.body?.cancel();
      if (purpose === "discovery" && [404, 405].includes(response.status)) return undefined;
      throw new McpHttpError(purpose === "token" ? "AUTH_EXPIRED" : "AUTH_REJECTED", "OAuth endpoint rejected the request.");
    }
    return readMcpJson(response, maxBytes);
  }
  async function discover(signal: AbortSignal, challenge?: string, supplied?: McpAuthorizationChallenge) {
    if (metadata) return metadata;
    await checkMcpDestination(resource, "server", options.destinationPolicy);
    await checkMcpDestination(issuer, "discovery", options.destinationPolicy);
    const resourceUrl = new URL(resource);
    const challengedUrl = supplied?.resourceMetadataUrl ?? challenge?.match(/(?:^|[\s,])resource_metadata\s*=\s*"([^"\\]+)"/i)?.[1];
    const resourceUrls = challengedUrl ? [challengedUrl] : [...new Set([`${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`, `${resourceUrl.origin}/.well-known/oauth-protected-resource`])];
    let protectedMetadata: unknown;
    for (const url of resourceUrls) { protectedMetadata = await request(url, "discovery", signal); if (protectedMetadata !== undefined) break; }
    const protectedResult = z.object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) }).safeParse(protectedMetadata);
    if (!protectedResult.success || protectedResult.data.resource !== resource || !protectedResult.data.authorization_servers.includes(issuer)) throw new McpHttpError("AUTH_REJECTED", "OAuth protected resource or issuer binding mismatch.");
    const issuerUrl = new URL(issuer);
    const path = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;
    const urls = [...new Set([`${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`, `${issuerUrl.origin}/.well-known/openid-configuration${path}`, `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`])];
    let authorizationMetadata: unknown;
    for (const url of urls) { authorizationMetadata = await request(url, "discovery", signal); if (authorizationMetadata !== undefined) break; }
    const parsed = metadataSchema.safeParse(authorizationMetadata);
    if (!parsed.success || parsed.data.issuer !== issuer || !parsed.data.code_challenge_methods_supported.includes("S256")) throw new McpHttpError("AUTH_REJECTED", "OAuth issuer metadata or PKCE support is invalid.");
    await checkMcpDestination(parsed.data.authorization_endpoint, "authorization", options.destinationPolicy);
    await checkMcpDestination(parsed.data.token_endpoint, "token", options.destinationPolicy);
    metadata = parsed.data;
    return metadata;
  }
  async function exchange(body: URLSearchParams, signal: AbortSignal, oldRefresh?: string, currentGeneration = generation): Promise<string> {
    signal.throwIfAborted();
    if (currentGeneration !== generation) throw new McpHttpError("AUTH_REJECTED", "OAuth authorization was cleared during exchange.");
    const endpoints = await discover(signal);
    body.set("client_id", options.clientId);
    body.set("resource", resource);
    const parsed = tokenSchema.safeParse(await request(endpoints.token_endpoint, "token", signal, body));
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer" || /[\r\n]/.test(parsed.data.access_token)) throw new McpHttpError("AUTH_REJECTED", "Invalid OAuth token response.");
    signal.throwIfAborted();
    await write(async () => {
    signal.throwIfAborted();
    if (generation !== currentGeneration) throw new McpHttpError("AUTH_REJECTED", "OAuth authorization was cleared during exchange.");
    await options.tokenStore.save({ accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token ?? oldRefresh, expiresAt: parsed.data.expires_in === undefined ? undefined : Date.now() + parsed.data.expires_in * 1000, issuer, resource, clientId: options.clientId });
    });
    if (generation !== currentGeneration) throw new McpHttpError("AUTH_REJECTED", "OAuth authorization was cleared during exchange.");
    return parsed.data.access_token;
  }
  return {
    async beginAuthorization(input = {}) {
      return withMcpAbort(async signal => {
      const endpoints = await discover(signal, input.wwwAuthenticate, input.challenge);
      const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      signal.throwIfAborted();
      pending = { state, verifier, expiresAt: Date.now() + 10 * 60_000, generation };
      const url = new URL(endpoints.authorization_endpoint);
      const scopes = input.challenge?.scope ?? input.wwwAuthenticate?.match(/(?:^|[\s,])scope\s*=\s*"([^"\\]*)"/i)?.[1] ?? options.scopes?.join(" ");
      for (const [key, value] of Object.entries({ response_type: "code", client_id: options.clientId, redirect_uri: redirect.href, resource, state, code_challenge: challenge, code_challenge_method: "S256", ...(scopes ? { scope: scopes } : {}) })) url.searchParams.set(key, value);
      return { authorizationUrl: url.href, state };
      }, [input.abortSignal], timeout);
    },
    async completeAuthorization(callbackUrl, input = {}) {
      const callback = new URL(callbackUrl);
      const transaction = pending;
      if (!transaction || transaction.expiresAt < Date.now() || callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.hash || callback.username || callback.password || callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== transaction.state) throw new McpHttpError("AUTH_REJECTED", "OAuth callback state or destination mismatch.");
      pending = undefined;
      if (callback.searchParams.has("iss") && callback.searchParams.get("iss") !== issuer) throw new McpHttpError("AUTH_REJECTED", "OAuth callback issuer mismatch.");
      if (callback.searchParams.has("error") || callback.searchParams.getAll("code").length !== 1 || !callback.searchParams.get("code")) throw new McpHttpError("AUTH_REJECTED", "OAuth authorization was rejected.");
      await withMcpAbort(signal => exchange(new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: redirect.href, code_verifier: transaction.verifier }), signal, undefined, transaction.generation), [input.abortSignal], timeout);
    },
    async getAccessToken(input) {
      if (input.resource !== resource) throw new McpHttpError("AUTH_REJECTED", "OAuth token resource mismatch.");
      input.abortSignal.throwIfAborted();
      if (refreshing) return withMcpAbort(() => refreshing!, [input.abortSignal], timeout);
      const requestGeneration = generation;
      const tokens = await options.tokenStore.load();
      if (requestGeneration !== generation) throw new McpHttpError("AUTH_REJECTED", "OAuth authorization was cleared.");
      if (refreshing) return withMcpAbort(() => refreshing!, [input.abortSignal], timeout);
      if (!tokens) throw new McpHttpError("AUTH_REQUIRED", "OAuth authorization is required.");
      if (tokens.issuer !== issuer || tokens.resource !== resource || tokens.clientId !== options.clientId) throw new McpHttpError("AUTH_REJECTED", "Stored OAuth token binding mismatch.");
      if (tokens.expiresAt === undefined || tokens.expiresAt > Date.now() + 30_000) return tokens.accessToken;
      if (!tokens.refreshToken) throw new McpHttpError("AUTH_EXPIRED", "OAuth token has expired.");
      if (!refreshing) refreshing = withMcpAbort(async signal => {
        // Consume the old refresh credential durably before a potentially rotating request.
        await write(() => options.tokenStore.clear());
        return exchange(new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken! }), signal, tokens.refreshToken, requestGeneration);
      }, [], timeout).finally(() => { refreshing = undefined; });
      const token = await withMcpAbort(() => refreshing!, [input.abortSignal], timeout);
      input.abortSignal.throwIfAborted();
      return token;
    },
    async clear() { generation++; pending = undefined; await write(() => options.tokenStore.clear()); }
  };
}
