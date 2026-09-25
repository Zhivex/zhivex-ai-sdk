import { z } from "zod";
import type { McpCallToolOptions, McpClient, McpServerCapabilities } from "./mcp.js";
import { checkMcpDestination, McpHttpError, mcpPositiveInteger, withMcpAbort, type McpDestinationPolicy, type McpHttpAuthProvider } from "./mcp-http-common.js";
export { McpHttpError } from "./mcp-http-common.js";
export type { McpHttpAuthProvider, McpHttpErrorCode, McpDestinationPolicy, McpDestinationPurpose, McpAuthorizationChallenge } from "./mcp-http-common.js";
export * from "./mcp-oauth.js";

export interface McpHttpClientOptions {
  url: string;
  fetch?: typeof globalThis.fetch;
  auth?: McpHttpAuthProvider;
  destinationPolicy?: McpDestinationPolicy;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  clientInfo?: { name: string; version: string };
}
export interface McpHttpClient extends McpClient {
  initialize(options?: McpCallToolOptions): Promise<McpServerCapabilities>;
  close(): void;
}
const record = z.record(z.string(), z.unknown());
const page = { nextCursor: z.string().optional() };
const resource = z.object({ uri: z.string(), name: z.string(), title: z.string().optional(), description: z.string().optional(), mimeType: z.string().optional() });
const tool = z.object({ name: z.string(), inputSchema: record, description: z.string().optional() }).passthrough();

/** Opt-in Streamable HTTP client pinned to MCP 2025-11-25. Never retries a request. */
export function createMcpHttpClient(options: McpHttpClientOptions): McpHttpClient {
  const endpoint = new URL(options.url).href;
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeout = mcpPositiveInteger(options.timeoutMs, 30_000);
  const maxBytes = mcpPositiveInteger(options.maxResponseBytes, 4 * 1024 * 1024);
  const maxRequest = mcpPositiveInteger(options.maxRequestBytes, 1024 * 1024);
  const lifetime = new AbortController();
  let capabilities: McpServerCapabilities | undefined;
  let session: string | undefined;
  let nextId = 0;
  let initializing: Promise<McpServerCapabilities> | undefined;

  async function post(method: string, params: unknown, call: McpCallToolOptions = {}, notification = false, rpcResponse?: object): Promise<unknown> {
    let dispatched = false;
    return withMcpAbort(async signal => {
    signal.throwIfAborted();
    await checkMcpDestination(endpoint, "server", options.destinationPolicy);
    const token = await options.auth?.getAccessToken({ resource: endpoint, abortSignal: signal });
    signal.throwIfAborted();
    const id = notification ? undefined : ++nextId;
    const body = JSON.stringify(rpcResponse ?? { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });
    if (new TextEncoder().encode(body).byteLength > maxRequest) throw new McpHttpError("LIMIT_EXCEEDED", "MCP request exceeded byte limit.");
    try {
      const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" });
      if (session) headers.set("Mcp-Session-Id", session);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      dispatched = true;
      const response = await fetcher(endpoint, { method: "POST", headers, body, signal, redirect: "error" });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new McpHttpError(response.status === 403 ? "AUTH_REJECTED" : token ? "AUTH_EXPIRED" : "AUTH_REQUIRED", "MCP authentication required or rejected.", {
          resourceMetadataUrl: response.headers.get("WWW-Authenticate")?.match(/(?:^|[\s,])resource_metadata\s*=\s*"([^"\\]+)"/i)?.[1],
          scope: response.headers.get("WWW-Authenticate")?.match(/(?:^|[\s,])scope\s*=\s*"([^"\\]*)"/i)?.[1]
        });
      }
      if (response.status === 404 && session) { session = undefined; capabilities = undefined; initializing = undefined; }
      if (!response.ok) { await response.body?.cancel(); throw new McpHttpError(method === "tools/call" ? "INDETERMINATE" : "PROTOCOL_ERROR", "MCP HTTP request failed."); }
      if (notification) { await response.body?.cancel(); if (response.status !== 202) throw new McpHttpError("PROTOCOL_ERROR", "MCP notification was not accepted."); return {}; }
      const sessionHeader = response.headers.get("Mcp-Session-Id");
      if (method === "initialize" && sessionHeader) {
        if (!/^[\x21-\x7e]{1,1024}$/.test(sessionHeader)) { await response.body?.cancel(); throw new McpHttpError("PROTOCOL_ERROR", "Invalid MCP session identifier."); }
        session = sessionHeader;
      }
      const isSse = response.headers.get("Content-Type")?.split(";")[0].trim() === "text/event-stream";
      if (!isSse && response.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") { await response.body?.cancel(); throw new McpHttpError("PROTOCOL_ERROR", "Unsupported MCP response content type."); }
      const reader = response.body?.getReader();
      if (!reader) throw new McpHttpError("PROTOCOL_ERROR", "Empty MCP response.");
      let bytes = 0;
      let buffer = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parse = async (data: string): Promise<{ result: unknown } | undefined> => {
        const message = JSON.parse(data);
        if (!message || message.jsonrpc !== "2.0") throw new McpHttpError("PROTOCOL_ERROR", "Invalid MCP response envelope.");
        if (typeof message.method === "string") {
          if (message.id !== undefined) await post("", {}, call, true, { jsonrpc: "2.0", id: message.id, ...(message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Client capability not supported." } }) });
          return;
        }
        if (message.id !== id) {
          if (message.id === undefined && typeof message.method === "string") return;
          throw new McpHttpError("PROTOCOL_ERROR", "Unexpected MCP response identifier.");
        }
        if (message.error) throw new McpHttpError("PROTOCOL_ERROR", "MCP server returned a JSON-RPC error.");
        if (!("result" in message)) throw new McpHttpError("PROTOCOL_ERROR", "Missing MCP response result.");
        return { result: message.result };
      };
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new McpHttpError("LIMIT_EXCEEDED", "MCP response exceeded byte limit.");
          buffer += decoder.decode(chunk.value, { stream: true });
          if (isSse) {
            let match: RegExpExecArray | null;
            while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
              const event = buffer.slice(0, match.index);
              buffer = buffer.slice(match.index + match[0].length);
              const data = event.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
              if (!data) continue;
              const parsed = await parse(data);
              if (parsed) return parsed.result;
            }
          }
        }
        buffer += decoder.decode();
        if (!isSse) { const parsed = await parse(buffer); if (parsed) return parsed.result; }
        throw new McpHttpError("PROTOCOL_ERROR", "MCP stream ended without a response.");
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (error instanceof McpHttpError && error.code !== "PROTOCOL_ERROR" && error.code !== "LIMIT_EXCEEDED") throw error;
      if (dispatched && method === "tools/call") throw new McpHttpError("INDETERMINATE", "MCP tool execution may have occurred; reconcile before retrying.");
      if (error instanceof McpHttpError) throw error;
      if (signal.aborted) throw signal.reason;
      throw new McpHttpError("PROTOCOL_ERROR", "MCP transport failed.");
    }
    }, [lifetime.signal, call.abortSignal], mcpPositiveInteger(call.timeoutMs, timeout)).catch(error => {
      if (dispatched && method === "tools/call" && !(error instanceof McpHttpError)) throw new McpHttpError("INDETERMINATE", "MCP tool execution may have occurred; reconcile before retrying.");
      throw error;
    });
  }
  async function initialize(call: McpCallToolOptions = {}): Promise<McpServerCapabilities> {
    call.abortSignal?.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (capabilities) return structuredClone(capabilities);
    if (!initializing) initializing = (async () => {
      const result = z.object({ protocolVersion: z.literal("2025-11-25"), capabilities: z.object({ tools: record.optional(), resources: record.optional(), prompts: record.optional() }) }).safeParse(await post("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: options.clientInfo ?? { name: "zhivex-ai", version: "1" } }));
      if (!result.success) throw new McpHttpError("PROTOCOL_ERROR", "Unsupported MCP initialization result.");
      await post("notifications/initialized", {}, {}, true);
      capabilities = result.data.capabilities;
      return capabilities;
    })().catch(error => { initializing = undefined; session = undefined; throw error; });
    return structuredClone(await withMcpAbort(() => initializing!, [lifetime.signal, call.abortSignal], mcpPositiveInteger(call.timeoutMs, timeout)));
  }
  async function invoke(method: string, params: unknown, call?: McpCallToolOptions): Promise<unknown> {
    const caps = await initialize(call);
    const capability = method.split("/")[0] as keyof McpServerCapabilities;
    if (!caps[capability]) throw new McpHttpError("UNSUPPORTED_CAPABILITY", "MCP server does not advertise this capability.");
    return post(method, params ?? {}, call);
  }
  async function validated<T>(schema: z.ZodType<T>, method: string, params: unknown, call?: McpCallToolOptions): Promise<T> {
    const result = schema.safeParse(await invoke(method, params, call));
    if (!result.success) throw new McpHttpError("PROTOCOL_ERROR", "Invalid MCP result shape.");
    return result.data;
  }
  return {
    get capabilities() { return capabilities ? structuredClone(capabilities) : undefined; },
    initialize,
    close() { lifetime.abort(); capabilities = undefined; session = undefined; },
    listTools: (input, call) => validated(z.object({ tools: z.array(tool), ...page }), "tools/list", input, call) as ReturnType<McpClient["listTools"]>,
    callTool: async (input, call) => {
      const result = z.object({ content: z.array(z.json()), structuredContent: z.record(z.string(), z.json()).optional(), isError: z.boolean().optional() }).catchall(z.json()).safeParse(await invoke("tools/call", input, call));
      if (!result.success) throw new McpHttpError("INDETERMINATE", "Invalid MCP tool response; reconcile before retrying.");
      return result.data;
    },
    listResources: (input, call) => validated(z.object({ resources: z.array(resource), ...page }), "resources/list", input, call),
    listResourceTemplates: (input, call) => validated(z.object({ resourceTemplates: z.array(resource.omit({ uri: true }).extend({ uriTemplate: z.string() })), ...page }), "resources/templates/list", input, call),
    readResource: (input, call) => validated(z.object({ contents: z.array(z.union([z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string() }), z.object({ uri: z.string(), mimeType: z.string().optional(), blob: z.string() })])) }), "resources/read", input, call),
    listPrompts: (input, call) => validated(z.object({ prompts: z.array(z.object({ name: z.string(), description: z.string().optional(), arguments: z.array(z.object({ name: z.string(), description: z.string().optional(), required: z.boolean().optional() })).optional() })), ...page }), "prompts/list", input, call),
    getPrompt: (input, call) => validated(z.object({ description: z.string().optional(), messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.json() })) }), "prompts/get", input, call)
  };
}

export interface McpPaginationOptions extends McpCallToolOptions {
  maxPages?: number;
  maxItems?: number;
}
/** Explicit bounded collection for any MCP list operation, without opaque-cursor assumptions. */
export async function collectMcpPages<T>(
  listPage: (cursor: string | undefined, options: McpCallToolOptions) => Promise<{ items: T[]; nextCursor?: string }>,
  options: McpPaginationOptions = {}
): Promise<T[]> {
  const maxPages = mcpPositiveInteger(options.maxPages, 100);
  const maxItems = mcpPositiveInteger(options.maxItems, 10_000);
  return withMcpAbort(async signal => {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      signal.throwIfAborted();
      const result = await listPage(cursor, { abortSignal: signal, timeoutMs: options.timeoutMs });
      if (items.length + result.items.length > maxItems) throw new McpHttpError("LIMIT_EXCEEDED", "MCP pagination exceeded item limit.");
      items.push(...result.items);
      if (result.nextCursor === undefined) return items;
      if (seen.has(result.nextCursor)) throw new McpHttpError("PROTOCOL_ERROR", "MCP pagination repeated a cursor.");
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw new McpHttpError("LIMIT_EXCEEDED", "MCP pagination exceeded page limit.");
  }, [options.abortSignal], mcpPositiveInteger(options.timeoutMs, 30_000));
}
