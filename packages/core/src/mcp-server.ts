import { toJSONSchema, z, type ZodTypeAny } from "zod";

import { streamAgent } from "./agent/execution.js";
import { isCallableToolDefinition, isHostedToolDefinition } from "./messages.js";
import { createMergedAbortSignal } from "./runtime.js";
import type {
  AgentDefinition,
  AgentStreamEvent,
  JsonValue,
  LanguageModel,
  ToolDefinition,
  ToolExecutionContext,
  ToolSet
} from "./types.js";

/**
 * Experimental MCP server.
 *
 * JSON-RPC framing matches `@zhivex-ai/core/mcp-http` and `@zhivex-ai/core/mcp-stdio`.
 * `@modelcontextprotocol/sdk` stays a dev-only interop dependency and is not imported:
 * publishing it would ship Express, Hono, and the rest of its server stack inside core.
 */

/** Pinned handshake. Clients that cannot speak this revision must disconnect. */
export const MCP_SERVER_PROTOCOL_VERSION = "2025-11-25" as const;

/** Experimental exports of the opt-in MCP server entrypoint; separate from the root manifest. */
export const MCP_SERVER_API_STABILITY_MANIFEST = Object.freeze({
  MCP_SERVER_API_STABILITY_MANIFEST: "experimental",
  MCP_SERVER_PROTOCOL_VERSION: "experimental",
  McpServerError: "experimental",
  createMcpServer: "experimental",
  createMcpHttpServer: "experimental",
  createMcpStdioServer: "experimental"
} as const);

export type McpServerErrorCode =
  | "APPROVAL_REQUIRED"
  | "AUTH_REJECTED"
  | "AUTH_REQUIRED"
  | "LIMIT_EXCEEDED"
  | "PROTOCOL_ERROR"
  | "TIMEOUT"
  | "UNSUPPORTED_RUNTIME";

/** Machine-readable server failures. Messages never include tool arguments, credentials, or model output. */
export class McpServerError extends Error {
  readonly name = "McpServerError";

  constructor(readonly code: McpServerErrorCode, message: string) {
    super(message);
  }
}

export interface McpAgentTool {
  /** Agent instance or plain definition. Each call starts a fresh run. */
  agent: AgentDefinition | { toDefinition(): AgentDefinition };
  /** MCP tool name. Defaults to the agent name, then its id. */
  name?: string;
  description?: string;
  /**
   * Zod object schema advertised as JSON Schema.
   * Defaults to `{ prompt: string }`.
   */
  schema?: ZodTypeAny;
  /**
   * When true, the agent is not started. The call returns `APPROVAL_REQUIRED`.
   * This is separate from approval pauses that happen inside the run.
   */
  requiresApproval?: boolean;
  /** Maps validated arguments onto the agent run. Defaults to the `prompt` string field. */
  toRunInput?: (args: Readonly<Record<string, unknown>>) => {
    prompt: string;
    system?: string;
    maxSteps?: number | "unlimited";
  };
}

export interface McpServerOptions {
  name?: string;
  version?: string;
  /** Sent on `initialize` so MCP clients can show it to the model. */
  instructions?: string;
  /** Local callable tools. Hosted provider tools are rejected. */
  tools?: ToolSet;
  /** Each agent is advertised as one MCP tool. */
  agents?: Readonly<Record<string, McpAgentTool>>;
  /** Per-call limit for tool execution and agent runs. */
  timeoutMs?: number;
  /** Maximum serialized tool or agent result. Oversized results are withheld. */
  maxResultBytes?: number;
}

export interface McpServer {
  readonly name: string;
  readonly version: string;
  close(): void;
}

export type McpServerHttpAuth = (request: Request) => void | Promise<void>;

export interface McpHttpServerOptions {
  /**
   * Called before a body is executed. Throw `McpServerError` with
   * `AUTH_REQUIRED` (401) or `AUTH_REJECTED` (403). Any other throw is a 401
   * with a fixed message.
   */
  authenticate?: McpServerHttpAuth;
  timeoutMs?: number;
  /** POST body cap. Declared and observed sizes are both enforced. */
  maxRequestBytes?: number;
  /** Cap for a single HTTP response, including SSE progress frames. */
  maxResponseBytes?: number;
  /** Exact `Host` values. When set, other hosts are rejected with 403. */
  allowedHosts?: readonly string[];
  /**
   * Exact `Origin` values. When set, a missing or different origin is rejected
   * with 403. When omitted, a request that still carries `Origin` is rejected.
   * Non-browser clients that omit `Origin` are accepted.
   */
  allowedOrigins?: readonly string[];
  /** Retained `initialize` sessions. The oldest idle session is dropped at the cap. */
  maxSessions?: number;
  sessionId?: () => string;
}

export interface McpHttpServer {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export interface McpStdioServerOptions {
  server: McpServer;
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  /** Maximum size of one newline-delimited JSON-RPC message. */
  maxMessageBytes?: number;
}

export interface McpStdioServerSession {
  close(): Promise<void>;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
/** Node schedules a longer delay as 1 ms. Matches the signed 32-bit timer range. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_RESULT_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROGRESS_MESSAGE_LIMIT = 180;

interface JsonRpc {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface Session {
  phase: "new" | "accepted" | "ready";
  inflight: Map<string, AbortController>;
}

/** Numeric `1` and string `"1"` are different JSON-RPC ids and must not share a slot. */
const inflightKey = (id: string | number): string =>
  typeof id === "number" ? `n:${id}` : `s:${id}`;

const closedReason = () => new DOMException("MCP server is closed.", "AbortError");

interface RegisteredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint: false };
  meta: Record<string, unknown>;
  call(args: Record<string, unknown>, call: CallContext): Promise<ToolPayload>;
}

interface CallContext {
  signal: AbortSignal;
  timeoutMs: number;
  maxResultBytes: number;
  progressToken?: string | number;
  requestId: string | number;
  emitProgress(message: string): Promise<void>;
}

interface ToolPayload {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ServerState {
  name: string;
  version: string;
  instructions?: string;
  tools: RegisteredTool[];
  timeoutMs: number;
  maxResultBytes: number;
  closed: boolean;
  lifetime: AbortController;
}

const placeholderModel: LanguageModel = {
  provider: "mcp-server",
  modelId: "tool-context",
  capabilities: {
    streaming: false,
    tools: false,
    structuredOutput: false,
    jsonMode: false,
    toolChoice: false,
    parallelToolCalls: false,
    vision: false,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false
  },
  generate() {
    return Promise.reject(new McpServerError("PROTOCOL_ERROR", "MCP tool context does not call a model."));
  },
  stream() {
    return Promise.reject(new McpServerError("PROTOCOL_ERROR", "MCP tool context does not call a model."));
  }
};

const positive = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new McpServerError("PROTOCOL_ERROR", "MCP limits must be positive safe integers.");
  }
  return result;
};

const timeoutMsOf = (value: number | undefined, fallback: number): number => {
  const result = positive(value, fallback);
  if (result > MAX_TIMEOUT_MS) {
    throw new McpServerError("PROTOCOL_ERROR", "MCP timeout exceeds the timer range.");
  }
  return result;
};

const requireName = (value: string, label: string): string => {
  if (!TOOL_NAME.test(value)) {
    throw new McpServerError("PROTOCOL_ERROR", `Invalid MCP ${label}.`);
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonClone = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new McpServerError("PROTOCOL_ERROR", "MCP value is not JSON.");
  }
};

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const inputSchemaFor = (schema: ZodTypeAny): Record<string, unknown> => {
  let json: unknown;
  try {
    json = toJSONSchema(schema);
  } catch {
    throw new McpServerError("PROTOCOL_ERROR", "MCP tool schema could not be converted to JSON Schema.");
  }
  if (!isRecord(json) || json.type !== "object") {
    throw new McpServerError("PROTOCOL_ERROR", "MCP tool schemas must be Zod objects.");
  }
  const { $schema: _schema, ...rest } = json;
  return rest;
};

const toolError = (code: string, message: string, extra?: Record<string, unknown>): ToolPayload => ({
  isError: true,
  content: [{ type: "text", text: message }],
  structuredContent: { code, ...extra }
});

const agentDefinitionOf = (agent: McpAgentTool["agent"]): AgentDefinition => {
  const candidate = agent as { toDefinition?: () => AgentDefinition };
  return typeof candidate.toDefinition === "function" ? candidate.toDefinition() : agent as AgentDefinition;
};

const progressText = (event: AgentStreamEvent): string | undefined => {
  if (event.type === "text-delta") {
    const text = event.textDelta.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    return text.length > 0 ? text.slice(0, PROGRESS_MESSAGE_LIMIT) : undefined;
  }
  if (event.type === "tool-call") return `tool ${event.toolCall.name}`.slice(0, PROGRESS_MESSAGE_LIMIT);
  if (event.type === "agent-approval-request") return "approval required";
  return undefined;
};

const listedTool = (tool: RegisteredTool) => ({
  name: tool.name,
  ...(tool.description ? { description: tool.description } : {}),
  inputSchema: tool.inputSchema,
  ...(tool.annotations ? { annotations: tool.annotations } : {}),
  _meta: tool.meta
});

const registerTools = (options: McpServerOptions): RegisteredTool[] => {
  const registered: RegisteredTool[] = [];
  const seen = new Set<string>();
  const add = (tool: RegisteredTool) => {
    if (seen.has(tool.name)) {
      throw new McpServerError("PROTOCOL_ERROR", `Duplicate MCP tool "${tool.name}".`);
    }
    seen.add(tool.name);
    registered.push(tool);
  };

  for (const [key, definition] of Object.entries(options.tools ?? {})) {
    if (isHostedToolDefinition(definition)) {
      throw new McpServerError("PROTOCOL_ERROR", `Hosted tool "${key}" cannot be exposed over MCP.`);
    }
    if (!isCallableToolDefinition(definition)) {
      throw new McpServerError("PROTOCOL_ERROR", `Tool "${key}" is not callable.`);
    }
    add(callableTool(definition));
  }

  for (const [key, entry] of Object.entries(options.agents ?? {})) {
    add(agentTool(key, entry));
  }
  return registered;
};

const callableTool = (definition: ToolDefinition): RegisteredTool => {
  const name = requireName(definition.name, "tool name");
  const needsApproval = definition.requiresApproval === true;
  return {
    name,
    description: definition.description,
    inputSchema: inputSchemaFor(definition.schema),
    annotations: needsApproval ? { readOnlyHint: false } : undefined,
    meta: {
      "zhivex.ai/stability": "experimental",
      "zhivex.ai/kind": "tool",
      ...(needsApproval ? { "zhivex.ai/approval": definition.approvalMode ?? "policy" } : {})
    },
    call: (args, call) => executeTool(definition, args, call)
  };
};

const agentTool = (key: string, entry: McpAgentTool): RegisteredTool => {
  const definition = agentDefinitionOf(entry.agent);
  const name = requireName(entry.name ?? definition.name ?? definition.id ?? key, "agent tool name");
  const schema = entry.schema ?? z.object({
    prompt: z.string().min(1).describe("Instruction for this agent run.")
  });
  return {
    name,
    description: entry.description ?? definition.instructions,
    inputSchema: inputSchemaFor(schema),
    annotations: { readOnlyHint: false },
    meta: {
      "zhivex.ai/stability": "experimental",
      "zhivex.ai/kind": "agent",
      ...(entry.requiresApproval ? { "zhivex.ai/approval": "required" } : {})
    },
    call: (args, call) => executeAgent(name, entry, schema, args, call)
  };
};

const executionContext = (
  definition: ToolDefinition,
  input: JsonValue,
  call: CallContext
): ToolExecutionContext => ({
  abortSignal: call.signal,
  toolCall: { id: `mcp_${String(call.requestId)}`, name: definition.name, input },
  step: 0,
  model: placeholderModel
});

const executeTool = async (
  definition: ToolDefinition,
  args: Record<string, unknown>,
  call: CallContext
): Promise<ToolPayload> => {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return toolError("VALIDATION_ERROR", `Tool "${definition.name}" rejected its arguments.`, {
      issues: parsed.error.issues.slice(0, 20).map((issue: { code: string; path: ReadonlyArray<PropertyKey> }) => ({
        code: issue.code,
        path: issue.path.filter((segment): segment is string | number => typeof segment === "string" || typeof segment === "number")
      }))
    });
  }
  let input: JsonValue;
  try {
    input = jsonClone(parsed.data) as JsonValue;
  } catch {
    return toolError("VALIDATION_ERROR", `Tool "${definition.name}" rejected its arguments.`);
  }
  const context = executionContext(definition, input, call);
  const invoke = <T>(run: () => T | Promise<T>): Promise<T> => {
    const pending = Promise.resolve().then(run);
    pending.catch(() => undefined);
    return withDeadline(call, () => pending);
  };
  const failed = (error: unknown, started: boolean): ToolPayload => {
    if (error instanceof McpServerError && error.code === "TIMEOUT") {
      return toolError(
        "TIMEOUT",
        started
          ? `Tool "${definition.name}" timed out. Reconcile the effect before retrying.`
          : `Tool "${definition.name}" timed out.`
      );
    }
    if (call.signal.aborted) {
      return toolError(
        "CANCELLED",
        started
          ? `Tool "${definition.name}" was cancelled. Reconcile the effect before retrying.`
          : `Tool "${definition.name}" was cancelled.`
      );
    }
    return toolError("TOOL_FAILED", `Tool "${definition.name}" failed.`);
  };

  try {
    if (definition.isEnabled && !await invoke(() => definition.isEnabled!(parsed.data, context))) {
      return toolError("TOOL_DISABLED", `Tool "${definition.name}" is disabled.`);
    }
    for (const guardrail of definition.inputGuardrails ?? []) {
      const trigger = await invoke(() => guardrail({ tool: definition, input: parsed.data, context }));
      if (trigger?.triggered) {
        return toolError("GUARDRAIL", `Tool "${definition.name}" was rejected by an input guardrail.`);
      }
    }
  } catch (error) {
    return failed(error, false);
  }
  if (definition.requiresApproval === true) {
    return toolError(
      "APPROVAL_REQUIRED",
      `Tool "${definition.name}" requires approval and was not executed.`,
      { tool: definition.name, approvalMode: definition.approvalMode ?? "policy", executed: false }
    );
  }

  let output: unknown;
  try {
    output = await invoke(() => definition.execute(parsed.data, context));
  } catch (error) {
    return failed(error, true);
  }
  try {
    for (const guardrail of definition.outputGuardrails ?? []) {
      const trigger = await invoke(() => guardrail({
        tool: definition,
        input: parsed.data,
        output: output as JsonValue,
        context
      }));
      if (trigger?.triggered) {
        return toolError("GUARDRAIL", `Tool "${definition.name}" was rejected by an output guardrail.`);
      }
    }
  } catch (error) {
    return failed(error, true);
  }
  return successPayload(output, call.maxResultBytes, `Tool "${definition.name}" result exceeded the byte limit.`);
};

const executeAgent = async (
  name: string,
  entry: McpAgentTool,
  schema: ZodTypeAny,
  args: Record<string, unknown>,
  call: CallContext
): Promise<ToolPayload> => {
  if (entry.requiresApproval) {
    return toolError("APPROVAL_REQUIRED", `Agent "${name}" requires approval and was not started.`, {
      tool: name,
      approvalMode: "required",
      executed: false
    });
  }
  const parsed = schema.safeParse(args);
  let cloned: unknown;
  try {
    cloned = parsed.success ? jsonClone(parsed.data) : undefined;
  } catch {
    cloned = undefined;
  }
  if (!parsed.success || !isRecord(cloned)) {
    return toolError("VALIDATION_ERROR", `Agent "${name}" rejected its arguments.`);
  }
  const value = cloned;
  let mapped: { prompt: string; system?: string; maxSteps?: number | "unlimited" };
  try {
    const raw = entry.toRunInput
      ? entry.toRunInput(value)
      : { prompt: typeof value.prompt === "string" ? value.prompt : "" };
    if (!raw || typeof raw.prompt !== "string") {
      return toolError("VALIDATION_ERROR", `Agent "${name}" rejected its arguments.`);
    }
    mapped = raw;
  } catch {
    return toolError("AGENT_FAILED", `Agent "${name}" failed.`);
  }
  if (mapped.prompt.length === 0) {
    return toolError("VALIDATION_ERROR", `Agent "${name}" requires a prompt.`);
  }

  const definition = agentDefinitionOf(entry.agent);
  let streamed: ReturnType<typeof streamAgent>;
  try {
    streamed = streamAgent(definition, {
      prompt: mapped.prompt,
      ...(mapped.system !== undefined ? { system: mapped.system } : {}),
      ...(mapped.maxSteps !== undefined ? { maxSteps: mapped.maxSteps } : {}),
      abortSignal: call.signal,
      timeoutMs: call.timeoutMs
    });
  } catch {
    return toolError("AGENT_FAILED", `Agent "${name}" failed.`);
  }
  const consume = (async () => {
    for await (const event of streamed.eventStream) {
      const message = progressText(event);
      if (message) await call.emitProgress(message);
    }
  })();
  consume.catch(() => undefined);
  const failed = (error: unknown): ToolPayload => {
    if (error instanceof McpServerError && error.code === "TIMEOUT") {
      return toolError("TIMEOUT", `Agent "${name}" timed out. Reconcile the run before retrying.`);
    }
    if (call.signal.aborted) {
      return toolError("CANCELLED", `Agent "${name}" was cancelled.`);
    }
    return toolError("AGENT_FAILED", `Agent "${name}" failed.`);
  };
  let output: Awaited<ReturnType<typeof streamed.collect>>;
  const collected = streamed.collect();
  collected.catch(() => undefined);
  try {
    output = await withDeadline(call, () => collected);
    await withDeadline(call, () => consume);
  } catch (error) {
    return failed(error);
  }

  if (output.status === "waiting_approval") {
    return toolError("APPROVAL_REQUIRED", `Agent "${name}" is waiting for approval and was not resumed.`, {
      tool: name,
      status: output.status,
      runId: output.state.runId,
      executed: true,
      approvals: output.state.pendingApprovals.map((approval) => ({
        id: approval.id,
        name: approval.name,
        kind: approval.kind ?? "provider"
      }))
    });
  }
  if (output.status !== "completed") {
    return toolError("AGENT_FAILED", `Agent "${name}" finished with status ${output.status}.`, {
      status: output.status,
      runId: output.state.runId
    });
  }
  if (byteLength(output.outputText) > call.maxResultBytes) {
    return toolError("LIMIT_EXCEEDED", `Agent "${name}" result exceeded the byte limit.`, { runId: output.state.runId });
  }
  const payload = successPayload(
    { status: output.status, runId: output.state.runId, outputText: output.outputText },
    call.maxResultBytes,
    `Agent "${name}" result exceeded the byte limit.`
  );
  if (payload.isError) return payload;
  return { ...payload, content: [{ type: "text", text: output.outputText }] };
};

const successPayload = (value: unknown, maxResultBytes: number, limitMessage: string): ToolPayload => {
  let cloned: unknown;
  try {
    cloned = jsonClone(value);
  } catch {
    return toolError("TOOL_FAILED", "Tool result is not JSON.");
  }
  const text = JSON.stringify(cloned);
  if (byteLength(text) > maxResultBytes) {
    return toolError("LIMIT_EXCEEDED", limitMessage);
  }
  return {
    content: [{ type: "text", text }],
    ...(isRecord(cloned) ? { structuredContent: cloned } : {})
  };
};

const withDeadline = async <T>(call: CallContext, run: () => Promise<T>): Promise<T> => {
  if (call.signal.aborted) {
    throw call.signal.reason instanceof Error ? call.signal.reason : new McpServerError("TIMEOUT", "MCP operation timed out.");
  }
  return Promise.race([
    run(),
    new Promise<never>((_resolve, reject) => {
      const fail = () => reject(call.signal.reason instanceof Error
        ? call.signal.reason
        : new McpServerError("TIMEOUT", "MCP operation timed out."));
      call.signal.addEventListener("abort", fail, { once: true });
    })
  ]);
};

const rpcResult = (id: string | number, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });

const rpcError = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message }
});

const requestId = (value: unknown): string | number | undefined =>
  typeof value === "string" || (typeof value === "number" && Number.isInteger(value)) ? value : undefined;

const progressTokenOf = (params: unknown): string | number | undefined => {
  if (!isRecord(params) || !isRecord(params._meta)) return undefined;
  const token = params._meta.progressToken;
  if (typeof token === "string" && token.length > 0 && token.length <= 256) return token;
  if (typeof token === "number" && Number.isInteger(token)) return token;
  return undefined;
};

const handleMessage = async (
  state: ServerState,
  session: Session,
  message: unknown,
  emit: (message: unknown) => Promise<void>,
  signal: AbortSignal,
  timeoutMs = state.timeoutMs
): Promise<{ kind: "response"; message: unknown } | { kind: "accepted" }> => {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { kind: "response", message: rpcError(requestId(isRecord(message) ? message.id : undefined) ?? null, -32600, "Invalid MCP request.") };
  }
  const method = message.method;
  const id = requestId(message.id);
  if (id === undefined) {
    if (method === "notifications/cancelled") {
      const params = isRecord(message.params) ? message.params : undefined;
      const target = params ? requestId(params.requestId) : undefined;
      if (target !== undefined) {
        session.inflight.get(inflightKey(target))?.abort(new DOMException("MCP request was cancelled.", "AbortError"));
      }
    } else if (method === "notifications/initialized" && session.phase === "accepted") {
      session.phase = "ready";
    }
    return { kind: "accepted" };
  }
  if (state.closed || signal.aborted) {
    return { kind: "response", message: rpcError(id, -32603, "MCP server is closed.") };
  }
  if (method === "ping") return { kind: "response", message: rpcResult(id, {}) };
  if (method === "initialize") {
    if (session.phase !== "new") {
      return { kind: "response", message: rpcError(id, -32600, "MCP session is already initialized.") };
    }
    const params = isRecord(message.params) ? message.params : undefined;
    const client = params && isRecord(params.clientInfo) ? params.clientInfo : undefined;
    if (!params || typeof params.protocolVersion !== "string" || typeof client?.name !== "string" || typeof client.version !== "string") {
      return { kind: "response", message: rpcError(id, -32602, "Invalid MCP initialize params.") };
    }
    session.phase = "accepted";
    return {
      kind: "response",
      message: rpcResult(id, {
        protocolVersion: MCP_SERVER_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: state.name, version: state.version },
        ...(state.instructions ? { instructions: state.instructions } : {})
      })
    };
  }
  if (session.phase !== "ready") {
    return { kind: "response", message: rpcError(id, -32600, "MCP server is not initialized.") };
  }
  if (method === "tools/list") {
    if (isRecord(message.params) && message.params.cursor !== undefined) {
      return { kind: "response", message: rpcError(id, -32602, "MCP server does not paginate tools.") };
    }
    return { kind: "response", message: rpcResult(id, { tools: state.tools.map(listedTool) }) };
  }
  if (method === "tools/call") {
    const params = isRecord(message.params) ? message.params : undefined;
    const name = typeof params?.name === "string" ? params.name : undefined;
    const tool = name ? state.tools.find((entry) => entry.name === name) : undefined;
    if (!params || !name || !tool || (params.arguments !== undefined && !isRecord(params.arguments))) {
      return { kind: "response", message: rpcError(id, -32602, "Invalid MCP tools/call params.") };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new McpServerError("TIMEOUT", "MCP operation timed out.")), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    session.inflight.set(inflightKey(id), controller);
    const token = progressTokenOf(params);
    let progress = 0;
    try {
      const result = await tool.call(isRecord(params.arguments) ? params.arguments : {}, {
        signal: controller.signal,
        timeoutMs: state.timeoutMs,
        maxResultBytes: state.maxResultBytes,
        progressToken: token,
        requestId: id,
        emitProgress: async (text) => {
          if (token === undefined) return;
          progress += 1;
          await emit({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: token, progress, message: text }
          }).catch(() => undefined);
        }
      });
      return { kind: "response", message: rpcResult(id, result) };
    } finally {
      clearTimeout(timer);
      session.inflight.delete(inflightKey(id));
      signal.removeEventListener("abort", onAbort);
    }
  }
  return { kind: "response", message: rpcError(id, -32601, "MCP method not found.") };
};

/**
 * Experimental server that exposes Zhivex tools and agents to MCP clients.
 * Tools with `requiresApproval` are not executed. Agent runs that pause for
 * approval are not resumed.
 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const name = options.name ?? "zhivex";
  const version = options.version ?? "0.0.0-experimental";
  if (typeof name !== "string" || name.length === 0 || name.length > 128 || typeof version !== "string" || version.length === 0 || version.length > 128) {
    throw new McpServerError("PROTOCOL_ERROR", "Invalid MCP server info.");
  }
  const state: ServerState = {
    name,
    version,
    instructions: options.instructions,
    tools: registerTools(options),
    timeoutMs: timeoutMsOf(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxResultBytes: positive(options.maxResultBytes, DEFAULT_RESULT_BYTES),
    closed: false,
    lifetime: new AbortController()
  };
  const server = {
    name,
    version,
    close() {
      if (state.closed) return;
      state.closed = true;
      state.lifetime.abort(closedReason());
    }
  };
  sessions.set(server, state);
  return server;
}

const sessions = new WeakMap<McpServer, ServerState>();

const requireState = (server: McpServer): ServerState => {
  const state = sessions.get(server);
  if (!state) throw new McpServerError("PROTOCOL_ERROR", "Unknown MCP server.");
  return state;
};

const header = (request: Request, name: string): string | null => request.headers.get(name);

const originAllowed = (request: Request, options: McpHttpServerOptions): boolean => {
  if (options.allowedHosts) {
    const host = header(request, "host") ?? new URL(request.url).host;
    if (!options.allowedHosts.includes(host)) return false;
  }
  const origin = header(request, "origin");
  if (options.allowedOrigins) {
    if (!origin || !options.allowedOrigins.includes(origin)) return false;
  } else if (origin !== null) {
    return false;
  }
  return true;
};

const readLimited = async (request: Request, maxBytes: number): Promise<string> => {
  const declared = header(request, "content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new McpServerError("LIMIT_EXCEEDED", "MCP request exceeded byte limit.");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new McpServerError("LIMIT_EXCEEDED", "MCP request exceeded byte limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (error instanceof McpServerError) throw error;
    throw new McpServerError("PROTOCOL_ERROR", "Invalid MCP request body.");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

const jsonResponse = (status: number, body: unknown, extra?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(extra ?? {}) }
  });

const empty = (status: number, extra?: HeadersInit): Response => new Response(null, { status, headers: extra });

const authStatus = (error: unknown): Response => {
  if (error instanceof McpServerError && error.code === "AUTH_REJECTED") {
    return empty(403);
  }
  return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
};

/**
 * Streamable HTTP handler pinned to MCP 2025-11-25.
 * GET does not open a server-initiated SSE stream. Progress uses the POST response
 * when the client accepts `text/event-stream` and sends `_meta.progressToken`.
 */
export function createMcpHttpServer(server: McpServer, options: McpHttpServerOptions = {}): McpHttpServer {
  const state = requireState(server);
  const timeoutMs = timeoutMsOf(options.timeoutMs, state.timeoutMs);
  const maxSessions = positive(options.maxSessions, DEFAULT_MAX_SESSIONS);
  const maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_REQUEST_BYTES);
  const maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_RESPONSE_BYTES);
  const sessionsById = new Map<string, Session>();
  const lifetime = new AbortController();
  state.lifetime.signal.addEventListener("abort", () => lifetime.abort(state.lifetime.signal.reason), { once: true });

  const fetch = async (request: Request): Promise<Response> => {
    if (lifetime.signal.aborted || state.closed) return empty(503);
    if (!originAllowed(request, options)) return empty(403);
    const bound = async <T>(run: () => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new McpServerError("TIMEOUT", "MCP operation timed out.")), timeoutMs);
      const linked = createMergedAbortSignal(request.signal, lifetime.signal);
      const onAbort = () => controller.abort(linked.signal?.reason);
      if (linked.signal?.aborted) onAbort();
      else linked.signal?.addEventListener("abort", onAbort, { once: true });
      const pending = run();
      pending.catch(() => undefined);
      try {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new McpServerError("TIMEOUT", "MCP operation timed out.");
        }
        return await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            const fail = () => reject(controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new McpServerError("TIMEOUT", "MCP operation timed out."));
            controller.signal.addEventListener("abort", fail, { once: true });
          })
        ]);
      } finally {
        clearTimeout(timer);
        linked.cleanup();
        linked.signal?.removeEventListener("abort", onAbort);
      }
    };
    if (options.authenticate) {
      try {
        await bound(() => Promise.resolve(options.authenticate!(request)));
      } catch (error) {
        if (lifetime.signal.aborted || state.closed) return empty(503);
        if (error instanceof McpServerError && error.code === "TIMEOUT") return empty(408);
        if (request.signal.aborted) return empty(408);
        return authStatus(error);
      }
    }
    const method = request.method.toUpperCase();
    if (method === "GET") return empty(405, { Allow: "POST, DELETE" });
    if (method === "DELETE") {
      const id = header(request, "mcp-session-id");
      if (!id || !sessionsById.delete(id)) return empty(404);
      return empty(200);
    }
    if (method !== "POST") return empty(405, { Allow: "POST, DELETE" });
    const accept = header(request, "accept") ?? "";
    if (!accept.includes("application/json") && !accept.includes("text/event-stream")) return empty(406);
    const contentType = header(request, "content-type")?.split(";")[0]?.trim();
    if (contentType !== "application/json") return empty(415);
    const boundedJson = (status: number, body: unknown, extra?: HeadersInit): Response => {
      if (byteLength(JSON.stringify(body)) <= maxResponseBytes) return jsonResponse(status, body, extra);
      const id = isRecord(body) ? requestId(body.id) ?? null : null;
      const named = rpcError(id, -32603, "MCP response exceeded byte limit.");
      if (byteLength(JSON.stringify(named)) <= maxResponseBytes) return jsonResponse(status, named, extra);
      const anonymous = rpcError(null, -32603, "MCP response exceeded byte limit.");
      if (byteLength(JSON.stringify(anonymous)) <= maxResponseBytes) return jsonResponse(status, anonymous);
      return empty(status);
    };
    const protocol = header(request, "mcp-protocol-version");
    if (protocol !== null && protocol !== MCP_SERVER_PROTOCOL_VERSION) {
      return boundedJson(400, rpcError(null, -32600, "Unsupported MCP protocol version."));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await bound(() => readLimited(request, maxRequestBytes)));
    } catch (error) {
      await request.body?.cancel().catch(() => undefined);
      if (lifetime.signal.aborted || state.closed) return empty(503);
      if (error instanceof McpServerError && error.code === "TIMEOUT") return empty(408);
      if (request.signal.aborted) return empty(408);
      if (error instanceof McpServerError && error.code === "LIMIT_EXCEEDED") return empty(413);
      return boundedJson(400, rpcError(null, -32700, "Parse error."));
    }
    if (Array.isArray(payload)) return boundedJson(400, rpcError(null, -32600, "MCP batch requests are not supported."));

    const sessionHeader = header(request, "mcp-session-id");
    const existing = sessionHeader ? sessionsById.get(sessionHeader) : undefined;
    const incoming = isRecord(payload) ? payload : undefined;
    const isInitialize = incoming?.method === "initialize" && requestId(incoming.id) !== undefined;
    if (!isInitialize && !existing) return empty(404);
    const session = existing ?? { phase: "new" as const, inflight: new Map<string, AbortController>() };
    const streamProgress = !isInitialize && accept.includes("text/event-stream") && progressTokenOf(incoming?.params) !== undefined;
    const linked = createMergedAbortSignal(request.signal, lifetime.signal);
    const dispatch = (emit: (message: unknown) => Promise<void>) =>
      handleMessage(state, session, payload, emit, linked.signal ?? request.signal, timeoutMs)
        .finally(() => linked.cleanup());

    if (streamProgress) return sseResponse(maxResponseBytes, dispatch);

    const outcome = await dispatch(async () => undefined);
    if (outcome.kind === "accepted") return empty(202);
    if (
      isInitialize
      && isRecord(outcome.message)
      && "result" in outcome.message
      && byteLength(JSON.stringify(outcome.message)) <= maxResponseBytes
    ) {
      while (sessionsById.size >= maxSessions) {
        const idle = [...sessionsById.entries()].find(([, entry]) => entry.inflight.size === 0);
        if (!idle) return empty(503);
        sessionsById.delete(idle[0]);
      }
      const id = (options.sessionId ?? (() => crypto.randomUUID()))();
      sessionsById.set(id, session);
      return jsonResponse(200, outcome.message, { "Mcp-Session-Id": id });
    }
    return boundedJson(200, outcome.message);
  };

  return {
    fetch,
    async close() {
      lifetime.abort(closedReason());
      sessionsById.clear();
      server.close();
    }
  };
}

const sseResponse = (
  maxBytes: number,
  dispatch: (emit: (message: unknown) => Promise<void>) => Promise<{ kind: "response"; message: unknown } | { kind: "accepted" }>
): Response => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(control) {
      controller = control;
    }
  });
  let sent = 0;
  const limitFrame = encoder.encode(`event: message\ndata: ${JSON.stringify(rpcError(null, -32603, "MCP response exceeded byte limit."))}\n\n`);
  const emit = async (message: unknown) => {
    const bytes = encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    if (sent + bytes.byteLength > maxBytes) {
      throw new McpServerError("LIMIT_EXCEEDED", "MCP response exceeded byte limit.");
    }
    sent += bytes.byteLength;
    controller.enqueue(bytes);
  };
  const finish = () => {
    try {
      controller.close();
    } catch {
      /* The stream is already closed. */
    }
  };
  void dispatch(emit).then(async (outcome) => {
    if (outcome.kind === "response") {
      try {
        await emit(outcome.message);
      } catch {
        if (sent + limitFrame.byteLength <= maxBytes) controller.enqueue(limitFrame);
      }
    }
    finish();
  }).catch(() => {
    try {
      if (sent + limitFrame.byteLength <= maxBytes) controller.enqueue(limitFrame);
    } finally {
      finish();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
  });
};

/**
 * Newline-delimited JSON-RPC over web streams. Attach `process.stdin` and
 * `process.stdout` with `serveMcpStdio` from the Node entrypoint, or pass any
 * in-process byte streams.
 */
export function createMcpStdioServer(options: McpStdioServerOptions): McpStdioServerSession {
  const state = requireState(options.server);
  const maxMessageBytes = positive(options.maxMessageBytes, DEFAULT_RESPONSE_BYTES);
  const session: Session = { phase: "new", inflight: new Map() };
  const lifetime = new AbortController();
  state.lifetime.signal.addEventListener("abort", () => lifetime.abort(state.lifetime.signal.reason), { once: true });
  const encoder = new TextEncoder();
  const writer = options.output.getWriter();
  let writeChain: Promise<void> = Promise.resolve();
  const encodeLine = (message: unknown): Uint8Array => encoder.encode(`${JSON.stringify(message)}\n`);
  const failSession = async (reason: string) => {
    if (!lifetime.signal.aborted) lifetime.abort(new DOMException(reason, "AbortError"));
    await writer.close().catch(() => undefined);
  };
  const writeMessage = (message: unknown): Promise<void> => {
    writeChain = writeChain.then(async () => {
      if (lifetime.signal.aborted) return;
      const bytes = encodeLine(message);
      if (bytes.byteLength <= maxMessageBytes) {
        await writer.write(bytes);
        return;
      }
      const id = isRecord(message) ? requestId(message.id) ?? null : null;
      const fallback = encodeLine(rpcError(id, -32603, "MCP message exceeded byte limit."));
      if (fallback.byteLength <= maxMessageBytes) {
        await writer.write(fallback);
        return;
      }
      await failSession("MCP message exceeded byte limit.");
    }).catch(async () => {
      await failSession("MCP server failed.");
    });
    return writeChain;
  };

  const reader = options.input.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  const pump = (async () => {
    while (!lifetime.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        await failSession("MCP input closed.");
        break;
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      if (byteLength(buffered) > maxMessageBytes && !buffered.includes("\n")) {
        throw new McpServerError("LIMIT_EXCEEDED", "MCP message exceeded byte limit.");
      }
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (line.length === 0) continue;
        if (byteLength(line) > maxMessageBytes) {
          await writeMessage(rpcError(null, -32600, "MCP message exceeded byte limit."));
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          await writeMessage(rpcError(null, -32700, "Parse error."));
          continue;
        }
        if (isRecord(parsed) && parsed.method === "notifications/cancelled") {
          const params = isRecord(parsed.params) ? parsed.params : undefined;
          const target = params ? requestId(params.requestId) : undefined;
          if (target !== undefined) {
            session.inflight.get(inflightKey(target))?.abort(new DOMException("MCP request was cancelled.", "AbortError"));
          }
          continue;
        }
        const toolCall = isRecord(parsed) && parsed.method === "tools/call" && requestId(parsed.id) !== undefined;
        const task = handleMessage(state, session, parsed, writeMessage, lifetime.signal).then(async (outcome) => {
          if (outcome.kind === "response") await writeMessage(outcome.message);
        }).catch(async () => {
          await writeMessage(rpcError(requestId(isRecord(parsed) ? parsed.id : undefined) ?? null, -32603, "MCP server failed."));
        });
        if (!toolCall) await task;
      }
    }
  })().catch(() => {
    void failSession("MCP input failed.");
  });

  return {
    async close() {
      lifetime.abort(closedReason());
      await reader.cancel().catch(() => undefined);
      await pump.catch(() => undefined);
      try {
        await writer.close();
      } catch {
        writer.releaseLock();
      }
      options.server.close();
    }
  };
}
