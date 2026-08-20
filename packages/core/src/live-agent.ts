import { BoundedReplayBroadcast } from "./bounded-broadcast.js";
import { ConflictError, GuardrailTriggeredError, ValidationError } from "./errors.js";
import { AGENT_RUN_STATE_SCHEMA_VERSION, normalizeAgentRunState } from "./agent-state.js";
import { normalizeMessages } from "./generate-text.js";
import { createTextMessage, getTextFromParts, isCallableToolDefinition, serializeJsonValue, toolResultPart } from "./messages.js";
import { createSecureId } from "#secure-id";
import { toToolSet } from "./tool-registry.js";
import type {
  AgentGuardrailTrigger,
  AgentInputGuardrail,
  AgentLiveEvent,
  AgentLiveStreamResult,
  AgentOutputGuardrail,
  AgentRunState,
  AgentStoreScope,
  AgentStatus,
  AgentTelemetryEvent,
  AgentToolCallJournalEntry,
  JsonValue,
  LiveAgentDefinition,
  LiveAgentRunInput,
  LiveAgentRunOutput,
  ModelMessage,
  RealtimeEvent,
  RealtimeModel,
  RealtimeSession,
  RealtimeSessionConfig,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolCall,
  ToolCollection,
  ToolDefinition,
  ToolExecutionOptions,
  ToolExecutionResult,
  ToolSet
} from "./types.js";

const joinInstructions = (...parts: Array<string | undefined>): string | undefined => {
  const content = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return content.length ? content.join("\n\n") : undefined;
};

const cloneMetadata = (...values: Array<Record<string, JsonValue> | undefined>) => {
  const merged = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
};

const cloneState = (state: AgentRunState): AgentRunState =>
  JSON.parse(JSON.stringify(normalizeAgentRunState(state))) as AgentRunState;

const createBaseState = (
  provider: string,
  modelId: string,
  initialMessages: ModelMessage[],
  metadata: Record<string, JsonValue> | undefined,
  agentId: string | undefined,
  runId: string,
  scope: AgentStoreScope | undefined,
  idempotencyKey: string | undefined
): AgentRunState => {
  const startedAt = Date.now();
  return {
    schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION,
    revision: 0,
    scope,
    runId,
    idempotencyKey,
    agentId,
    provider,
    modelId,
    status: "running",
    messages: initialMessages,
    steps: [],
    toolResults: [],
    currentStep: 0,
    maxSteps: 1,
    outputText: "",
    pendingApprovals: [],
    metadata,
    startedAt,
    updatedAt: startedAt
  };
};

const applyGuardrailFailure = (
  state: AgentRunState,
  stage: "input" | "output",
  trigger: AgentGuardrailTrigger
): AgentRunState => ({
  ...state,
  status: "failed",
  error: {
    message: trigger.reason ?? `Agent ${stage} guardrail triggered.`
  },
  updatedAt: Date.now()
});

const emitTelemetryEvent = async <TModel extends RealtimeModel>(
  agent: Pick<LiveAgentDefinition<TModel>, "onTelemetryEvent">,
  event: AgentTelemetryEvent,
  abortSignal?: AbortSignal
) => {
  const operation = Promise.resolve().then(() => agent.onTelemetryEvent?.(event));
  if (abortSignal) await raceWithAbort(operation, abortSignal);
  else await operation;
};

const checkpointState = async <TModel extends RealtimeModel>(
  agent: LiveAgentDefinition<TModel>,
  state: AgentRunState,
  abortSignal?: AbortSignal
) => {
  if (agent.store) {
    const expectedRevision = state.revision ?? 0;
    const nextRevision = expectedRevision + 1;
    if (abortSignal?.aborted) throw abortError(abortSignal);
    const save = Promise.resolve(
      agent.store.save(cloneState({ ...state, revision: nextRevision }), { expectedRevision })
    );
    if (abortSignal) await raceWithAbort(save, abortSignal);
    else await save;
    state.revision = nextRevision;
  }
};

const persistState = async <TModel extends RealtimeModel>(
  agent: LiveAgentDefinition<TModel>,
  state: AgentRunState,
  abortSignal?: AbortSignal
) => {
  state.updatedAt = Date.now();
  await checkpointState(agent, state, abortSignal);
  await emitTelemetryEvent(agent, {
    type: "state-saved",
    runId: state.runId,
    agentId: state.agentId,
    status: state.status
  }, abortSignal);
  if (agent.memory?.save) {
    const save = Promise.resolve().then(() => agent.memory!.save!({
      runId: state.runId,
      agentId: state.agentId,
      scope: state.scope,
      state: cloneState(state),
      metadata: state.metadata
    }));
    if (abortSignal) await raceWithAbort(save, abortSignal);
    else await save;
  }
};

const runGuardrails = async <TRequest>(
  agent: Pick<LiveAgentDefinition<RealtimeModel>, "onTelemetryEvent" | "id">,
  state: AgentRunState,
  stage: "input" | "output",
  guardrails: ReadonlyArray<((request: TRequest) => AgentGuardrailTrigger | void | Promise<AgentGuardrailTrigger | void>)> | undefined,
  requestFactory: (index: number) => TRequest,
  abortSignal?: AbortSignal
) => {
  for (const [index, guardrail] of (guardrails ?? []).entries()) {
    const execution = Promise.resolve().then(() => guardrail(requestFactory(index)));
    const trigger = abortSignal ? await raceWithAbort(execution, abortSignal) : await execution;
    if (!trigger?.triggered) {
      continue;
    }

    await emitTelemetryEvent(agent, {
      type: "guardrail-triggered",
      runId: state.runId,
      agentId: state.agentId,
      stage,
      reason: trigger.reason ?? `Agent ${stage} guardrail #${index + 1} triggered.`,
      metadata: trigger.metadata
    }, abortSignal);
    return trigger;
  }

  return undefined;
};

const emitRunStartTelemetry = async <TModel extends RealtimeModel>(
  agent: LiveAgentDefinition<TModel>,
  state: AgentRunState,
  memoryMessages: ModelMessage[],
  abortSignal?: AbortSignal
) => {
  await emitTelemetryEvent(agent, {
    type: "run-start",
    runId: state.runId,
    agentId: state.agentId,
    provider: state.provider,
    modelId: state.modelId,
    maxSteps: state.maxSteps
  }, abortSignal);
  if (memoryMessages.length) {
    await emitTelemetryEvent(agent, {
      type: "memory-loaded",
      runId: state.runId,
      agentId: state.agentId,
      messageCount: memoryMessages.length
    }, abortSignal);
  }
};

const emitRunFinishTelemetry = async <TModel extends RealtimeModel>(
  agent: LiveAgentDefinition<TModel>,
  state: AgentRunState,
  abortSignal?: AbortSignal
) => {
  await emitTelemetryEvent(agent, {
    type: "run-finish",
    runId: state.runId,
    agentId: state.agentId,
    status: state.status,
    state: cloneState(state)
  }, abortSignal);
};

const withToolTimeout = async <T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs?: number,
  abortSignal?: AbortSignal
): Promise<T> => {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(abortSignal?.reason);
  if (abortSignal?.aborted) {
    abortFromCaller();
  } else {
    abortSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const signal = controller.signal;
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(new ToolExecutionTimeoutError(timeoutMs)), timeoutMs);
  try {
    return await raceWithAbort(Promise.resolve().then(() => operation(signal)), signal);
  } finally {
    if (timer) clearTimeout(timer);
    abortSignal?.removeEventListener("abort", abortFromCaller);
  }
};

class ToolExecutionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Tool execution timed out after ${timeoutMs}ms.`);
    this.name = "ToolExecutionTimeoutError";
  }
}

const injectContextMessages = (messages: ModelMessage[], extraMessages: ModelMessage[]): ModelMessage[] => {
  if (!extraMessages.length) {
    return messages;
  }

  if (messages[0]?.role === "system") {
    return [messages[0], ...extraMessages, ...messages.slice(1)];
  }

  return [...extraMessages, ...messages];
};

const textFromMessage = (message: ModelMessage) => getTextFromParts(message.parts).trim();

const contextInstructions = (messages: ModelMessage[]): string | undefined => {
  const lines = messages.flatMap((message) => {
    const text = textFromMessage(message);
    return text ? [`${message.role}: ${text}`] : [];
  });
  return lines.length ? `Conversation context:\n${lines.join("\n")}` : undefined;
};

const ensureValidScope = (scope: AgentStoreScope | undefined) => {
  if (!scope) return;
  if (typeof scope.tenantId !== "string" || scope.tenantId.length === 0) {
    throw new ValidationError('Live agent scope "tenantId" must be a non-empty string.');
  }
  for (const field of ["userId", "namespace"] as const) {
    if (scope[field] !== undefined && (typeof scope[field] !== "string" || scope[field]!.length === 0)) {
      throw new ValidationError(`Live agent scope "${field}" must be a non-empty string when provided.`);
    }
  }
};

const ensureDurableConfiguration = (
  agent: LiveAgentDefinition,
  input: LiveAgentRunInput,
  tools: ToolCollection | undefined
) => {
  ensureValidScope(input.scope);
  if (input.idempotencyKey && !agent.store) {
    throw new ValidationError('The live agent "idempotencyKey" option requires an agent run "store".');
  }
  if (input.idempotencyKey && !agent.store?.claimIdempotencyKey) {
    throw new ValidationError(
      'The live agent run "store" must implement "claimIdempotencyKey()" to use "idempotencyKey" safely.'
    );
  }
  const hasCallableTools = Object.values(toToolSet(tools) ?? {}).some(isCallableToolDefinition);
  if (
    agent.store &&
    hasCallableTools &&
    (!agent.store.claimToolExecution || !agent.store.loadToolExecution || !agent.store.completeToolExecution)
  ) {
    throw new ValidationError(
      'A live agent run "store" with local tools must implement claimToolExecution(), loadToolExecution(), and completeToolExecution().'
    );
  }
};

class LiveAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Live agent run timed out after ${timeoutMs}ms.`);
    this.name = "LiveAgentTimeoutError";
  }
}

const createLifetimeAbort = (input: LiveAgentRunInput) => {
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 24 * 60 * 60 * 1_000)
  ) {
    throw new ValidationError('The "timeoutMs" option must be a positive safe integer no greater than 86400000.');
  }

  const controller = new AbortController();
  const sources = [input.abortSignal, input.connectOptions?.signal].filter(
    (signal): signal is AbortSignal => Boolean(signal)
  );
  const listeners = new Map<AbortSignal, () => void>();
  for (const source of sources) {
    const abort = () => controller.abort(source.reason);
    listeners.set(source, abort);
    if (source.aborted) {
      abort();
      break;
    }
    source.addEventListener("abort", abort, { once: true });
  }
  const timer = input.timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(new LiveAgentTimeoutError(input.timeoutMs!)), input.timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      for (const [source, listener] of listeners) {
        source.removeEventListener("abort", listener);
      }
    }
  };
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");

const raceWithAbort = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
};

const TERMINAL_FAILURE_CLEANUP_TIMEOUT_MS = 1_000;

const runTerminalFailureCleanup = async (
  operations: Array<(signal: AbortSignal) => void | Promise<void>>
) => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Terminal live-agent cleanup timed out.", "TimeoutError")),
    TERMINAL_FAILURE_CLEANUP_TIMEOUT_MS
  );
  try {
    await Promise.allSettled(
      operations.map((operation) =>
        raceWithAbort(Promise.resolve().then(() => operation(controller.signal)), controller.signal)
      )
    );
  } finally {
    clearTimeout(timer);
  }
};

const nextWithAbort = <T>(iterator: AsyncIterator<T>, signal: AbortSignal) =>
  raceWithAbort(Promise.resolve(iterator.next()), signal);

const canonicalJson = (value: JsonValue | undefined): string => {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const sameJson = (left: JsonValue | undefined, right: JsonValue | undefined) =>
  canonicalJson(left) === canonicalJson(right);

const createResult = (state: AgentRunState): LiveAgentRunOutput => ({
  status: state.status,
  outputText: state.outputText,
  messages: state.messages,
  toolResults: state.toolResults,
  state,
  error: state.error
});

const createBroadcast = <TEvent>() => {
  const broadcast = new BoundedReplayBroadcast<TEvent>();

  const publish = async (value: IteratorResult<TEvent>) => {
    if (value.done) {
      broadcast.close();
      return;
    }
    const type = typeof value.value === "object" && value.value !== null && "type" in value.value
      ? String(value.value.type)
      : undefined;
    await broadcast.publish(value.value, {
      terminal: type === "agent-run-finish" || type === "error" || type === "realtime-end"
    });
  };

  return {
    publish,
    close: () => broadcast.close(),
    get isClosed() {
      return broadcast.isClosed;
    },
    stream: (accepts?: (value: TEvent) => boolean) => broadcast.stream(accepts)
  };
};

const resolveApproval = async <TModel extends RealtimeModel>(options: {
  agent: LiveAgentDefinition<TModel>;
  input: LiveAgentRunInput;
  state: AgentRunState;
  call: ToolCall;
  parsedInput: JsonValue;
  tool: ToolDefinition;
  realtimeConfig: RealtimeSessionConfig;
}): Promise<ToolApprovalDecision> => {
  const policy = options.input.toolApprovalPolicy ?? options.agent.toolApprovalPolicy;
  const request: ToolApprovalRequest = {
    toolCall: options.call,
    tool: options.tool,
    input: options.parsedInput,
    step: 1,
    model: options.agent.model,
    realtimeConfig: options.realtimeConfig
  };

  const decision =
    !policy
      ? options.tool.requiresApproval
        ? {
            approved: false,
            reason: `Tool "${options.call.name}" requires approval, but no toolApprovalPolicy is configured.`
          }
        : { approved: true }
      : await policy(request);

  const normalized =
    typeof decision === "boolean"
      ? {
          approved: decision,
          reason: decision ? undefined : `Tool "${options.call.name}" was denied by the approval policy.`
        }
      : (decision ?? { approved: true });

  await emitTelemetryEvent(options.agent, {
    type: "tool-approval",
    runId: options.state.runId,
    agentId: options.state.agentId,
    toolCall: options.call,
    approved: normalized.approved,
    reason: normalized.reason,
    metadata: normalized.metadata
  });

  return normalized;
};

export const streamLiveAgent = <TModel extends RealtimeModel>(
  agent: LiveAgentDefinition<TModel>,
  input: LiveAgentRunInput = {}
): AgentLiveStreamResult => {
  const broadcast = createBroadcast<AgentLiveEvent>();
  let resolveSession!: (session: RealtimeSession) => void;
  let rejectSession!: (error: unknown) => void;
  let sessionSettled = false;
  const sessionPromise = new Promise<RealtimeSession>((resolve, reject) => {
    resolveSession = (session) => {
      if (sessionSettled) return;
      sessionSettled = true;
      resolve(session);
    };
    rejectSession = (error) => {
      if (sessionSettled) return;
      sessionSettled = true;
      reject(error);
    };
  });
  void sessionPromise.catch(() => undefined);
  const lifetime = createLifetimeAbort(input);

  const runner = (async () => {
    const runId = input.runId ?? createSecureId("run");
    const metadata = cloneMetadata(agent.metadata, input.metadata);
    let resolvedTools: ToolSet = {};

    let state: AgentRunState | undefined;
    let session: RealtimeSession | undefined;
    let closePromise: Promise<void> | undefined;
    let runError: unknown;
    let failureCleanupRan = false;
    let transcript: ModelMessage[] = [];
    const toolResults: ToolExecutionResult[] = [];
    const assistantBuffer: string[] = [];
    const outputTranscriptBuffer: string[] = [];
    let finalText = "";
    let sessionError: Error | undefined;
    const processedToolCalls = new Map<string, { fingerprint: string; result: ToolExecutionResult }>();

    const closeSession = async () => {
      if (!session) return;
      closePromise ??= Promise.resolve().then(() => session!.close());
      await closePromise;
    };
    const abortSession = () => {
      void closeSession().catch(() => undefined);
    };
    lifetime.signal.addEventListener("abort", abortSession, { once: true });

    const publish = async (event: AgentLiveEvent) => {
      if (!broadcast.isClosed) {
        const terminal = event.type === "agent-run-finish" || event.type === "error" || event.type === "realtime-end";
        const operation = broadcast.publish({ done: false, value: event });
        if (terminal) await operation;
        else await raceWithAbort(operation, lifetime.signal);
      }
    };

    const rejectNoSession = (error: unknown) => {
      rejectSession(error instanceof Error ? error : new Error(String(error)));
    };

    try {
      resolvedTools = {
        ...(toToolSet(agent.tools) ?? {}),
        ...(toToolSet(input.tools) ?? {})
      };
      ensureDurableConfiguration(agent, input, resolvedTools);
      const baseMessages = normalizeMessages({
        prompt: input.prompt,
        messages: input.messages,
        system: joinInstructions(agent.instructions, input.system)
      });
      state = createBaseState(
        agent.model.provider,
        agent.model.modelId,
        baseMessages,
        metadata,
        agent.id,
        runId,
        input.scope,
        input.idempotencyKey
      );

      if (agent.store) {
        let existing = input.idempotencyKey
          ? undefined
          : await raceWithAbort(Promise.resolve(agent.store.load(runId, input.scope)), lifetime.signal);
        if (input.idempotencyKey) {
          const claim = await raceWithAbort(
            Promise.resolve(
              agent.store.claimIdempotencyKey!(state as AgentRunState & { idempotencyKey: string })
            ),
            lifetime.signal
          );
          if (!claim.claimed) existing = normalizeAgentRunState(claim.state);
          else state = normalizeAgentRunState(claim.state);
        }
        if (existing) {
          const normalized = normalizeAgentRunState(existing);
          const terminalStatuses: AgentStatus[] = ["completed", "failed", "cancelled", "timed_out"];
          if (!terminalStatuses.includes(normalized.status)) {
            throw new ConflictError(`Live agent run "${normalized.runId}" is already ${normalized.status}.`);
          }
          state = normalized;
          await emitRunStartTelemetry(agent, state, [], lifetime.signal);
          await publish({ type: "agent-run-start", currentStep: 1, maxSteps: 1 });
          await emitRunFinishTelemetry(agent, state, lifetime.signal);
          await publish({ type: "agent-run-finish", status: state.status, state: cloneState(state) });
          rejectNoSession(
            new ValidationError(
              `Live agent run "${state.runId}" was replayed from durable state and has no active realtime session.`
            )
          );
          return createResult(state);
        }
        if (!input.idempotencyKey) {
          await checkpointState(agent, state, lifetime.signal);
        }
      }

      const memoryMessages = agent.memory
        ? await raceWithAbort(
            Promise.resolve(
              agent.memory.load({
                runId,
                agentId: agent.id,
                scope: input.scope,
                metadata
              })
            ),
            lifetime.signal
          )
        : [];
      const messages = injectContextMessages(baseMessages, memoryMessages);
      transcript = [...messages];
      state.messages = messages;
      await emitRunStartTelemetry(agent, state, memoryMessages, lifetime.signal);
      await persistState(agent, state, lifetime.signal);
      await publish({ type: "agent-run-start", currentStep: 1, maxSteps: 1 });

      const inputGuardrail = await runGuardrails(
        agent,
        state,
        "input",
        agent.inputGuardrails as AgentInputGuardrail[] | undefined,
        () => ({
          runId: state!.runId,
          agentId: state!.agentId,
          state: cloneState(state!),
          messages,
          metadata: state!.metadata
        }),
        lifetime.signal
      );
      if (inputGuardrail) {
        const failedState = applyGuardrailFailure(state, "input", inputGuardrail);
        state = failedState;
        await persistState(agent, failedState, lifetime.signal);
        await emitRunFinishTelemetry(agent, failedState, lifetime.signal);
        const error = new GuardrailTriggeredError(
          "input",
          failedState.error?.message ?? "Agent input guardrail triggered.",
          { metadata: inputGuardrail.metadata }
        );
        await publish({ type: "error", error });
        await publish({ type: "agent-run-finish", status: failedState.status, state: cloneState(failedState) });
        rejectNoSession(error);
        return createResult(failedState);
      }

      const explicitMessages = input.messages ?? [];
      let activeUserIndex = -1;
      explicitMessages.forEach((message, index) => {
        if (message.role === "user") activeUserIndex = index;
      });
      const priorConversation = explicitMessages.filter((_, index) => index !== activeUserIndex);
      const realtimeConfig: RealtimeSessionConfig = {
        autoResponse: true,
        ...input.realtime,
        instructions: joinInstructions(
          agent.instructions,
          input.system,
          contextInstructions([...memoryMessages, ...priorConversation]),
          input.realtime?.instructions
        ),
        tools: Object.keys(resolvedTools).length ? resolvedTools : undefined,
        toolChoice: input.toolChoice ?? input.realtime?.toolChoice ?? agent.toolChoice,
        providerOptions: {
          ...(agent.providerOptions ?? {}),
          ...(input.providerOptions ?? {}),
          ...(input.realtime?.providerOptions ?? {})
        }
      };

      if (lifetime.signal.aborted) throw abortError(lifetime.signal);
      const connectPromise = agent.model.connect(realtimeConfig, {
        ...input.connectOptions,
        timeoutMs: input.connectOptions?.timeoutMs ?? input.timeoutMs,
        signal: lifetime.signal
      });
      void connectPromise.then((lateSession) => {
        if (lifetime.signal.aborted && lateSession !== session) {
          void lateSession.close().catch(() => undefined);
        }
      }, () => undefined);
      session = await raceWithAbort(connectPromise, lifetime.signal);
      resolveSession(session);

      if (activeUserIndex >= 0) {
        const text = textFromMessage(explicitMessages[activeUserIndex]!);
        if (text) {
          if (lifetime.signal.aborted) throw abortError(lifetime.signal);
          await raceWithAbort(session.sendText(text), lifetime.signal);
        }
      } else if (input.prompt) {
        if (lifetime.signal.aborted) throw abortError(lifetime.signal);
        await raceWithAbort(session.sendText(input.prompt), lifetime.signal);
      }

      const recordToolResult = async (result: ToolExecutionResult, fingerprint: string) => {
        processedToolCalls.set(result.toolCallId, { fingerprint, result });
        toolResults.push(result);
        transcript.push({ role: "tool", parts: [toolResultPart(result)] });
        state!.messages = transcript;
        state!.toolResults = toolResults;
        await persistState(agent, state!, lifetime.signal);
        if (lifetime.signal.aborted) throw abortError(lifetime.signal);
        await raceWithAbort(session!.sendToolResult(result), lifetime.signal);
      };

      const executeTool = async (
        definition: ToolDefinition,
        call: ToolCall,
        parsedInput: unknown,
        serializedInput: JsonValue
      ): Promise<ToolExecutionResult> => {
        const idempotencyKey = `${input.idempotencyKey ?? state!.runId}:${call.id}`;
        let journalClaim: AgentToolCallJournalEntry | undefined;
        if (agent.store) {
          const candidate = {
            runId: state!.runId,
            scope: state!.scope,
            toolCallId: call.id,
            toolName: call.name,
            status: "pending",
            idempotencyKey,
            revision: 0,
            input: serializedInput,
            updatedAt: Date.now()
          } satisfies AgentToolCallJournalEntry;
          if (lifetime.signal.aborted) throw abortError(lifetime.signal);
          const claim = await raceWithAbort(
            Promise.resolve(agent.store.claimToolExecution!(candidate)),
            lifetime.signal
          );
          if (!claim.claimed) {
            if (claim.entry.toolName !== call.name || !sameJson(claim.entry.input, serializedInput)) {
              throw new ConflictError(`Realtime tool call id "${call.id}" was reused with a different payload.`);
            }
            if (claim.entry.status === "completed") {
              return {
                toolCallId: call.id,
                toolName: call.name,
                output: claim.entry.output ?? null,
                isError: false
              };
            }
            if (claim.entry.status === "failed") {
              return {
                toolCallId: call.id,
                toolName: call.name,
                error: { message: claim.entry.error?.message ?? `Tool "${call.name}" previously failed.` },
                isError: true
              };
            }
            throw new ConflictError(
              `Tool "${call.name}" has an indeterminate durable execution. Reconcile idempotency key "${claim.entry.idempotencyKey}" before retrying.`
            );
          }
          journalClaim = claim.entry;
        }

        try {
          const output = serializeJsonValue(
            await withToolTimeout(
              async (abortSignal) => definition.execute(parsedInput, {
                abortSignal,
                toolCall: call,
                step: 1,
                model: agent.model,
                realtimeConfig,
                runId: state!.runId,
                agentId: state!.agentId,
                scope: state!.scope,
                metadata: state!.metadata,
                idempotencyKey
              }),
              (input.toolExecution ?? agent.toolExecution)?.timeoutMs,
              lifetime.signal
            )
          );
          if (journalClaim) {
            if (lifetime.signal.aborted) throw abortError(lifetime.signal);
            await raceWithAbort(
              Promise.resolve(
                agent.store!.completeToolExecution!(
                  {
                    ...journalClaim,
                    status: "completed",
                    output,
                    completedAt: Date.now(),
                    updatedAt: Date.now()
                  },
                  { expectedRevision: journalClaim.revision }
                )
              ),
              lifetime.signal
            );
          }
          return { toolCallId: call.id, toolName: call.name, output, isError: false };
        } catch (error) {
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          if (lifetime.signal.aborted || normalizedError instanceof ToolExecutionTimeoutError) {
            throw normalizedError;
          }
          if (journalClaim) {
            try {
              if (lifetime.signal.aborted) throw abortError(lifetime.signal);
              await raceWithAbort(
                Promise.resolve(
                  agent.store!.completeToolExecution!(
                    {
                      ...journalClaim,
                      status: "failed",
                      error: { message: normalizedError.message },
                      completedAt: Date.now(),
                      updatedAt: Date.now()
                    },
                    { expectedRevision: journalClaim.revision }
                  )
                ),
                lifetime.signal
              );
            } catch {
              // Preserve the original tool error. A running journal entry blocks unsafe replay.
            }
          }
          return {
            toolCallId: call.id,
            toolName: call.name,
            error: { message: normalizedError.message },
            isError: true
          };
        }
      };

      let waitingForPostToolResponse = false;
      let postToolResponseObserved = false;
      let finalOutputTranscriptObserved = false;
      let terminalResponseCompletionObserved = false;
      const requiresFinalOutputTranscript = Boolean(realtimeConfig.outputAudioTranscription);
      const iterator = session.eventStream()[Symbol.asyncIterator]();
      let iteratorCompleted = false;
      try {
        while (true) {
          const next = await nextWithAbort(iterator, lifetime.signal);
          if (next.done) {
            iteratorCompleted = true;
            break;
          }
          const event = next.value;
          await publish(event);

        if (event.type === "realtime-text-delta") {
          assistantBuffer.push(event.textDelta);
          if (waitingForPostToolResponse) postToolResponseObserved = true;
          await publish({ type: "text-delta", textDelta: event.textDelta });
          continue;
        }

        if (event.type === "realtime-transcript") {
          if (event.role === "user" && event.isFinal && event.text) {
            transcript.push(createTextMessage("user", event.text));
          }
          if (event.role === "assistant") {
            if (event.text && waitingForPostToolResponse) postToolResponseObserved = true;
            if (event.isFinal) {
              finalOutputTranscriptObserved = true;
              const bufferedTranscript = outputTranscriptBuffer.join("");
              finalText = event.text.startsWith(bufferedTranscript)
                ? event.text
                : `${bufferedTranscript}${event.text}`;
              if (finalText) transcript.push(createTextMessage("assistant", finalText));
              assistantBuffer.length = 0;
              outputTranscriptBuffer.length = 0;
            } else if (requiresFinalOutputTranscript && event.text) {
              outputTranscriptBuffer.push(event.text);
            }
            if (
              requiresFinalOutputTranscript &&
              terminalResponseCompletionObserved &&
              finalOutputTranscriptObserved &&
              (!waitingForPostToolResponse || postToolResponseObserved)
            ) {
              break;
            }
          }
          continue;
        }

        if (event.type === "realtime-tool-call") {
          const serializedCallInput = serializeJsonValue(event.toolCall.input);
          const fingerprint = `${event.toolCall.name}:${canonicalJson(serializedCallInput)}`;
          const previous = processedToolCalls.get(event.toolCall.id);
          if (previous) {
            if (previous.fingerprint !== fingerprint) {
              throw new ConflictError(`Realtime tool call id "${event.toolCall.id}" was reused with a different payload.`);
            }
            continue;
          }
          await publish({ type: "tool-call", toolCall: event.toolCall });
          waitingForPostToolResponse = true;
          postToolResponseObserved = false;
          finalOutputTranscriptObserved = false;
          terminalResponseCompletionObserved = false;

          const definition = resolvedTools[event.toolCall.name];
          if (!definition) {
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              error: { message: `Tool "${event.toolCall.name}" is not registered.` },
              isError: true
            } satisfies ToolExecutionResult;
            await recordToolResult(result, fingerprint);
            continue;
          }

          if (!isCallableToolDefinition(definition)) {
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              error: { message: `Tool "${event.toolCall.name}" is provider-hosted and cannot be executed locally.` },
              isError: true
            } satisfies ToolExecutionResult;
            await recordToolResult(result, fingerprint);
            continue;
          }

          const parsed = definition.schema.safeParse(event.toolCall.input);
          if (!parsed.success) {
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              error: { message: `Invalid input for tool "${event.toolCall.name}": ${parsed.error.message}` },
              isError: true
            } satisfies ToolExecutionResult;
            await recordToolResult(result, fingerprint);
            continue;
          }

          const approval = await raceWithAbort(
            resolveApproval({
              agent,
              input,
              state,
              call: event.toolCall,
              parsedInput: serializeJsonValue(parsed.data),
              tool: definition,
              realtimeConfig
            }),
            lifetime.signal
          );
          if (approval.approvalRequired) {
            throw new ValidationError(
              `Tool "${event.toolCall.name}" requested resumable approval, but streamLiveAgent only supports immediate approval decisions.`
            );
          }
          if (!approval.approved) {
            const result = {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              error: {
                message: approval.reason ?? `Tool "${event.toolCall.name}" was denied by the approval policy.`
              },
              isError: true
            } satisfies ToolExecutionResult;
            await recordToolResult(result, fingerprint);
            continue;
          }

          const result = await executeTool(
            definition,
            event.toolCall,
            parsed.data,
            serializeJsonValue(parsed.data)
          );
          await recordToolResult(result, fingerprint);
          continue;
        }

        if (event.type === "realtime-error") {
          sessionError = event.error ?? new Error(event.message ?? "Realtime session failed.");
          continue;
        }

        if (event.type === "realtime-end" && event.reason === "error") {
          sessionError ??= new Error(
            typeof event.providerMetadata?.message === "string" ? event.providerMetadata.message : "Realtime session failed."
          );
        }

        if (event.type === "realtime-response-complete") {
          if (event.reason === "generation-complete") continue;
          if (waitingForPostToolResponse && !postToolResponseObserved) continue;
          terminalResponseCompletionObserved = true;
          if (requiresFinalOutputTranscript && !finalOutputTranscriptObserved) continue;
          break;
        }

          if (event.type === "realtime-end") {
            break;
          }
        }
      } finally {
        if (!iteratorCompleted && iterator.return) {
          const returned = Promise.resolve(iterator.return());
          if (lifetime.signal.aborted) void returned.catch(() => undefined);
          else await raceWithAbort(returned, lifetime.signal);
        }
      }

      if (sessionError) {
        throw sessionError;
      }
      if (waitingForPostToolResponse && !postToolResponseObserved) {
        throw new ValidationError("Realtime session ended before the response following a tool result was observed.");
      }
      if (
        requiresFinalOutputTranscript &&
        (!terminalResponseCompletionObserved || !finalOutputTranscriptObserved)
      ) {
        throw new ValidationError(
          "Realtime session ended before both response completion and final output transcription were observed."
        );
      }

      await closeSession();

      if (assistantBuffer.length && !finalText) {
        finalText = assistantBuffer.join("");
        if (finalText) {
          transcript.push(createTextMessage("assistant", finalText));
        }
      } else if (outputTranscriptBuffer.length && !finalText) {
        finalText = outputTranscriptBuffer.join("");
        transcript.push(createTextMessage("assistant", finalText));
      }

      const completedState = state;
      completedState.messages = transcript;
      completedState.toolResults = toolResults;
      completedState.outputText = finalText;
      completedState.status = "completed";
      completedState.updatedAt = Date.now();
      completedState.error = undefined;

      const result = createResult(completedState);
      const outputGuardrail = await runGuardrails(
        agent,
        completedState,
        "output",
        agent.outputGuardrails as AgentOutputGuardrail[] | undefined,
        () => ({
          runId: completedState.runId,
          agentId: completedState.agentId,
          state: cloneState(completedState),
          output: result,
          metadata: completedState.metadata
        }),
        lifetime.signal
      );
      const finalState = outputGuardrail
        ? applyGuardrailFailure(completedState, "output", outputGuardrail)
        : completedState;
      if (outputGuardrail) {
        await publish({
          type: "error",
          error: new GuardrailTriggeredError("output", finalState.error?.message ?? "Agent output guardrail triggered.", {
            metadata: outputGuardrail.metadata
          })
        });
      }

      await persistState(agent, finalState, lifetime.signal);
      await emitRunFinishTelemetry(agent, finalState, lifetime.signal);
      await publish({ type: "agent-run-finish", status: finalState.status, state: cloneState(finalState) });
      return createResult(finalState);
    } catch (error) {
      runError = error;
      failureCleanupRan = true;
      rejectNoSession(error);
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      if (state) {
        state.messages = transcript.length ? transcript : state.messages;
        state.toolResults = toolResults;
        const status: AgentStatus = lifetime.signal.aborted
          ? lifetime.signal.reason instanceof LiveAgentTimeoutError
            ? "timed_out"
            : "cancelled"
          : "failed";
        state = {
          ...state,
          status,
          error: { message: normalizedError.message },
          ...(status === "cancelled"
            ? { cancelledAt: Date.now(), cancellationReason: normalizedError.message }
            : {}),
          updatedAt: Date.now()
        };
        await runTerminalFailureCleanup([
          (cleanupSignal) => persistState(agent, state!, cleanupSignal),
          (cleanupSignal) => emitRunFinishTelemetry(agent, state!, cleanupSignal),
          () => closeSession()
        ]);
        try {
          await publish({ type: "error", error: normalizedError });
          await publish({ type: "agent-run-finish", status: state.status, state: cloneState(state) });
        } catch {
          // The original failure remains authoritative if the event broadcast also failed.
        }
      } else {
        await runTerminalFailureCleanup([() => closeSession()]);
        try {
          await publish({ type: "error", error: normalizedError });
        } catch {
          // The original failure remains authoritative if the event broadcast also failed.
        }
      }
      throw error;
    } finally {
      lifetime.signal.removeEventListener("abort", abortSession);
      lifetime.cleanup();
      if (!failureCleanupRan) {
        try {
          await closeSession();
        } catch (closeError) {
          if (!runError) runError = closeError;
        }
      }
      if (!sessionSettled) {
        rejectNoSession(runError ?? new ValidationError(`Live agent run "${runId}" ended without a realtime session.`));
      }
      broadcast.close();
    }
  })();
  void runner.catch(() => undefined);

  return {
    eventStream: broadcast.stream(),
    textStream: (async function* () {
      for await (const event of broadcast.stream((candidate) => candidate.type === "text-delta")) {
        if (event.type === "text-delta") yield event.textDelta;
      }
    })(),
    session: sessionPromise,
    collect: () => runner
  };
};
