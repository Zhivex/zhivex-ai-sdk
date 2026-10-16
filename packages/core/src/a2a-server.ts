import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ConflictError } from "./errors.js";
import {
  createRunner,
  type AgentSession,
  type SessionService
} from "./runner.js";
import {
  A2A_TASK_INDEX_SESSION_ID,
  A2aProtocolError,
  canonicalA2aMethod,
  createA2aAgentCard,
  createA2aId,
  httpStatusForA2aCode,
  isA2aIdentifier,
  isTerminalA2aState,
  supportedA2aVersion,
  type A2aAgentCard,
  type A2aAgentSkill,
  type A2aMessage,
  type A2aPart,
  type A2aStreamResponse,
  type A2aTask,
  type A2aTaskState,
  type CreateA2aAgentCardInput
} from "./a2a-protocol.js";
import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentDefinition,
  AgentRunOutput,
  AgentStatus,
  JsonValue,
  LanguageModel
} from "./types.js";

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const MAX_HISTORY = 32;
const INT32_MAX = 2_147_483_647;
const MAX_TASKS = 100;
const MAX_STORED_TEXT = 256 * 1024;
const INDEX_TASKS = "a2aTaskIndex";
const INDEX_MESSAGES = "a2aMessageIndex";
const INDEX_LATEST = "a2aLatestTask";
const CONTEXT_TASKS = "a2aTasks";

export interface A2aAuthResult {
  userId: string;
}

export interface A2aAgentCardOptions extends Omit<CreateA2aAgentCardInput, "url"> {
  skills?: A2aAgentSkill[];
}

export interface CreateA2aAgentServerOptions<TModel extends LanguageModel = LanguageModel> {
  appName: string;
  agent: AgentDefinition<TModel>;
  sessionService: SessionService;
  card: A2aAgentCardOptions;
  /**
   * Application-owned authentication. Return a user id or `undefined` to reject.
   * The Agent Card stays public. JSON-RPC methods require this hook when it is set.
   */
  authenticate?: (request: IncomingMessage) => A2aAuthResult | undefined | Promise<A2aAuthResult | undefined>;
  /** Single-tenant user id used only when `authenticate` is omitted. Bind stays loopback by default. */
  userId?: string;
  host?: string;
  port?: number;
  rpcPath?: string;
  maxRequestBytes?: number;
  /** Origin advertised on the Agent Card. Defaults to the bound loopback URL. */
  publicBaseUrl?: string;
}

export interface A2aAgentServer {
  url: string;
  cardUrl: string;
  rpcUrl: string;
  card: A2aAgentCard;
  close(): Promise<void>;
}

interface StoredTask {
  task: A2aTask;
  messageIds: string[];
}

interface Flight {
  abort: AbortController;
  done: Promise<void>;
  finish: () => void;
  userId: string;
}

interface RpcRequest {
  id: string | number | null;
  method: string;
  params: Record<string, unknown>;
}

/**
 * Serves one Zhivex agent over the A2A 1.0 JSON-RPC binding.
 * `contextId` is the Runner session id and `taskId` is the agent run id.
 * Both are stored in the supplied SessionService, so a restarted process can
 * `GetTask` and resume an approval wait.
 */
export const createA2aAgentServer = async <TModel extends LanguageModel>(
  options: CreateA2aAgentServerOptions<TModel>
): Promise<A2aAgentServer> => {
  if (typeof options.appName !== "string" || options.appName.length === 0 || options.appName.length > 200 || /[\u0000-\u001f]/.test(options.appName)) {
    throw new A2aProtocolError("INVALID_PARAMS", "A2A app name is invalid.");
  }
  if (!options.authenticate && !options.userId) {
    throw new A2aProtocolError("INVALID_PARAMS", "A2A server requires authenticate or userId.");
  }
  if (options.userId !== undefined && !isA2aIdentifier(options.userId)) {
    throw new A2aProtocolError("INVALID_PARAMS", "A2A user id is invalid.");
  }
  const maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES);
  const rpcPath = options.rpcPath ?? "/rpc";
  if (!/^\/[A-Za-z0-9._~/-]{1,200}$/.test(rpcPath) || rpcPath === "/.well-known/agent-card.json") {
    throw new A2aProtocolError("INVALID_PARAMS", "A2A RPC path is invalid.");
  }
  const host = options.host ?? "127.0.0.1";
  const runner = createRunner({
    appName: options.appName,
    agent: options.agent,
    sessionService: options.sessionService
  });
  const tails = new Map<string, Promise<unknown>>();
  const inflight = new Map<string, Flight>();
  let card: A2aAgentCard | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const withUserLock = async <T>(userId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    tails.set(userId, run);
    try {
      return await run;
    } finally {
      if (tails.get(userId) === run) tails.delete(userId);
    }
  };

  const lookup = (userId: string, sessionId: string) => ({
    appName: options.appName,
    userId,
    sessionId
  });

  const load = async (userId: string, sessionId: string): Promise<AgentSession | undefined> =>
    options.sessionService.loadSession(lookup(userId, sessionId));

  const ensure = async (userId: string, sessionId: string, metadata?: Record<string, JsonValue>): Promise<AgentSession> => {
    const existing = await load(userId, sessionId);
    if (existing) return existing;
    return options.sessionService.createSession({ ...lookup(userId, sessionId), metadata });
  };

  const save = async (userId: string, session: AgentSession, mutate: (metadata: Record<string, JsonValue>) => void): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await load(userId, session.sessionId);
      if (!current) throw new A2aProtocolError("INTERNAL", "Internal error.");
      const metadata: Record<string, JsonValue> = { ...(current.metadata ?? {}) };
      mutate(metadata);
      try {
        await options.sessionService.saveSession({ ...current, metadata }, { expectedRevision: current.revision });
        return;
      } catch (error) {
        if (error instanceof A2aProtocolError) throw error;
        if (!(error instanceof ConflictError) || attempt === 4) {
          throw new A2aProtocolError("INTERNAL", "Internal error.");
        }
      }
    }
  };

  const readIndex = async (userId: string) => {
    const session = await ensure(userId, A2A_TASK_INDEX_SESSION_ID, {});
    return {
      tasks: stringMap(session.metadata, INDEX_TASKS),
      messages: stringMap(session.metadata, INDEX_MESSAGES),
      latest: stringMap(session.metadata, INDEX_LATEST)
    };
  };

  const writeIndex = async (
    userId: string,
    index: { tasks: Record<string, string>; messages: Record<string, string>; latest: Record<string, string> }
  ) => {
    const session = await ensure(userId, A2A_TASK_INDEX_SESSION_ID, {});
    await save(userId, session, (metadata) => {
      metadata[INDEX_TASKS] = index.tasks;
      metadata[INDEX_MESSAGES] = index.messages;
      metadata[INDEX_LATEST] = index.latest;
    });
  };

  const readStored = async (userId: string, contextId: string, taskId: string): Promise<StoredTask | undefined> => {
    const session = await load(userId, contextId);
    const tasks = recordMap(session?.metadata, CONTEXT_TASKS);
    const stored = tasks[taskId];
    if (!isRecord(stored) || !isRecord(stored.task)) return undefined;
    const messageIds = Array.isArray(stored.messageIds) ? stored.messageIds.filter((id): id is string => typeof id === "string") : [];
    return { task: stored.task as unknown as A2aTask, messageIds };
  };

  const writeStored = async (userId: string, stored: StoredTask) => {
    const contextId = stored.task.contextId;
    await ensure(userId, contextId, { a2aContextId: contextId });
    const session = await load(userId, contextId);
    if (!session) throw new A2aProtocolError("INTERNAL", "Internal error.");
    await save(userId, session, (metadata) => {
      const tasks = recordMap(metadata, CONTEXT_TASKS);
      tasks[stored.task.id] = JSON.parse(JSON.stringify(stored)) as JsonValue;
      metadata[CONTEXT_TASKS] = tasks;
      metadata.a2aContextId = contextId;
    });
  };

  const remember = async (userId: string, stored: StoredTask) => {
    const index = await readIndex(userId);
    if (!index.tasks[stored.task.id] && Object.keys(index.tasks).length >= MAX_TASKS) {
      throw new A2aProtocolError("LIMIT_EXCEEDED", "A2A task limit exceeded.");
    }
    index.tasks[stored.task.id] = stored.task.contextId;
    index.latest[stored.task.contextId] = stored.task.id;
    for (const messageId of stored.messageIds) index.messages[messageId] = stored.task.id;
    await writeIndex(userId, index);
    await writeStored(userId, stored);
  };

  const taskForUser = async (userId: string, taskId: string): Promise<StoredTask> => {
    if (!isA2aIdentifier(taskId)) throw new A2aProtocolError("TASK_NOT_FOUND", "Task not found.");
    const index = await readIndex(userId);
    const contextId = index.tasks[taskId];
    if (!contextId) throw new A2aProtocolError("TASK_NOT_FOUND", "Task not found.");
    const stored = await readStored(userId, contextId, taskId);
    if (!stored) throw new A2aProtocolError("TASK_NOT_FOUND", "Task not found.");
    return stored;
  };

  const present = (task: A2aTask, historyLength: number | undefined): A2aTask => {
    if (historyLength === undefined) return task;
    const history = historyLength === 0 ? [] : (task.history ?? []).slice(-historyLength);
    return { ...task, history };
  };

  const execute = async (
    userId: string,
    params: Record<string, unknown>,
    emit: ((event: A2aStreamResponse) => void) | undefined,
    requestAbort: AbortSignal
  ): Promise<A2aTask> => withUserLock(userId, async () => {
    const parsed = parseSend(params);
    const index = await readIndex(userId);
    if (closed) throw new A2aProtocolError("INTERNAL", "Internal error.");
    const existingId = index.messages[parsed.message.messageId];
    if (existingId) {
      const stored = await taskForUser(userId, existingId);
      const task = present(stored.task, parsed.historyLength);
      if (emit) emit({ task });
      return task;
    }
    if (parsed.message.taskId) {
      const stored = await taskForUser(userId, parsed.message.taskId);
      if (parsed.message.contextId && parsed.message.contextId !== stored.task.contextId) {
        throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
      }
      if (isTerminalA2aState(stored.task.status.state)) {
        throw new A2aProtocolError("UNSUPPORTED_OPERATION", "The task is already in a terminal state.");
      }
      if (stored.task.status.state !== "TASK_STATE_INPUT_REQUIRED") {
        throw new A2aProtocolError("UNSUPPORTED_OPERATION", "The task is not waiting for input.");
      }
      if (!parsed.approvals) {
        const task = present(stored.task, parsed.historyLength);
        if (emit) emit({ task });
        return task;
      }
      return runExisting(userId, stored, parsed, emit, requestAbort);
    }
    const contextId = parsed.message.contextId ?? createA2aId("ctx");
    if (!isA2aIdentifier(contextId) || contextId === A2A_TASK_INDEX_SESSION_ID) {
      throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
    }
    const latestId = index.latest[contextId];
    if (latestId) {
      const latest = await readStored(userId, contextId, latestId);
      if (latest?.task.status.state === "TASK_STATE_INPUT_REQUIRED" || latest?.task.status.state === "TASK_STATE_WORKING") {
        throw new A2aProtocolError("UNSUPPORTED_OPERATION", "The context already has an open task.");
      }
    }
    if (parsed.approvals || !parsed.prompt) throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
    const taskId = createA2aId("task");
    const history = [stamp(parsed.message, contextId, taskId)].slice(-MAX_HISTORY);
    const working = baseTask(taskId, contextId, "TASK_STATE_WORKING", history);
    const stored: StoredTask = { task: working, messageIds: [parsed.message.messageId] };
    await remember(userId, stored);
    if (emit) emit({ task: working });
    const finished = await finishRun(userId, stored, parsed.prompt, undefined, emit, requestAbort);
    return present(finished, parsed.historyLength);
  });

  const runExisting = async (
    userId: string,
    stored: StoredTask,
    parsed: ParsedSend,
    emit: ((event: A2aStreamResponse) => void) | undefined,
    requestAbort: AbortSignal
  ): Promise<A2aTask> => {
    const session = await load(userId, stored.task.contextId);
    const pending = session?.lastRunState?.pendingApprovals ?? [];
    const approvals = resolveApprovals(parsed.approvals ?? [], pending);
    const history = [...(stored.task.history ?? []), stamp(parsed.message, stored.task.contextId, stored.task.id)].slice(-MAX_HISTORY);
    const working = baseTask(stored.task.id, stored.task.contextId, "TASK_STATE_WORKING", history);
    const next: StoredTask = { task: working, messageIds: [...stored.messageIds, parsed.message.messageId] };
    await remember(userId, next);
    if (emit) emit({ task: working });
    const finished = await finishRun(userId, next, undefined, approvals, emit, requestAbort);
    return present(finished, parsed.historyLength);
  };

  const finishRun = async (
    userId: string,
    stored: StoredTask,
    prompt: string | undefined,
    approvals: AgentApprovalResponse[] | undefined,
    emit: ((event: A2aStreamResponse) => void) | undefined,
    requestAbort: AbortSignal
  ): Promise<A2aTask> => {
    const abort = new AbortController();
    const onRequestAbort = () => abort.abort();
    if (requestAbort.aborted) abort.abort();
    else requestAbort.addEventListener("abort", onRequestAbort, { once: true });
    let finish = () => undefined as void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    inflight.set(stored.task.id, { abort, done, finish, userId });
    let text = "";
    let pendingChunk: string | undefined;
    const artifactId = createA2aId("artifact");
    const emitChunk = (chunk: string, lastChunk: boolean) => {
      emit?.({
        artifactUpdate: {
          taskId: stored.task.id,
          contextId: stored.task.contextId,
          append: true,
          ...(lastChunk ? { lastChunk: true } : {}),
          artifact: { artifactId, parts: [{ text: chunk }] }
        }
      });
    };
    try {
      const input = {
        userId,
        sessionId: stored.task.contextId,
        runId: approvals ? undefined : stored.task.id,
        prompt,
        approvals,
        abortSignal: abort.signal,
        eventMetadata: { a2aTaskId: stored.task.id }
      };
      if (emit) {
        const stream = runner.stream(input);
        const collected = stream.collect();
        for await (const chunk of stream.textStream) {
          if (pendingChunk !== undefined) emitChunk(pendingChunk, false);
          pendingChunk = chunk;
          text += chunk;
          if (text.length > MAX_STORED_TEXT) throw new A2aProtocolError("LIMIT_EXCEEDED", "A2A response exceeded byte limit.");
        }
        if (pendingChunk !== undefined) emitChunk(pendingChunk, true);
        const output = await collected;
        const task = await settle(userId, stored, output.output, abort.signal.aborted, text);
        emit({ statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } });
        return task;
      }
      const output = await runner.run(input);
      return settle(userId, stored, output.output, abort.signal.aborted, output.output.outputText);
    } catch (error) {
      const task = abortedOrFailed(stored, abort.signal.aborted);
      await remember(userId, { ...stored, task });
      if (emit) emit({ statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } });
      if (error instanceof A2aProtocolError && error.code === "LIMIT_EXCEEDED") throw error;
      return task;
    } finally {
      requestAbort.removeEventListener("abort", onRequestAbort);
      inflight.delete(stored.task.id);
      finish();
    }
  };

  const settle = async (
    userId: string,
    stored: StoredTask,
    output: AgentRunOutput,
    aborted: boolean,
    streamedText: string
  ): Promise<A2aTask> => {
    if (aborted) {
      const task = canceled(stored);
      await remember(userId, { ...stored, task });
      return task;
    }
    const state = mapStatus(output.status);
    const text = output.outputText || streamedText;
    if (text.length > MAX_STORED_TEXT) {
      const task = failed(stored);
      await remember(userId, { ...stored, task });
      return task;
    }
    const task = baseTask(stored.task.id, stored.task.contextId, state, stored.task.history ?? []);
    if (state === "TASK_STATE_INPUT_REQUIRED") {
      const message: A2aMessage = {
        messageId: createA2aId("msg"),
        role: "ROLE_AGENT",
        contextId: task.contextId,
        taskId: task.id,
        parts: [
          { text: "Input required before the task can continue." },
          {
            data: {
              approvals: output.state.pendingApprovals.map((approval) => ({
                approvalRequestId: approval.id,
                provider: approval.provider,
                name: approval.name,
                kind: approval.kind ?? "provider"
              }))
            }
          }
        ]
      };
      task.status.message = message;
      task.history = [...(task.history ?? []), message].slice(-MAX_HISTORY);
    } else if (state === "TASK_STATE_COMPLETED" && text) {
      const message: A2aMessage = {
        messageId: createA2aId("msg"),
        role: "ROLE_AGENT",
        contextId: task.contextId,
        taskId: task.id,
        parts: [{ text }]
      };
      task.artifacts = [{ artifactId: createA2aId("artifact"), name: "response", parts: [{ text }] }];
      task.history = [...(task.history ?? []), message].slice(-MAX_HISTORY);
    }
    await remember(userId, { ...stored, task });
    return task;
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      const protocol = error instanceof A2aProtocolError
        ? error
        : new A2aProtocolError("INTERNAL", "Internal error.");
      const release = () => {
        if (protocol.code === "LIMIT_EXCEEDED") request.destroy();
      };
      try {
        if (response.headersSent || response.writableEnded || response.destroyed) {
          if (!response.writableEnded && !response.destroyed) response.end();
          release();
          return;
        }
        writeError(response, null, protocol, release);
      } catch {
        release();
      }
    });
  });
  server.on("error", () => undefined);

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (closed) {
      request.resume();
      writeError(response, null, new A2aProtocolError("INTERNAL", "Internal error."));
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
      if (!card) {
        writeError(response, null, new A2aProtocolError("INTERNAL", "Internal error."));
        return;
      }
      const body = JSON.stringify(card);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body)
      });
      response.end(body);
      return;
    }
    if (request.method !== "POST" || url.pathname !== rpcPath) {
      request.resume();
      writeError(response, null, new A2aProtocolError("METHOD_NOT_FOUND", "Method not found."));
      return;
    }
    const contentType = headerValue(request, "content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      request.resume();
      writeError(response, null, new A2aProtocolError("CONTENT_TYPE_NOT_SUPPORTED", "Content type is not supported."));
      return;
    }
    const bytes = await readBody(request, maxRequestBytes);
    let payload: unknown;
    try {
      payload = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      writeError(response, null, new A2aProtocolError("PARSE_ERROR", "Invalid JSON payload."));
      return;
    }
    let rpc: RpcRequest;
    try {
      rpc = parseRpc(payload);
      if (!supportedA2aVersion(headerValue(request, "a2a-version"))) {
        throw new A2aProtocolError("VERSION_NOT_SUPPORTED", "A2A protocol version is not supported.");
      }
    } catch (error) {
      const protocol = error instanceof A2aProtocolError ? error : new A2aProtocolError("INVALID_REQUEST", "Request payload validation error.");
      writeError(response, isRecord(payload) ? jsonRpcId(payload.id) : null, protocol);
      return;
    }
    let userId: string;
    try {
      userId = await authenticate(request);
    } catch (error) {
      if (request.socket?.destroyed || response.destroyed || closed) return;
      const protocol = error instanceof A2aProtocolError && error.code === "AUTH_REQUIRED"
        ? error
        : new A2aProtocolError("AUTH_REQUIRED", "Authentication required.");
      writeError(response, rpc.id, protocol);
      return;
    }
    let method: string;
    try {
      method = canonicalA2aMethod(rpc.method);
    } catch (error) {
      writeError(response, rpc.id, error instanceof A2aProtocolError ? error : new A2aProtocolError("METHOD_NOT_FOUND", "Method not found."));
      return;
    }
    try {
      if (method === "SendStreamingMessage") {
        await writeStream(response, rpc, userId);
        return;
      }
      if (method === "CancelTask") {
        const result = await cancel(userId, rpc.params);
        writeJson(response, 200, { jsonrpc: "2.0", id: rpc.id, result });
        return;
      }
      const result = await dispatch(userId, method, rpc.params, abortSignalFor(response));
      writeJson(response, 200, { jsonrpc: "2.0", id: rpc.id, result });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      writeError(response, rpc.id, error instanceof A2aProtocolError ? error : new A2aProtocolError("INTERNAL", "Internal error."));
    }
  };

  const authenticate = async (request: IncomingMessage): Promise<string> => {
    if (!options.authenticate) return options.userId as string;
    let fail: (() => void) | undefined;
    let rejectGone: ((error: A2aProtocolError) => void) | undefined;
    const socket = request.socket;
    const gone = new Promise<never>((_resolve, reject) => {
      rejectGone = reject;
      fail = () => reject(new A2aProtocolError("INTERNAL", "Internal error."));
      if (!socket || socket.destroyed || closed) fail();
      else socket.once("close", fail);
    });
    void gone.catch(() => undefined);
    try {
      const result = await Promise.race([Promise.resolve(options.authenticate(request)), gone]);
      if (!socket || socket.destroyed || closed) {
        throw new A2aProtocolError("INTERNAL", "Internal error.");
      }
      if (!result || !isA2aIdentifier(result.userId)) {
        throw new A2aProtocolError("AUTH_REQUIRED", "Authentication required.");
      }
      return result.userId;
    } finally {
      socket?.off("close", fail ?? (() => undefined));
      rejectGone?.(new A2aProtocolError("INTERNAL", "Internal error."));
    }
  };

  const dispatch = async (
    userId: string,
    method: string,
    params: Record<string, unknown>,
    abort: AbortSignal
  ): Promise<JsonValue> => {
    if (method === "GetTask") {
      const id = requiredId(params.id);
      const historyLength = optionalHistory(params.historyLength);
      rejectTenant(params.tenant);
      const stored = await taskForUser(userId, id);
      return JSON.parse(JSON.stringify(present(stored.task, historyLength))) as JsonValue;
    }
    const task = await execute(userId, params, undefined, abort);
    return JSON.parse(JSON.stringify({ task })) as JsonValue;
  };

  const cancel = async (userId: string, params: Record<string, unknown>): Promise<JsonValue> => {
    rejectTenant(params.tenant);
    const id = requiredId(params.id);
    const flight = inflight.get(id);
    if (flight) {
      if (flight.userId !== userId) throw new A2aProtocolError("TASK_NOT_FOUND", "Task not found.");
      flight.abort.abort();
      await flight.done;
      const updated = await taskForUser(userId, id);
      return JSON.parse(JSON.stringify(updated.task)) as JsonValue;
    }
    return withUserLock(userId, async () => {
      const stored = await taskForUser(userId, id);
      if (stored.task.status.state === "TASK_STATE_CANCELED") {
        return JSON.parse(JSON.stringify(stored.task)) as JsonValue;
      }
      if (isTerminalA2aState(stored.task.status.state)) {
        throw new A2aProtocolError("TASK_NOT_CANCELABLE", "Task cannot be canceled.");
      }
      const task = canceled(stored);
      await remember(userId, { ...stored, task });
      return JSON.parse(JSON.stringify(task)) as JsonValue;
    });
  };

  const writeStream = async (response: ServerResponse, rpc: RpcRequest, userId: string) => {
    parseSend(rpc.params);
    const abort = abortSignalFor(response);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    });
    const send = (event: A2aStreamResponse) => {
      response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: event })}\n\n`);
    };
    try {
      await execute(userId, rpc.params, send, abort);
    } catch (error) {
      const protocol = error instanceof A2aProtocolError ? error : new A2aProtocolError("INTERNAL", "Internal error.");
      response.write(`data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: protocol.jsonRpcCode, message: protocol.message }
      })}\n\n`);
    } finally {
      response.end();
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        server.off("error", fail);
        reject(error);
      };
      server.once("error", fail);
      server.listen(options.port ?? 0, host, () => {
        server.off("error", fail);
        resolve();
      });
    });
  } catch (error) {
    await shutdown().catch(() => undefined);
    throw error;
  }
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new A2aProtocolError("INTERNAL", "Internal error.");
    }
    const advertisedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : formatHost(host);
    const origin = options.publicBaseUrl
      ? publicOrigin(options.publicBaseUrl)
      : `http://${advertisedHost}:${address.port}`;
    const url = origin;
    const rpcUrl = new URL(rpcPath, `${origin}/`).href;
    card = createA2aAgentCard({
      name: options.card.name,
      description: options.card.description,
      version: options.card.version,
      skills: options.card.skills,
      documentationUrl: options.card.documentationUrl,
      url: rpcUrl
    });
    return {
      url,
      cardUrl: new URL("/.well-known/agent-card.json", `${origin}/`).href,
      rpcUrl,
      card,
      close() {
        closing ??= shutdown();
        return closing;
      }
    };
  } catch (error) {
    await shutdown();
    throw error instanceof A2aProtocolError ? error : new A2aProtocolError("INTERNAL", "Internal error.");
  }

  function shutdown(): Promise<void> {
    closed = true;
    for (const flight of inflight.values()) flight.abort.abort();
    try {
      server.closeAllConnections();
    } catch {
      // Listen can fail before the server has connections to close.
    }
    return Promise.allSettled([...tails.values()])
      .then(() => Promise.allSettled([...inflight.values()].map((flight) => flight.done)))
      .then(() => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
      }));
  }
};

interface ParsedSend {
  message: A2aMessage;
  prompt?: string;
  approvals?: Array<{ approvalRequestId: string; approve: boolean; provider?: string; reason?: string }>;
  historyLength?: number;
}

const parseSend = (params: Record<string, unknown>): ParsedSend => {
  rejectTenant(params.tenant);
  if (params.configuration !== undefined && !isRecord(params.configuration)) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  const configuration = isRecord(params.configuration) ? params.configuration : undefined;
  if (configuration?.taskPushNotificationConfig !== undefined) {
    throw new A2aProtocolError("PUSH_NOTIFICATIONS_NOT_SUPPORTED", "Push notifications are not supported.");
  }
  if (Array.isArray(configuration?.acceptedOutputModes)) {
    const modes = configuration.acceptedOutputModes.filter((mode): mode is string => typeof mode === "string");
    if (modes.length && !modes.some((mode) => mode === "text/plain" || mode === "application/json")) {
      throw new A2aProtocolError("CONTENT_TYPE_NOT_SUPPORTED", "Content type is not supported.");
    }
  }
  if (!isRecord(params.message)) throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  const message = parseMessage(params.message);
  if (configuration?.returnImmediately !== undefined && typeof configuration.returnImmediately !== "boolean") {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  if (configuration?.returnImmediately === true) {
    throw new A2aProtocolError("UNSUPPORTED_OPERATION", "Non-blocking send is not implemented.");
  }
  return {
    message,
    prompt: promptFrom(message),
    approvals: approvalsFrom(message),
    historyLength: optionalHistory(configuration?.historyLength)
  };
};

const parseMessage = (value: Record<string, unknown>): A2aMessage => {
  if (value.role !== "ROLE_USER") throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  if (typeof value.messageId !== "string" || !isA2aIdentifier(value.messageId)) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  if (value.contextId !== undefined && (typeof value.contextId !== "string" || !isA2aIdentifier(value.contextId))) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  if (value.taskId !== undefined && (typeof value.taskId !== "string" || !isA2aIdentifier(value.taskId))) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  if (!Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > 32) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  return {
    messageId: value.messageId,
    role: "ROLE_USER",
    parts: value.parts.map(parsePart),
    ...(typeof value.contextId === "string" ? { contextId: value.contextId } : {}),
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {})
  };
};

const parsePart = (value: unknown): A2aPart => {
  if (!isRecord(value)) throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  const keys = ["text", "data", "raw", "url"].filter((key) => value[key] !== undefined);
  if (keys.length !== 1) throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  if (keys[0] === "raw" || keys[0] === "url") {
    throw new A2aProtocolError("CONTENT_TYPE_NOT_SUPPORTED", "Content type is not supported.");
  }
  if (keys[0] === "text") {
    if (typeof value.text !== "string" || value.text.length > MAX_STORED_TEXT) {
      throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
    }
    return { text: value.text };
  }
  let data: JsonValue;
  try {
    data = JSON.parse(JSON.stringify(value.data)) as JsonValue;
  } catch {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  return { data };
};

const promptFrom = (message: A2aMessage): string | undefined => {
  const text = message.parts
    .map((part) => part.text)
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  return text || undefined;
};

const approvalsFrom = (message: A2aMessage): ParsedSend["approvals"] => {
  const data = message.parts.find((part) => isRecord(part.data) && "approvals" in part.data)?.data;
  if (!isRecord(data) || !("approvals" in data)) return undefined;
  if (!Array.isArray(data.approvals) || data.approvals.length === 0 || data.approvals.length > 32) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  return data.approvals.map((entry) => {
    if (!isRecord(entry) || typeof entry.approvalRequestId !== "string" || !isA2aIdentifier(entry.approvalRequestId) || typeof entry.approve !== "boolean") {
      throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
    }
    if (entry.provider !== undefined && (typeof entry.provider !== "string" || entry.provider.length > 200)) {
      throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
    }
    if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.length > 200)) {
      throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
    }
    return {
      approvalRequestId: entry.approvalRequestId,
      approve: entry.approve,
      ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {})
    };
  });
};

const resolveApprovals = (
  decisions: NonNullable<ParsedSend["approvals"]>,
  pending: AgentApprovalRequest[]
): AgentApprovalResponse[] => {
  if (!pending.length || decisions.length !== pending.length) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  const byId = new Map(decisions.map((decision) => [decision.approvalRequestId, decision]));
  return pending.map((approval) => {
    const decision = byId.get(approval.id);
    if (!decision) throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
    return {
      provider: decision.provider ?? approval.provider,
      approvalRequestId: approval.id,
      approve: decision.approve,
      ...(decision.reason ? { reason: decision.reason } : {})
    };
  });
};

const jsonRpcId = (value: unknown): string | number | null => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
};

const parseRpc = (value: unknown): RpcRequest => {
  if (Array.isArray(value) || !isRecord(value)) {
    throw new A2aProtocolError("INVALID_REQUEST", "Request payload validation error.");
  }
  if (value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0 || value.method.length > 200) {
    throw new A2aProtocolError("INVALID_REQUEST", "Request payload validation error.");
  }
  if (value.id !== undefined && value.id !== null && jsonRpcId(value.id) === null) {
    throw new A2aProtocolError("INVALID_REQUEST", "Request payload validation error.");
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  return {
    id: value.id === undefined || value.id === null ? null : jsonRpcId(value.id),
    method: value.method,
    params: isRecord(value.params) ? value.params : {}
  };
};

const rejectTenant = (tenant: unknown) => {
  if (tenant !== undefined) throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
};

const requiredId = (value: unknown): string => {
  if (typeof value !== "string" || !isA2aIdentifier(value)) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  return value;
};

const optionalHistory = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > INT32_MAX) {
    throw new A2aProtocolError("INVALID_PARAMS", "Invalid parameters.");
  }
  return Math.min(value, MAX_HISTORY);
};

const stamp = (message: A2aMessage, contextId: string, taskId: string): A2aMessage => ({
  ...message,
  contextId,
  taskId
});

const baseTask = (id: string, contextId: string, state: A2aTaskState, history: A2aMessage[]): A2aTask => ({
  id,
  contextId,
  status: { state, timestamp: new Date().toISOString() },
  history
});

const canceled = (stored: StoredTask): A2aTask =>
  baseTask(stored.task.id, stored.task.contextId, "TASK_STATE_CANCELED", stored.task.history ?? []);

const failed = (stored: StoredTask): A2aTask =>
  baseTask(stored.task.id, stored.task.contextId, "TASK_STATE_FAILED", stored.task.history ?? []);

const abortedOrFailed = (stored: StoredTask, aborted: boolean): A2aTask => aborted ? canceled(stored) : failed(stored);

const mapStatus = (status: AgentStatus): A2aTaskState => {
  switch (status) {
    case "queued": return "TASK_STATE_SUBMITTED";
    case "running":
    case "cancel_requested": return "TASK_STATE_WORKING";
    case "completed": return "TASK_STATE_COMPLETED";
    case "waiting_approval":
    case "suspended": return "TASK_STATE_INPUT_REQUIRED";
    case "failed":
    case "timed_out": return "TASK_STATE_FAILED";
    case "cancelled": return "TASK_STATE_CANCELED";
    default: return "TASK_STATE_FAILED";
  }
};

const abortSignalFor = (response: ServerResponse): AbortSignal => {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller.signal;
};

const headerValue = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const readBody = async (request: IncomingMessage, maxBytes: number): Promise<Buffer> => {
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new A2aProtocolError("LIMIT_EXCEEDED", "A2A request exceeded byte limit.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new A2aProtocolError("LIMIT_EXCEEDED", "A2A request exceeded byte limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const writeJson = (
  response: ServerResponse,
  status: number,
  payload: JsonValue,
  onFinish?: () => void
) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body, () => onFinish?.());
};

const writeError = (
  response: ServerResponse,
  id: string | number | null,
  error: A2aProtocolError,
  onFinish?: () => void
) => {
  writeJson(response, httpStatusForA2aCode(error.jsonRpcCode), {
    jsonrpc: "2.0",
    id,
    error: { code: error.jsonRpcCode, message: error.message }
  }, onFinish);
};

const formatHost = (value: string): string => {
  if (value.startsWith("[") && value.endsWith("]")) return value;
  return value.includes(":") ? `[${value}]` : value;
};

const publicOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new A2aProtocolError("INVALID_PARAMS", "A2A public URL is invalid.");
  }
  if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new A2aProtocolError("INVALID_PARAMS", "A2A public URL is invalid.");
  }
  return url.origin;
};

const positive = (value: number | undefined, fallback: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new A2aProtocolError("INVALID_PARAMS", "A2A limits must be positive safe integers.");
  }
  return resolved;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringMap = (metadata: Record<string, JsonValue> | undefined, key: string): Record<string, string> => {
  const value = metadata?.[key];
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};

const recordMap = (metadata: Record<string, JsonValue> | undefined, key: string): Record<string, JsonValue> => {
  const value = metadata?.[key];
  if (!isRecord(value)) return {};
  return { ...value };
};
