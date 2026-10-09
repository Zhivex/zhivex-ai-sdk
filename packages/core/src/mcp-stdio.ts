import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

import { z } from "zod";

import { withMcpAbort } from "./mcp-http-common.js";
import type { McpCallToolOptions, McpClient, McpServerCapabilities } from "./mcp.js";

/**
 * Experimental Node.js/Bun MCP stdio transport.
 *
 * JSON-RPC framing is implemented here, matching `@zhivex-ai/core/mcp-http`.
 * The official MCP SDK stays a dev-only interop dependency and is not imported.
 */

/** Pinned legacy handshake. Servers must answer `initialize` with this revision. */
export const MCP_STDIO_PROTOCOL_VERSION = "2025-11-25" as const;

/** Experimental exports of the opt-in MCP stdio entrypoint; separate from the root manifest. */
export const MCP_STDIO_API_STABILITY_MANIFEST = Object.freeze({
  MCP_STDIO_API_STABILITY_MANIFEST: "experimental",
  MCP_STDIO_PROTOCOL_VERSION: "experimental",
  McpStdioError: "experimental",
  createMcpStdioClient: "experimental"
} as const);

export type McpStdioErrorCode =
  | "INDETERMINATE"
  | "LIMIT_EXCEEDED"
  | "PROCESS_EXITED"
  | "PROTOCOL_ERROR"
  | "UNSUPPORTED_CAPABILITY";

/** Stable machine-readable failures for this entrypoint. Messages never include stderr or payloads. */
export class McpStdioError extends Error {
  readonly name = "McpStdioError";

  constructor(readonly code: McpStdioErrorCode, message: string) {
    super(message);
  }
}

export interface McpStdioClientOptions {
  /** Executable to spawn. Passed to `child_process.spawn` with `shell: false`. */
  command: string;
  args?: readonly string[];
  cwd?: string;
  /**
   * When set, replaces the parent environment. Omit to inherit `process.env`.
   * Undefined values are dropped.
   */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxMessageBytes?: number;
  /** Oldest stderr bytes are discarded once this tail length is exceeded. */
  maxStderrBytes?: number;
  /** Invoked for each stderr chunk. Failures from this callback are ignored. */
  onStderr?: (chunk: string) => void;
  clientInfo?: { name: string; version: string };
  /** Wait after closing stdin before SIGTERM, then again before SIGKILL. */
  shutdownGraceMs?: number;
}

export interface McpStdioClient extends McpClient {
  initialize(options?: McpCallToolOptions): Promise<McpServerCapabilities>;
  /** Closes stdin, then signals the child process group. Idempotent. */
  close(): Promise<void>;
  /** Bounded stderr tail. Stderr is logging, not protocol, and is not an error by itself. */
  stderr(): string;
}

const record = z.record(z.string(), z.unknown());
const page = { nextCursor: z.string().optional() };
const resource = z.object({
  uri: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional()
});
const listedTool = z.object({
  name: z.string(),
  inputSchema: record,
  description: z.string().optional()
}).passthrough();
const initializeResult = z.object({
  protocolVersion: z.literal(MCP_STDIO_PROTOCOL_VERSION),
  capabilities: z.object({
    tools: record.optional(),
    resources: record.optional(),
    prompts: record.optional()
  })
});
const toolResult = z.object({
  content: z.array(z.json()),
  structuredContent: z.record(z.string(), z.json()).optional(),
  isError: z.boolean().optional()
}).catchall(z.json());

const positive = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new McpStdioError("PROTOCOL_ERROR", "MCP limits must be positive safe integers.");
  }
  return result;
};

const requireText = (value: string, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new McpStdioError("PROTOCOL_ERROR", `Invalid MCP stdio ${label}.`);
  }
  return value;
};

const indeterminate = () =>
  new McpStdioError("INDETERMINATE", "MCP tool execution may have occurred; reconcile before retrying.");

type Pending = {
  method: string;
  dispatched: boolean;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Opt-in stdio client pinned to MCP 2025-11-25 newline-delimited JSON-RPC.
 * The process starts on the first request. Never retries a request.
 */
export function createMcpStdioClient(options: McpStdioClientOptions): McpStdioClient {
  const command = requireText(options.command, "command");
  const args = (options.args ?? []).map((arg, index) => requireText(arg, `args[${index}]`));
  if (options.cwd !== undefined) requireText(options.cwd, "cwd");
  const clientInfo = options.clientInfo ?? { name: "zhivex-ai", version: "1" };
  requireText(clientInfo.name, "clientInfo.name");
  requireText(clientInfo.version, "clientInfo.version");
  const timeoutMs = positive(options.timeoutMs, 30_000);
  const maxMessageBytes = positive(options.maxMessageBytes, 4 * 1024 * 1024);
  const maxStderrBytes = positive(options.maxStderrBytes, 64 * 1024);
  const shutdownGraceMs = positive(options.shutdownGraceMs, 2_000);
  const childEnv = options.env
    ? Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    : undefined;

  const lifetime = new AbortController();
  let child: ChildProcess | undefined;
  let capabilities: McpServerCapabilities | undefined;
  let initializing: Promise<McpServerCapabilities> | undefined;
  let nextId = 0;
  let transportError: McpStdioError | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let writeQueue: Promise<void> = Promise.resolve();
  let stdoutBuffer = Buffer.alloc(0);
  const pending = new Map<number, Pending>();
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  const stderrDecoder = new TextDecoder("utf-8", { fatal: false });

  const rememberStderr = (chunk: Buffer): void => {
    stderrChunks.push(chunk);
    stderrBytes += chunk.byteLength;
    while (stderrBytes > maxStderrBytes && stderrChunks.length > 1) {
      const removed = stderrChunks.shift();
      if (!removed) break;
      stderrBytes -= removed.byteLength;
    }
    const only = stderrChunks[0];
    if (only && stderrBytes > maxStderrBytes) {
      stderrChunks[0] = only.subarray(only.byteLength - maxStderrBytes);
      stderrBytes = stderrChunks[0].byteLength;
    }
  };

  const rejectPending = (error: McpStdioError): void => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      if (waiter.settled) continue;
      waiter.reject(waiter.dispatched && waiter.method === "tools/call" ? indeterminate() : error);
    }
  };

  const failTransport = (error: McpStdioError): void => {
    if (transportError) return;
    transportError = error;
    rejectPending(error);
    void close();
  };

  const encodeLine = (message: unknown): Buffer => {
    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch {
      throw new McpStdioError("PROTOCOL_ERROR", "MCP transport failed.");
    }
    if (payload.includes("\n") || payload.includes("\r")) {
      throw new McpStdioError("PROTOCOL_ERROR", "MCP stdio message must be a single line.");
    }
    const line = Buffer.from(`${payload}\n`, "utf8");
    if (line.byteLength > maxMessageBytes) {
      throw new McpStdioError("LIMIT_EXCEEDED", "MCP request exceeded byte limit.");
    }
    return line;
  };

  const writeEncoded = (line: Buffer): Promise<void> => {
    const run = writeQueue.then(() => new Promise<void>((resolve, reject) => {
      const proc = child;
      if (transportError || !proc?.stdin?.writable) {
        reject(transportError ?? new McpStdioError("PROCESS_EXITED", "MCP stdio process is not accepting input."));
        return;
      }
      proc.stdin.write(line, (error) => {
        if (error) reject(new McpStdioError("PROCESS_EXITED", "MCP stdio process is not accepting input."));
        else resolve();
      });
    }));
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  const writeLine = (message: unknown): Promise<void> => writeEncoded(encodeLine(message));

  const handleMessage = (message: unknown): void => {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      failTransport(new McpStdioError("PROTOCOL_ERROR", "Invalid MCP response envelope."));
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        const response = message.method === "ping"
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client capability not supported." } };
        void writeLine(response).catch(() => undefined);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter || waiter.settled) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiter.reject(new McpStdioError("PROTOCOL_ERROR", "MCP server returned a JSON-RPC error."));
    else if (!("result" in message)) waiter.reject(new McpStdioError("PROTOCOL_ERROR", "Missing MCP response result."));
    else waiter.resolve(message.result);
  };

  const onStdout = (chunk: Buffer): void => {
    if (transportError) return;
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (!transportError) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline === -1) {
        if (stdoutBuffer.byteLength > maxMessageBytes) {
          stdoutBuffer = Buffer.alloc(0);
          failTransport(new McpStdioError("LIMIT_EXCEEDED", "MCP response exceeded byte limit."));
        }
        return;
      }
      let line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) line = line.subarray(0, line.byteLength - 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength > maxMessageBytes) {
        stdoutBuffer = Buffer.alloc(0);
        failTransport(new McpStdioError("LIMIT_EXCEEDED", "MCP response exceeded byte limit."));
        return;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      } catch {
        failTransport(new McpStdioError("PROTOCOL_ERROR", "Invalid MCP response encoding."));
        return;
      }
      try {
        handleMessage(JSON.parse(text) as unknown);
      } catch (error) {
        if (error instanceof McpStdioError) return;
        failTransport(new McpStdioError("PROTOCOL_ERROR", "Invalid MCP JSON response."));
        return;
      }
    }
  };

  const onStderr = (chunk: Buffer): void => {
    rememberStderr(chunk);
    if (!options.onStderr) return;
    try {
      options.onStderr(stderrDecoder.decode(chunk, { stream: true }));
    } catch {
      // Host log sinks must not take down the protocol reader.
    }
  };

  const ensureProcess = (): ChildProcess => {
    if (closing) throw new McpStdioError("PROCESS_EXITED", "MCP stdio client is closed.");
    if (transportError) throw transportError;
    if (child) return child;
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
      // New session so close() can signal npx/node grandchildren on POSIX.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    child = proc;
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.stdin?.on("error", () => undefined);
    proc.stdout?.on("error", () => failTransport(new McpStdioError("PROCESS_EXITED", "MCP stdio process exited.")));
    proc.stderr?.on("error", () => undefined);
    proc.on("error", () => failTransport(new McpStdioError("PROCESS_EXITED", "MCP stdio process failed to start.")));
    proc.on("exit", () => {
      if (!closing) failTransport(new McpStdioError("PROCESS_EXITED", "MCP stdio process exited."));
    });
    return proc;
  };

  const signalChild = (signal: NodeJS.Signals): void => {
    const proc = child;
    if (!proc?.pid) return;
    try {
      if (process.platform === "win32") proc.kill(signal);
      else process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // The process group has already exited.
      }
    }
  };

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    lifetime.abort(new DOMException("MCP stdio client closed.", "AbortError"));
    rejectPending(new McpStdioError("PROCESS_EXITED", "MCP stdio client is closed."));
    capabilities = undefined;
    initializing = undefined;
    closePromise = (async () => {
      const proc = child;
      if (!proc) return;
      const waitForExit = async (): Promise<boolean> => {
        if (proc.exitCode !== null || proc.signalCode !== null) return true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), shutdownGraceMs);
        });
        const didExit = await Promise.race([once(proc, "exit").then(() => true), timeout]);
        if (timer) clearTimeout(timer);
        return didExit || proc.exitCode !== null || proc.signalCode !== null;
      };
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.stdin?.end();
      if (await waitForExit()) return;
      signalChild("SIGTERM");
      if (await waitForExit()) return;
      signalChild("SIGKILL");
      if (proc.exitCode === null && proc.signalCode === null) await once(proc, "exit");
    })();
    return closePromise;
  }

  async function post(method: string, params: unknown, call: McpCallToolOptions = {}, notification = false): Promise<unknown> {
    let dispatched = false;
    return withMcpAbort(async (signal) => {
      signal.throwIfAborted();
      if (closing) throw new McpStdioError("PROCESS_EXITED", "MCP stdio client is closed.");
      if (transportError) throw transportError;
      ensureProcess();
      if (notification) {
        await writeLine({ jsonrpc: "2.0", method, params: params ?? {} });
        signal.throwIfAborted();
        return {};
      }
      const id = ++nextId;
      return await new Promise<unknown>((resolve, reject) => {
        const waiter: Pending = {
          method,
          dispatched: false,
          settled: false,
          resolve: (value) => {
            if (waiter.settled) return;
            waiter.settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            if (waiter.settled) return;
            waiter.settled = true;
            signal.removeEventListener("abort", onAbort);
            reject(error);
          }
        };
        const onAbort = (): void => {
          if (waiter.settled) return;
          pending.delete(id);
          if (dispatched) {
            void writeLine({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id, reason: "cancelled" }
            }).catch(() => undefined);
          }
          waiter.reject(dispatched && method === "tools/call" ? indeterminate() : signal.reason);
        };
        pending.set(id, waiter);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        let line: Buffer;
        try {
          line = encodeLine({ jsonrpc: "2.0", id, method, params: params ?? {} });
        } catch (error) {
          waiter.reject(error instanceof McpStdioError ? error : new McpStdioError("PROTOCOL_ERROR", "MCP transport failed."));
          return;
        }
        dispatched = true;
        waiter.dispatched = true;
        void writeEncoded(line).then(() => {
          if (signal.aborted) onAbort();
        }, (error: unknown) => {
          pending.delete(id);
          if (method === "tools/call") waiter.reject(indeterminate());
          else if (error instanceof McpStdioError) waiter.reject(error);
          else if (signal.aborted) waiter.reject(signal.reason);
          else waiter.reject(new McpStdioError("PROTOCOL_ERROR", "MCP transport failed."));
        });
      });
    }, [lifetime.signal, call.abortSignal], positive(call.timeoutMs, timeoutMs)).catch((error: unknown) => {
      if (error instanceof McpStdioError) throw error;
      if (dispatched && method === "tools/call") throw indeterminate();
      if (lifetime.signal.aborted) {
        throw transportError ?? new McpStdioError("PROCESS_EXITED", "MCP stdio client is closed.");
      }
      throw error;
    });
  }

  async function initialize(call: McpCallToolOptions = {}): Promise<McpServerCapabilities> {
    if (closing || lifetime.signal.aborted) {
      throw transportError ?? new McpStdioError("PROCESS_EXITED", "MCP stdio client is closed.");
    }
    call.abortSignal?.throwIfAborted();
    if (capabilities) return structuredClone(capabilities);
    if (!initializing) {
      initializing = (async () => {
        const parsed = initializeResult.safeParse(await post("initialize", {
          protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo
        }, call));
        if (!parsed.success) throw new McpStdioError("PROTOCOL_ERROR", "Unsupported MCP initialization result.");
        await post("notifications/initialized", {}, call, true);
        capabilities = parsed.data.capabilities as McpServerCapabilities;
        return capabilities;
      })().catch(async (error: unknown) => {
        initializing = undefined;
        capabilities = undefined;
        await close();
        throw error;
      });
    }
    return structuredClone(await initializing);
  }

  async function invoke(method: string, params: unknown, call?: McpCallToolOptions): Promise<unknown> {
    const caps = await initialize(call);
    const capability = method.split("/")[0] as keyof McpServerCapabilities;
    if (!caps[capability]) throw new McpStdioError("UNSUPPORTED_CAPABILITY", "MCP server does not advertise this capability.");
    return post(method, params ?? {}, call);
  }

  async function validated<T>(schema: z.ZodType<T>, method: string, params: unknown, call?: McpCallToolOptions): Promise<T> {
    const parsed = schema.safeParse(await invoke(method, params, call));
    if (!parsed.success) throw new McpStdioError("PROTOCOL_ERROR", "Invalid MCP result shape.");
    return parsed.data;
  }

  return {
    get capabilities() {
      return capabilities ? structuredClone(capabilities) : undefined;
    },
    initialize,
    close,
    stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    listTools: (input, call) => validated(
      z.object({ tools: z.array(listedTool), ...page }),
      "tools/list",
      input,
      call
    ) as ReturnType<McpClient["listTools"]>,
    callTool: async (input, call) => {
      const parsed = toolResult.safeParse(await invoke("tools/call", input, call));
      if (!parsed.success) throw indeterminate();
      return parsed.data;
    },
    listResources: (input, call) => validated(
      z.object({ resources: z.array(resource), ...page }),
      "resources/list",
      input,
      call
    ),
    listResourceTemplates: (input, call) => validated(
      z.object({
        resourceTemplates: z.array(resource.omit({ uri: true }).extend({ uriTemplate: z.string() })),
        ...page
      }),
      "resources/templates/list",
      input,
      call
    ),
    readResource: (input, call) => validated(
      z.object({
        contents: z.array(z.union([
          z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string() }),
          z.object({ uri: z.string(), mimeType: z.string().optional(), blob: z.string() })
        ]))
      }),
      "resources/read",
      input,
      call
    ),
    listPrompts: (input, call) => validated(
      z.object({
        prompts: z.array(z.object({
          name: z.string(),
          description: z.string().optional(),
          arguments: z.array(z.object({
            name: z.string(),
            description: z.string().optional(),
            required: z.boolean().optional()
          })).optional()
        })),
        ...page
      }),
      "prompts/list",
      input,
      call
    ),
    getPrompt: (input, call) => validated(
      z.object({
        description: z.string().optional(),
        messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.json() }))
      }),
      "prompts/get",
      input,
      call
    )
  };
}
