export interface McpHttpAuthProvider {
  getAccessToken(input: { resource: string; abortSignal: AbortSignal }): Promise<string | undefined>;
}

/** Stable machine-readable failures; messages never contain remote bodies or credentials. */
export type McpHttpErrorCode = "AUTH_REQUIRED" | "AUTH_EXPIRED" | "AUTH_REJECTED" | "INDETERMINATE" | "PROTOCOL_ERROR" | "LIMIT_EXCEEDED" | "DESTINATION_REJECTED" | "UNSUPPORTED_CAPABILITY";
export interface McpAuthorizationChallenge { resourceMetadataUrl?: string; scope?: string; }
export class McpHttpError extends Error {
  readonly name = "McpHttpError";
  constructor(readonly code: McpHttpErrorCode, message: string, readonly authorization?: McpAuthorizationChallenge) { super(message); }
}
export type McpDestinationPurpose = "server" | "discovery" | "authorization" | "token";
/** Must enforce deployment-specific DNS/IP and tenant isolation in addition to URL policy. */
export type McpDestinationPolicy = (url: URL, purpose: McpDestinationPurpose) => boolean | Promise<boolean>;
export async function checkMcpDestination(url: string | URL, purpose: McpDestinationPurpose, policy?: McpDestinationPolicy): Promise<URL> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || (policy && !await policy(new URL(parsed), purpose))) {
    throw new McpHttpError("DESTINATION_REJECTED", "MCP destination rejected by policy.");
  }
  return parsed;
}
export function mcpPositiveInteger(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new McpHttpError("PROTOCOL_ERROR", "MCP limits must be positive safe integers.");
  return result;
}
export async function readMcpBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new McpHttpError("LIMIT_EXCEEDED", "MCP response exceeded byte limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function readMcpJson(response: Response, maxBytes: number): Promise<unknown> {
  try { return JSON.parse(await readMcpBody(response, maxBytes)); }
  catch (error) { if (error instanceof McpHttpError) throw error; throw new McpHttpError("PROTOCOL_ERROR", "Invalid MCP JSON response."); }
}
/** Node 18 compatible composition; listeners are removed on settlement. */
export async function withMcpAbort<T>(operation: (signal: AbortSignal) => Promise<T>, signals: Array<AbortSignal | undefined>, timeoutMs?: number): Promise<T> {
  const controller = new AbortController();
  const subscriptions: Array<[AbortSignal, () => void]> = [];
  for (const signal of signals) {
    if (!signal) continue;
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else { signal.addEventListener("abort", abort, { once: true }); subscriptions.push([signal, abort]); }
  }
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new DOMException("MCP operation timed out.", "TimeoutError")), timeoutMs);
  let abort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) controller.signal.removeEventListener("abort", abort);
    for (const [signal, listener] of subscriptions) signal.removeEventListener("abort", listener);
  }
}
