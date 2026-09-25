import { describe, expect, it } from "vitest";
import { createMcpHttpClient, collectMcpPages, createMcpOAuthProvider, type McpOAuthTokens } from "../src/mcp-http.js";

const json = (body: unknown, headers = {}) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
function server(handler: (request: any, init: RequestInit) => Response | Promise<Response>, capabilities: object = { tools: {}, resources: {}, prompts: {} }) {
  const calls: Array<{ body: any; init: RequestInit }> = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    calls.push({ body, init: init! });
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "test", version: "1" } } }, { "Mcp-Session-Id": "session-1" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return handler(body, init!);
  }) as typeof fetch;
  return { calls, fetcher };
}
describe("MCP HTTP", () => {
  it("negotiates once, forwards session, pages resources and reads text/blob", async () => {
    const fixture = server(request => json({ jsonrpc: "2.0", id: request.id, result: request.method === "resources/list" ? { resources: [{ uri: "file:///a", name: "a" }], nextCursor: "next" } : { contents: [{ uri: "file:///a", text: "hello" }, { uri: "file:///b", blob: "aGk=" }] } }));
    const client = createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher });
    expect(await client.listResources!({ cursor: "opaque" })).toHaveProperty("nextCursor", "next");
    expect(await client.readResource!({ uri: "file:///a" })).toHaveProperty("contents.1.blob", "aGk=");
    expect(fixture.calls.filter(c => c.body.method === "initialize")).toHaveLength(1);
    expect(new Headers(fixture.calls[2].init.headers).get("Mcp-Session-Id")).toBe("session-1");
    expect(fixture.calls[2].body.params.cursor).toBe("opaque");
    expect(fixture.calls[2].init.redirect).toBe("error");
  });
  it("reads a matching SSE response and cancels an open stream", async () => {
    let cancelled = false;
    const fixture = server(request => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`: keepalive\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } })}\n\n`));
    }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } }));
    expect(await createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher }).listTools()).toEqual({ tools: [] });
    expect(cancelled).toBe(true);
  });
  it("rejects missing capabilities without sending the method", async () => {
    const fixture = server(() => { throw new Error("unexpected"); }, { tools: {} });
    await expect(createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher }).listResources!()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(fixture.calls).toHaveLength(2);
  });
  it("bounds streamed bytes", async () => {
    const fixture = server(request => json({ jsonrpc: "2.0", id: request.id, result: { resources: [], padding: "x".repeat(2000) } }));
    await expect(createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher, maxResponseBytes: 1024 }).listResources!()).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("never replays a possibly executed tool after disconnect", async () => {
    const fixture = server(() => { throw new Error("secret in transport error"); });
    await expect(createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher }).callTool({ name: "write" })).rejects.toMatchObject({ code: "INDETERMINATE" });
    expect(fixture.calls.filter(c => c.body.method === "tools/call")).toHaveLength(1);
  });
  it("returns auth errors without retrying or leaking body", async () => {
    const fixture = server(() => new Response("secret", { status: 401 }));
    await expect(createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher, auth: { getAccessToken: async () => "token" } }).callTool({ name: "write" })).rejects.toMatchObject({ code: "AUTH_EXPIRED", message: "MCP authentication required or rejected." });
    expect(fixture.calls).toHaveLength(3);
  });
  it("rejects forbidden destinations before credentials or fetch", async () => {
    let accessed = false;
    await expect(createMcpHttpClient({ url: "https://mcp.test/mcp", destinationPolicy: () => false, auth: { getAccessToken: async () => { accessed = true; return "token"; } } }).initialize()).rejects.toMatchObject({ code: "DESTINATION_REJECTED" });
    expect(accessed).toBe(false);
  });
  it("cancels before dispatch", async () => {
    const fixture = server(() => { throw new Error("unexpected"); });
    await expect(createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher }).listTools({}, { abortSignal: AbortSignal.abort() })).rejects.toBeDefined();
    expect(fixture.calls).toHaveLength(0);
  });
});

function oauthFixture() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let stored: McpOAuthTokens | undefined;
  const fetcher = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("oauth-protected-resource")) return json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://auth.test"] });
    if (String(url).includes("oauth-authorization-server")) return json({ issuer: "https://auth.test", authorization_endpoint: "https://auth.test/authorize", token_endpoint: "https://auth.test/token", code_challenge_methods_supported: ["S256"] });
    return json({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 3600 });
  }) as typeof fetch;
  const options = { resource: "https://mcp.test/mcp", issuer: "https://auth.test", clientId: "client", redirectUri: "http://127.0.0.1:8080/callback", destinationPolicy: (url: URL) => ["mcp.test", "auth.test"].includes(url.hostname), fetch: fetcher, tokenStore: { load: async () => stored, save: async (tokens: McpOAuthTokens) => { stored = tokens; }, clear: async () => { stored = undefined; } } };
  return { calls, options, setTokens: (tokens: McpOAuthTokens) => { stored = tokens; }, getTokens: () => stored };
}
describe("MCP OAuth", () => {
  it("binds PKCE, state, issuer, resource and external store; consumes callbacks once", async () => {
    const fixture = oauthFixture();
    const provider = createMcpOAuthProvider(fixture.options);
    const started = await provider.beginAuthorization();
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(fixture.options.resource);
    await expect(provider.completeAuthorization(`${fixture.options.redirectUri}?code=code&state=wrong`)).rejects.toMatchObject({ code: "AUTH_REJECTED" });
    const callback = `${fixture.options.redirectUri}?code=code&state=${started.state}&iss=https%3A%2F%2Fauth.test`;
    await provider.completeAuthorization(callback);
    expect(fixture.getTokens()).toMatchObject({ resource: fixture.options.resource, issuer: fixture.options.issuer, clientId: "client" });
    const tokenBody = new URLSearchParams(fixture.calls.at(-1)!.init!.body as string);
    expect(tokenBody.get("code_verifier")).toHaveLength(43);
    expect(tokenBody.get("resource")).toBe(fixture.options.resource);
    await expect(provider.completeAuthorization(callback)).rejects.toMatchObject({ code: "AUTH_REJECTED" });
    for (const call of fixture.calls) { expect(call.init?.redirect).toBe("error"); expect(new Headers(call.init?.headers).has("Authorization")).toBe(false); }
  });
  it("singleflights refresh for concurrent requests", async () => {
    const fixture = oauthFixture();
    fixture.setTokens({ accessToken: "old", refreshToken: "refresh", expiresAt: 0, issuer: fixture.options.issuer, resource: fixture.options.resource, clientId: "client" });
    const provider = createMcpOAuthProvider(fixture.options);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => provider.getAccessToken({ resource: fixture.options.resource, abortSignal: new AbortController().signal })));
    expect(tokens).toEqual(Array(5).fill("access-secret"));
    expect(fixture.calls.filter(c => c.url.endsWith("/token"))).toHaveLength(1);
  });
  it("rejects poisoned discovery before token or browser navigation", async () => {
    const fixture = oauthFixture();
    const provider = createMcpOAuthProvider({ ...fixture.options, fetch: (async () => json({ resource: fixture.options.resource, authorization_servers: ["https://evil.test"] })) as typeof fetch });
    await expect(provider.beginAuthorization()).rejects.toMatchObject({ code: "AUTH_REJECTED" });
  });
  it("rejects a challenge pointing outside the host allowlist", async () => {
    const fixture = oauthFixture();
    await expect(createMcpOAuthProvider(fixture.options).beginAuthorization({ wwwAuthenticate: 'Bearer resource_metadata="https://evil.test/metadata"' })).rejects.toMatchObject({ code: "DESTINATION_REJECTED" });
    expect(fixture.calls).toHaveLength(0);
  });
  it("rejects stored tokens bound to another resource", async () => {
    const fixture = oauthFixture();
    fixture.setTokens({ accessToken: "secret", issuer: fixture.options.issuer, resource: "https://other.test", clientId: "client" });
    await expect(createMcpOAuthProvider(fixture.options).getAccessToken({ resource: fixture.options.resource, abortSignal: new AbortController().signal })).rejects.toMatchObject({ code: "AUTH_REJECTED" });
    expect(fixture.calls).toHaveLength(0);
  });
});

describe("MCP concurrency and recovery", () => {
  it("does not expose mutable capabilities", async () => {
    const fixture = server(() => { throw new Error("unexpected"); }, { tools: {} });
    const client = createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher });
    const caps = await client.initialize();
    caps.resources = {};
    await expect(client.listResources!()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
  it("aborts a waiter without cancelling shared initialization", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const fixture = server(req => json({ jsonrpc: "2.0", id: req.id, result: { tools: [] } }));
    const client = createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: (async (...args) => { await blocked; return fixture.fetcher(...args); }) as typeof fetch });
    const first = client.initialize();
    const controller = new AbortController();
    const second = client.initialize({ abortSignal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    release();
    expect(await first).toHaveProperty("tools");
  });
  it("explicit subsequent call reinitializes an expired session without replay", async () => {
    let count = 0;
    const fixture = server(req => ++count === 1 ? new Response(null, { status: 404 }) : json({ jsonrpc: "2.0", id: req.id, result: { tools: [] } }));
    const client = createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher });
    await expect(client.listTools()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(fixture.calls.filter(c => c.body.method === "initialize")).toHaveLength(2);
  });
  it("clears credentials even when a token save is in flight", async () => {
    const fixture = oauthFixture();
    let saved!: () => void;
    let release!: () => void;
    const saving = new Promise<void>(resolve => { saved = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const provider = createMcpOAuthProvider({ ...fixture.options, tokenStore: { ...fixture.options.tokenStore, save: async tokens => { saved(); await blocked; await fixture.options.tokenStore.save(tokens); } } });
    const start = await provider.beginAuthorization();
    const completing = provider.completeAuthorization(`${fixture.options.redirectUri}?code=code&state=${start.state}`);
    const observed = expect(completing).rejects.toMatchObject({ code: "AUTH_REJECTED" });
    await saving;
    const clearing = provider.clear();
    release();
    await clearing;
    await observed;
    expect(fixture.getTokens()).toBeUndefined();
  });
  it("does not reuse an uncertain rotated refresh token after a lost response", async () => {
    const fixture = oauthFixture();
    fixture.setTokens({ accessToken: "old", refreshToken: "refresh", expiresAt: 0, issuer: fixture.options.issuer, resource: fixture.options.resource, clientId: "client" });
    let exchanges = 0;
    const provider = createMcpOAuthProvider({ ...fixture.options, fetch: (async (url, init) => { if (String(url).endsWith("/token")) { exchanges++; throw new Error("disconnected"); } return fixture.options.fetch(url, init); }) as typeof fetch });
    const input = { resource: fixture.options.resource, abortSignal: new AbortController().signal };
    await expect(provider.getAccessToken(input)).rejects.toMatchObject({ code: "AUTH_REJECTED" });
    await expect(provider.getAccessToken(input)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(exchanges).toBe(1);
  });
  it("aborts a refresh waiter promptly while preserving the shared refresh", async () => {
    const fixture = oauthFixture();
    fixture.setTokens({ accessToken: "old", refreshToken: "refresh", expiresAt: 0, issuer: fixture.options.issuer, resource: fixture.options.resource, clientId: "client" });
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const provider = createMcpOAuthProvider({ ...fixture.options, fetch: (async (url, init) => { if (String(url).endsWith("/token")) { started(); await blocked; } return fixture.options.fetch(url, init); }) as typeof fetch });
    const first = provider.getAccessToken({ resource: fixture.options.resource, abortSignal: new AbortController().signal });
    await entered;
    const controller = new AbortController();
    const second = provider.getAccessToken({ resource: fixture.options.resource, abortSignal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    release();
    expect(await first).toBe("access-secret");
  });
});

describe("MCP bounds and message validation", () => {
  it("bounds pages and rejects repeated opaque cursors", async () => {
    await expect(collectMcpPages(async () => ({ items: [1], nextCursor: "same" }))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(collectMcpPages(async () => ({ items: [1, 2] }), { maxItems: 1 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(collectMcpPages(async () => ({ items: [], nextCursor: "more" }), { maxPages: 1 })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("validates prompt messages before returning them", async () => {
    const fixture = server(req => json({ jsonrpc: "2.0", id: req.id, result: { messages: [{ role: "system", content: null }] } }));
    await expect(createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher }).getPrompt!({ name: "bad" })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
  it("marks malformed tool responses indeterminate", async () => {
    const fixture = server(req => json({ jsonrpc: "2.0", id: req.id, result: "malformed" }));
    await expect(createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher }).callTool({ name: "write" })).rejects.toMatchObject({ code: "INDETERMINATE" });
  });
  it("responds to server ping on a CR-delimited SSE stream", async () => {
    let replied = false;
    const fixture = server(req => {
      if (req.id === "ping-id") { replied = true; return new Response(null, { status: 202 }); }
      return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "ping-id", method: "ping" })}\r\rdata: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [] } })}\r\r`, { headers: { "Content-Type": "text/event-stream" } });
    });
    expect(await createMcpHttpClient({ url: "https://mcp.test/mcp", fetch: fixture.fetcher }).listTools()).toEqual({ tools: [] });
    expect(replied).toBe(true);
  });
});
