import { createHash } from "node:crypto";

import { createAgentApprovalMessage, getAgentApprovalRequests } from "./agent-approval.js";
import { createAgentHandoffMessage } from "./agent-handoff.js";
import { AGENT_RUN_STATE_SCHEMA_VERSION, normalizeAgentRunState } from "./agent-state.js";
import { BoundedReplayBroadcast } from "./bounded-broadcast.js";
import { ConflictError, GuardrailTriggeredError, ValidationError } from "./errors.js";
import { aggregateTokenUsage, generateText, getGenerateTextStepTiming, normalizeMessages, streamText } from "./generate-text.js";
import { isCallableToolDefinition, serializeJsonValue } from "./messages.js";
import { mergeAbortSignals } from "./runtime.js";
import { evaluateAgentBudgetPreflight, getAgentBudgetStatus } from "./safety-policy.js";
import { createSecureId } from "./secure-id.js";
import { toToolSet } from "./tool-registry.js";
import { z } from "zod";
import type {
  AgentChildRun,
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentDefinition,
  AgentGroupMember,
  AgentGroupRunInput,
  AgentGroupRunOutput,
  AgentGuardrailTrigger,
  AgentInputGuardrail,
  AgentOutputGuardrail,
  AgentRunCancellationOptions,
  AgentRunInput,
  AgentRunOutput,
  AgentRunState,
  AgentRunPolicy,
  AgentRunStore,
  AgentRunTreeCancellationResult,
  AgentStep,
  AgentStepRequest,
  AgentStepResponse,
  AgentStatus,
  AgentStreamEvent,
  AgentStreamResult,
  AgentTelemetryEvent,
  AgentToolCallJournalEntry,
  CreateSubAgentToolOptions,
  GenerateTextOptions,
  GenerateTextOutput,
  GenerateTextStep,
  JsonValue,
  LanguageModel,
  ModelGenerateInput,
  ModelMessage,
  PrepareSubagentsForAgentOptions,
  ProviderOptions,
  SubAgentToolInput,
  SubAgentToolOutput,
  ToolApprovalDecision,
  ToolApprovalEvent,
  ToolDefinition,
  ToolExecutionResult
} from "./types.js";

const randomId = createSecureId;
const AGENT_GROUP_FAIL_FAST_ABORT_MESSAGE = "Agent group member aborted after fail-fast.";
const DEFAULT_AGENT_LEASE_TTL_MS = 30_000;
const DEFAULT_AGENT_CANCELLATION_POLL_MS = 1_000;
const DEFAULT_AGENT_MAX_STATE_BYTES = 4 * 1024 * 1024;

class AgentPolicyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent run timed out after ${timeoutMs}ms.`);
    this.name = "AgentPolicyTimeoutError";
  }
}

const joinInstructions = (...parts: Array<string | undefined>): string | undefined => {
  const content = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return content.length ? content.join("\n\n") : undefined;
};

const hasToolCalls = (messages: ModelMessage[]): boolean =>
  messages.some((message) => message.parts.some((part) => part.type === "tool-call"));

const snapshotRequest = (
  request: ModelGenerateInput,
  messageOffset = 0,
  messages: ModelMessage[] = request.messages
): AgentStepRequest => ({
  messageOffset,
  messages,
  toolChoice: request.toolChoice,
  toolExecution: request.toolExecution,
  temperature: request.temperature,
  maxTokens: request.maxTokens,
  reasoning: request.reasoning,
  providerOptions: request.providerOptions as ProviderOptions | undefined,
  timeoutMs: request.timeoutMs,
  maxRetries: request.maxRetries,
  retryBackoffMs: request.retryBackoffMs
});

const snapshotResponse = (response: GenerateTextStep["response"]): AgentStepResponse => ({
  messages: response.messages ?? (response.message ? [response.message] : []),
  text: response.text,
  finishReason: response.finishReason,
  providerFinishReason: response.providerFinishReason,
  usage: response.usage
});

const countToolCalls = (messages: ModelMessage[]): number =>
  messages.reduce(
    (total, message) => total + message.parts.filter((part) => part.type === "tool-call").length,
    0
  );

const mapSteps = (steps: GenerateTextStep[], offset: number, toolResults: ToolExecutionResult[]): AgentStep[] => {
  let toolResultCursor = 0;
  let previousMessageCount = 0;

  return steps.map((step, index) => {
    const response = snapshotResponse(step.response);
    const toolCallCount = countToolCalls(response.messages);
    const stepToolResults = toolResults.slice(toolResultCursor, toolResultCursor + toolCallCount);
    toolResultCursor += toolCallCount;
    const timing = getGenerateTextStepTiming(step.request);
    const finishedAt = timing?.finishedAt ?? Date.now();
    const messageOffset = index === 0 ? 0 : previousMessageCount;
    const incrementalMessages = step.request.messages.slice(messageOffset);
    previousMessageCount = step.request.messages.length;

    return {
      index: offset + index + 1,
      status: "completed",
      startedAt: timing?.startedAt ?? finishedAt,
      finishedAt,
      request: snapshotRequest(step.request, messageOffset, incrementalMessages),
      response,
      toolResults: stepToolResults
    };
  });
};

const cloneMetadata = (...values: Array<Record<string, JsonValue> | undefined>) => {
  const merged = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
};

const toOutput = (state: AgentRunState): AgentRunOutput => ({
  status: state.status,
  outputText: state.outputText,
  finishReason: state.finishReason,
  providerFinishReason: state.providerFinishReason,
  usage: state.usage,
  messages: state.messages,
  steps: state.steps,
  toolResults: state.toolResults,
  state,
  error: state.error
});

const normalizeApprovalStatus = (status: AgentStatus): AgentStatus =>
  status === "suspended" ? "waiting_approval" : status;

const cloneState = (state: AgentRunState): AgentRunState =>
  JSON.parse(JSON.stringify(normalizeAgentRunState(state))) as AgentRunState;

const createBaseState = (
  provider: string,
  modelId: string,
  initialMessages: ModelMessage[],
  maxSteps: number,
  metadata: Record<string, JsonValue> | undefined,
  agentId: string | undefined,
  runId: string,
  handoff: AgentRunInput["handoff"],
  parentRunId: string | undefined,
  idempotencyKey: string | undefined,
  scope: AgentRunInput["scope"]
): AgentRunState => {
  const startedAt = Date.now();

  return {
    schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION,
    revision: 0,
    runId,
    scope,
    idempotencyKey,
    agentId,
    parentRunId: parentRunId ?? handoff?.fromRunId,
    provider,
    modelId,
    status: "running",
    messages: initialMessages,
    steps: [],
    toolResults: [],
    currentStep: 0,
    maxSteps,
    outputText: "",
    pendingApprovals: [],
    metadata,
    handoff,
    startedAt,
    updatedAt: startedAt
  };
};

const ensureValidStateInput = (input: AgentRunInput) => {
  if (input.approvals?.length && !input.state) {
    throw new ValidationError('The "approvals" option requires an existing agent "state".');
  }

  if (!input.state) {
    return;
  }

  if (input.prompt !== undefined || input.messages !== undefined || input.system !== undefined || input.handoff !== undefined) {
    throw new ValidationError('Pass either "state" or a fresh "prompt"/"messages" input, but not both.');
  }

  const stateScope = input.state?.scope;
  const inputScope = input.scope;
  if (
    stateScope &&
    inputScope &&
    (stateScope.tenantId !== inputScope.tenantId ||
      stateScope.userId !== inputScope.userId ||
      stateScope.namespace !== inputScope.namespace)
  ) {
    throw new ValidationError('The provided agent state belongs to a different tenant/user scope.');
  }
};

const ensureValidIdempotencyInput = (input: AgentRunInput, store: AgentRunStore | undefined) => {
  if (!input.idempotencyKey) {
    return;
  }

  if (!store) {
    throw new ValidationError('The "idempotencyKey" option requires an agent run "store".');
  }

  if (!store.claimIdempotencyKey) {
    throw new ValidationError('The agent run "store" must implement "claimIdempotencyKey()" to use "idempotencyKey" safely.');
  }
};

const ensureValidScope = (scope: AgentRunInput["scope"]) => {
  if (!scope) return;
  if (typeof scope.tenantId !== "string" || scope.tenantId.length === 0) {
    throw new ValidationError('Agent scope "tenantId" must be a non-empty string.');
  }
  for (const field of ["userId", "namespace"] as const) {
    if (scope[field] !== undefined && (typeof scope[field] !== "string" || scope[field]!.length === 0)) {
      throw new ValidationError(`Agent scope "${field}" must be a non-empty string when provided.`);
    }
  }
};

const invokeOperationalHook = async <TModel extends LanguageModel, TResult>(
  agent: AgentDefinition<TModel>,
  source: "telemetry" | "memory",
  operation: string,
  runId: string | undefined,
  callback: (() => TResult | Promise<TResult>) | undefined,
  fallback: TResult
): Promise<TResult> => {
  if (!callback) {
    return fallback;
  }

  try {
    return await callback();
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    try {
      await agent.hookFailurePolicy?.onError?.({
        source,
        operation,
        runId,
        error: normalizedError
      });
    } catch {
      // Reporting an observer failure must never recursively fail the run.
    }
    if (agent.hookFailurePolicy?.[source] === "fail") {
      throw normalizedError;
    }
    return fallback;
  }
};

const injectContextMessages = (messages: ModelMessage[], extraMessages: ModelMessage[]): ModelMessage[] => {
  if (!extraMessages.length) {
    return messages;
  }

  if (messages[0]?.role === "system") {
    return [messages[0], ...extraMessages, ...messages.slice(1)];
  }

  return [...extraMessages, ...messages];
};

const prepareFreshMessages = async <TModel extends AgentDefinition["model"]>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>,
  runId: string
): Promise<{ messages: ModelMessage[]; memoryMessages: ModelMessage[] }> => {
  let messages = normalizeMessages({
    prompt: input.prompt,
    messages: input.messages,
    system: joinInstructions(agent.instructions, input.system)
  });

  const handoffMessages = input.handoff
    ? [createAgentHandoffMessage(input.handoff), ...input.handoff.contextMessages.filter((message) => message.role !== "system")]
    : [];
  messages = injectContextMessages(messages, handoffMessages);

  const memoryMessages = await invokeOperationalHook(
    agent,
    "memory",
    "load",
    runId,
    agent.memory
      ? () => agent.memory!.load({
        runId,
        agentId: agent.id,
        scope: input.scope ?? input.handoff?.scope,
        metadata: cloneMetadata(agent.metadata, input.metadata)
      })
      : undefined,
    [] as ModelMessage[]
  );

  messages = injectContextMessages(messages, memoryMessages);

  return {
    messages,
    memoryMessages
  };
};

const applyApprovalResponses = (
  messages: ModelMessage[],
  approvals: AgentApprovalResponse[] | undefined,
  pendingApprovals: AgentRunState["pendingApprovals"]
) => {
  if (!approvals?.length) {
    return {
      messages,
      pendingApprovals
    };
  }

  const pendingById = new Map(pendingApprovals.map((approval) => [approval.id, approval]));
  for (const approval of approvals) {
    const pending = pendingById.get(approval.approvalRequestId);
    if (!pending) {
      throw new ValidationError(`Unknown approval request "${approval.approvalRequestId}".`);
    }

    if (pending.provider !== approval.provider) {
      throw new ValidationError(
        `Approval request "${approval.approvalRequestId}" belongs to provider "${pending.provider}", not "${approval.provider}".`
      );
    }
  }

  return {
    messages: [...messages, createAgentApprovalMessage(approvals)],
    pendingApprovals: pendingApprovals.filter(
      (pending) => !approvals.some((approval) => approval.approvalRequestId === pending.id)
    )
  };
};

const finalizeState = (
  state: AgentRunState,
  result: GenerateTextOutput,
  newSteps: AgentStep[],
  newToolResults: ToolExecutionResult[]
): AgentRunOutput => {
  const nextCurrentStep = state.currentStep + newSteps.length;
  const exhausted = nextCurrentStep >= state.maxSteps;
  const lastStep = newSteps.at(-1);
  const unresolvedToolCalls = lastStep?.response ? hasToolCalls(lastStep.response.messages) : false;
  const pendingApprovals = getAgentApprovalRequests(newSteps.flatMap((step) => step.response?.messages ?? []));

  if (pendingApprovals.length) {
    state.status = "waiting_approval";
    state.error = undefined;
    if (lastStep) {
      lastStep.status = "waiting_approval";
    }
  } else if (exhausted && unresolvedToolCalls) {
    state.status = "failed";
    state.error = {
      message: "Agent exhausted maxSteps before reaching a terminal response."
    };
    if (lastStep) {
      lastStep.status = "failed";
      lastStep.error = state.error;
    }
  } else {
    state.status = "completed";
    state.error = undefined;
  }

  state.messages = result.messages;
  state.steps = [...state.steps, ...newSteps];
  state.toolResults = [...state.toolResults, ...newToolResults];
  state.currentStep = nextCurrentStep;
  state.outputText = result.text;
  state.finishReason = result.finishReason;
  state.providerFinishReason = result.providerFinishReason;
  state.usage = aggregateTokenUsage([state.usage, result.usage]);
  state.pendingApprovals = pendingApprovals;
  state.updatedAt = Date.now();

  return toOutput(state);
};

const emitTelemetryEvent = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  event: AgentTelemetryEvent
) => {
  await invokeOperationalHook(
    agent,
    "telemetry",
    event.type,
    event.runId,
    agent.onTelemetryEvent ? () => agent.onTelemetryEvent!(event) : undefined,
    undefined
  );
};

const subAgentToolInputSchema = z.object({
  prompt: z.string().min(1),
  system: z.string().optional()
});

const defaultSubAgentToolName = (agent: AgentDefinition): string => {
  const id = agent.id ?? `${agent.model.provider}_${agent.model.modelId}`;
  return `subagent_${id.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "agent"}`;
};

const countToolCallsInSteps = (steps: AgentStep[]): number =>
  steps.reduce((total, step) => total + countToolCalls(step.response?.messages ?? []), 0);

const countToolErrors = (toolResults: ToolExecutionResult[]): number =>
  toolResults.filter((result) => result.isError).length;

export const createSubAgentTool = <TModel extends LanguageModel>(
  options: CreateSubAgentToolOptions<TModel>
): ToolDefinition<typeof subAgentToolInputSchema, SubAgentToolOutput> => {
  const toolName = options.toolName ?? options.name ?? defaultSubAgentToolName(options.agent);
  const metadata: Record<string, JsonValue> = {
    type: "subagent"
  };
  if (options.agent.id) {
    metadata.childAgentId = options.agent.id;
  }
  if (options.parentRunId) {
    metadata.parentRunId = options.parentRunId;
  }
  if (options.parentAgentId) {
    metadata.parentAgentId = options.parentAgentId;
  }

  return {
    name: toolName,
    description:
      options.description ??
      `Delegate the task to ${options.agent.id ? `subagent "${options.agent.id}"` : "a subagent"} and return its result.`,
    schema: subAgentToolInputSchema,
    requiresApproval: options.requiresApproval,
    metadata: cloneMetadata(metadata, options.metadata),
    execute: async (input: SubAgentToolInput) => {
      await options.onStart?.({
        toolName,
        childAgentId: options.agent.id,
        parentRunId: options.parentRunId
      });
      const childMetadata: Record<string, JsonValue> = {
        subagentToolName: toolName
      };
      if (options.parentRunId) {
        childMetadata.parentRunId = options.parentRunId;
      }
      if (options.parentAgentId) {
        childMetadata.parentAgentId = options.parentAgentId;
      }
      const output = await runAgent(options.agent, {
        prompt: input.prompt,
        system: joinInstructions(options.system, input.system),
        parentRunId: options.parentRunId,
        scope: options.scope,
        maxSteps: options.maxSteps,
        metadata: cloneMetadata(options.metadata, childMetadata)
      });
      const childRun: AgentChildRun = {
        runId: output.state.runId,
        status: output.status,
        outputText: output.outputText,
        steps: output.state.currentStep,
        toolCalls: countToolCallsInSteps(output.steps),
        toolErrors: countToolErrors(output.toolResults)
      };
      if (output.state.agentId) {
        childRun.agentId = output.state.agentId;
      }
      if (options.parentRunId) {
        childRun.parentRunId = options.parentRunId;
      }
      childRun.toolName = toolName;
      if (output.usage) {
        childRun.usage = output.usage;
      }
      if (output.state.startedAt !== undefined) {
        childRun.startedAt = output.state.startedAt;
      }
      if (output.state.updatedAt !== undefined) {
        childRun.updatedAt = output.state.updatedAt;
      }
      if (output.error) {
        childRun.error = output.error;
      }
      if (output.state.metadata) {
        childRun.metadata = output.state.metadata;
      }
      await options.onFinish?.(childRun);
      return serializeJsonValue(childRun) as SubAgentToolOutput;
    }
  };
};

const saveStateWithRevision = async (store: AgentRunStore, state: AgentRunState) => {
  const expectedRevision = state.revision ?? 0;
  const nextRevision = expectedRevision + 1;
  const nextState = { ...state, revision: nextRevision } satisfies AgentRunState;
  await store.save(cloneState(nextState), { expectedRevision });
  state.revision = nextRevision;
};

const claimAgentExecution = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState
) => {
  state.status = "running";
  state.updatedAt = Date.now();
  assertStateSize(agent, state);
  if (agent.store) {
    await saveStateWithRevision(agent.store, state);
  }
};

const assertStateSize = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  policy?: AgentRunPolicy
) => {
  const limit = policy?.maxStateBytes ?? agent.policy?.maxStateBytes ?? DEFAULT_AGENT_MAX_STATE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ValidationError('Agent policy "maxStateBytes" must be a positive integer.');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (bytes > limit) {
    throw new ValidationError(
      `Agent run state is ${bytes} bytes and exceeds maxStateBytes=${limit}. Offload large tool outputs to artifacts or raise the explicit limit.`
    );
  }
};

const persistState = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  policy?: AgentRunPolicy
) => {
  state.updatedAt = Date.now();
  assertStateSize(agent, state, policy);
  if (agent.store) {
    await saveStateWithRevision(agent.store, state);
  }
  await emitTelemetryEvent(agent, {
    type: "state-saved",
    runId: state.runId,
    agentId: state.agentId,
    status: state.status
  });
  await invokeOperationalHook(
    agent,
    "memory",
    "save",
    state.runId,
    agent.memory?.save
      ? () => agent.memory!.save!({
          runId: state.runId,
          agentId: state.agentId,
          scope: state.scope,
          state: cloneState(state),
          metadata: state.metadata
        })
      : undefined,
    undefined
  );
};

const approvalsFromEvents = (messages: ModelMessage[]): AgentApprovalRequest[] => getAgentApprovalRequests(messages);

const emitFinalizedStepTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  steps: AgentStep[]
) => {
  for (const step of steps) {
    await emitTelemetryEvent(agent, {
      type: "step-finish",
      runId: state.runId,
      agentId: state.agentId,
      step
    });
  }
};

const emitApprovalTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  approvals: AgentApprovalRequest[]
) => {
  for (const approval of approvals) {
    await emitTelemetryEvent(agent, {
      type: "approval-request",
      runId: state.runId,
      agentId: state.agentId,
      approval
    });
  }
};

const emitToolApprovalTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  event: ToolApprovalEvent
) => {
  await emitTelemetryEvent(agent, {
    type: "tool-approval",
    runId: state.runId,
    agentId: state.agentId,
    toolCall: event.request.toolCall,
    approved: event.decision.approved,
    reason: event.decision.reason,
    metadata: event.decision.metadata
  });
};

const normalizeGuardrailTrigger = (value: AgentGuardrailTrigger | void): AgentGuardrailTrigger | undefined =>
  value?.triggered ? value : undefined;

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

const runGuardrails = async <TModel extends LanguageModel, TRequest>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  stage: "input" | "output",
  guardrails: ReadonlyArray<((request: TRequest) => AgentGuardrailTrigger | void | Promise<AgentGuardrailTrigger | void>)> | undefined,
  requestFactory: (index: number) => TRequest
): Promise<AgentGuardrailTrigger | undefined> => {
  for (const [index, guardrail] of (guardrails ?? []).entries()) {
    const trigger = normalizeGuardrailTrigger(await guardrail(requestFactory(index)));
    if (!trigger) {
      continue;
    }

    await emitTelemetryEvent(agent, {
      type: "guardrail-triggered",
      runId: state.runId,
      agentId: state.agentId,
      stage,
      reason: trigger.reason ?? `Agent ${stage} guardrail #${index + 1} triggered.`,
      metadata: trigger.metadata
    });
    return trigger;
  }

  return undefined;
};

const resolveContext = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>
) => {
  ensureValidIdempotencyInput(input, agent.store);
  const inputScope = input.scope ?? input.handoff?.scope;
  ensureValidScope(inputScope);

  let loadedState = input.state ? normalizeAgentRunState(input.state) : undefined;
  let loadedByIdempotencyKey = false;
  if (!loadedState && input.runId && agent.store) {
    loadedState = await agent.store.load(input.runId, inputScope);
    if (loadedState) {
      loadedState = normalizeAgentRunState(loadedState);
    }
  }

  if (!loadedState && input.idempotencyKey) {
    const runId = input.runId ?? randomId("run");
    const maxSteps = Math.max(1, input.maxSteps ?? agent.maxSteps ?? 1);
    const metadata = cloneMetadata(agent.metadata, input.metadata, input.handoff?.metadata);
    const prepared = await prepareFreshMessages(agent, input, runId);
    const candidate = createBaseState(
      agent.model.provider,
      agent.model.modelId,
      prepared.messages,
      maxSteps,
      metadata,
      agent.id,
      runId,
      input.handoff,
      input.parentRunId,
      input.idempotencyKey,
      inputScope
    ) as AgentRunState & { idempotencyKey: string };
    const claim = await agent.store!.claimIdempotencyKey!(candidate);
    if (claim.claimed) {
      return {
        state: normalizeAgentRunState(claim.state),
        messages: prepared.messages,
        remainingSteps: maxSteps,
        memoryMessages: prepared.memoryMessages,
        fresh: true
      };
    }
    loadedState = normalizeAgentRunState(claim.state);
    loadedByIdempotencyKey = true;
  }

  const normalizedInput =
    loadedState && loadedByIdempotencyKey
      ? { ...input, prompt: undefined, messages: undefined, system: undefined, handoff: undefined, state: loadedState }
      : loadedState
        ? { ...input, state: loadedState }
        : input;
  ensureValidStateInput(normalizedInput);

  const metadata = cloneMetadata(agent.metadata, loadedState?.metadata, input.metadata, input.handoff?.metadata);
  if (loadedState) {
    const maxSteps = input.maxSteps ?? loadedState.maxSteps;
    const resumed = applyApprovalResponses(loadedState.messages, input.approvals, loadedState.pendingApprovals);

    return {
      state: {
        ...loadedState,
        schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION,
        idempotencyKey: loadedState.idempotencyKey ?? input.idempotencyKey,
        scope: loadedState.scope ?? inputScope,
        agentId: loadedState.agentId ?? agent.id,
        parentRunId: loadedState.parentRunId ?? input.parentRunId,
        provider: agent.model.provider,
        modelId: agent.model.modelId,
        maxSteps,
        messages: resumed.messages,
        pendingApprovals: resumed.pendingApprovals,
        metadata,
        updatedAt: Date.now()
      } satisfies AgentRunState,
      messages: resumed.messages,
      remainingSteps: Math.max(0, maxSteps - loadedState.currentStep),
      memoryMessages: [] as ModelMessage[],
      fresh: false
    };
  }

  const runId = input.runId ?? randomId("run");
  const maxSteps = Math.max(1, input.maxSteps ?? agent.maxSteps ?? 1);
  const prepared = await prepareFreshMessages(agent, input, runId);

  return {
    state: createBaseState(
      agent.model.provider,
      agent.model.modelId,
      prepared.messages,
      maxSteps,
      metadata,
      agent.id,
      runId,
      input.handoff,
      input.parentRunId,
      input.idempotencyKey,
      inputScope
    ),
    messages: prepared.messages,
    remainingSteps: maxSteps,
    memoryMessages: prepared.memoryMessages,
    fresh: true
  };
};

const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
};

const durableToolCallId = (
  runId: string,
  step: number,
  providerToolCallId: string,
  toolName: string,
  input: JsonValue
): string =>
  `tool_${createHash("sha256")
    .update(`${runId}\0${step}\0${providerToolCallId}\0${toolName}\0${canonicalJson(input)}`)
    .digest("hex")}`;

const wrapToolWithJournal = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  tool: ToolDefinition
): ToolDefinition => {
  const store = agent.store;
  if (!store?.claimToolExecution || !store.loadToolExecution || !store.completeToolExecution) {
    return tool;
  }

  return {
    ...tool,
    execute: async (input, context) => {
      if (!context) {
        throw new ValidationError(`Durable tool "${tool.name}" requires an execution context.`);
      }
      const serializedInput = serializeJsonValue(input);
      const step = context.step;
      const toolCallId = durableToolCallId(state.runId, step, context.toolCall.id, tool.name, serializedInput);
      const idempotencyKey = `${state.runId}:${toolCallId}`;
      const now = Date.now();
      const candidate = {
        runId: state.runId,
        scope: state.scope,
        toolCallId,
        toolName: tool.name,
        status: "pending",
        idempotencyKey,
        revision: 0,
        input: serializedInput,
        updatedAt: now
      } satisfies AgentToolCallJournalEntry;
      const claim = await store.claimToolExecution!(candidate);

      if (!claim.claimed) {
        if (claim.entry.status === "completed") {
          return claim.entry.output ?? null;
        }
        if (claim.entry.status === "failed") {
          throw new Error(claim.entry.error?.message ?? `Tool "${tool.name}" previously failed.`);
        }
        throw new ConflictError(
          `Tool "${tool.name}" has an indeterminate durable execution. Reconcile idempotency key "${claim.entry.idempotencyKey}" before retrying.`
        );
      }

      try {
        const output = serializeJsonValue(
          await tool.execute(input, {
            ...context,
            runId: state.runId,
            idempotencyKey
          })
        );
        await store.completeToolExecution!(
          {
            ...claim.entry,
            status: "completed",
            output,
            completedAt: Date.now(),
            updatedAt: Date.now()
          },
          { expectedRevision: claim.entry.revision }
        );
        return output;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        try {
          await store.completeToolExecution!(
            {
              ...claim.entry,
              status: "failed",
              error: { message: normalizedError.message },
              completedAt: Date.now(),
              updatedAt: Date.now()
            },
            { expectedRevision: claim.entry.revision }
          );
        } catch {
          // The original error is more useful; a running journal row blocks unsafe replay.
        }
        throw normalizedError;
      }
    }
  };
};

const createGenerateOptions = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  input: AgentRunInput<TModel>,
  messages: ModelMessage[],
  maxSteps: number,
  abortSignal: AbortSignal | undefined = input.abortSignal
): GenerateTextOptions<TModel> => {
  const tools = { ...(toToolSet(input.tools ?? agent.tools) ?? {}) };
  for (const subagent of agent.subagents ?? []) {
    const subagentTool = createSubAgentTool({
      ...subagent,
      parentRunId: state.runId,
      parentAgentId: state.agentId,
      scope: state.scope,
      onStart: async ({ toolName, childAgentId }) => {
        await emitTelemetryEvent(agent, {
          type: "subagent-start",
          runId: state.runId,
          agentId: state.agentId,
          childAgentId,
          toolName
        });
      },
      onFinish: async (childRun) => {
        state.childRuns = [...(state.childRuns ?? []), childRun];
        await emitTelemetryEvent(agent, {
          type: "subagent-finish",
          runId: state.runId,
          agentId: state.agentId,
          childRun
        });
      }
    });
    if (tools[subagentTool.name]) {
      throw new ValidationError(`Subagent tool "${subagentTool.name}" conflicts with an existing tool.`);
    }
    tools[subagentTool.name] = subagentTool;
  }
  for (const [name, tool] of Object.entries(tools)) {
    if (isCallableToolDefinition(tool)) {
      tools[name] = wrapToolWithJournal(agent, state, tool);
    }
  }
  const finalTools = Object.keys(tools).length ? tools : undefined;
  const budget = input.policy?.budget ?? agent.policy?.budget;
  const runPolicy = resolveRunPolicy(agent, input);
  let checkpointState = cloneState(state);
  let reservedToolCalls = 0;
  const requestedMaxTokens = input.maxTokens ?? agent.maxTokens;
  const budgetStatus = budget ? getAgentBudgetStatus(state, budget) : undefined;
  const tokenCeilings = [
    requestedMaxTokens,
    budgetStatus?.remaining.outputTokens,
    budgetStatus?.remaining.totalTokens
  ].filter((value): value is number => value !== undefined);
  const maxTokens = tokenCeilings.length ? Math.min(...tokenCeilings) : undefined;

  return {
    model: agent.model,
    messages,
    tools: finalTools,
    toolChoice: input.toolChoice,
    toolExecution: input.toolExecution ?? agent.toolExecution,
    toolApprovalPolicy: input.toolApprovalPolicy ?? agent.toolApprovalPolicy,
    onToolApprovalDecision: async (event) => {
      await emitToolApprovalTelemetry(agent, state, event);
    },
    onBeforeModelStep: ({ step }) => {
      if (!budget) return;
      const trigger = evaluateAgentBudgetPreflight(state, budget, {
        operation: "model",
        requiredSteps: Math.max(1, step - state.currentStep),
        requestedOutputTokens: maxTokens
      });
      if (trigger) {
        throw new GuardrailTriggeredError("input", trigger.reason ?? "Agent model budget preflight failed.", {
          metadata: trigger.metadata
        });
      }
    },
    onModelStep: async ({ request, response, step, toolCalls }) => {
      if (!agent.store) return;
      const responseSnapshot = snapshotResponse(response);
      const approvals = getAgentApprovalRequests(responseSnapshot.messages);
      const requestOffset = Math.min(checkpointState.messages.length, request.messages.length);
      const timing = getGenerateTextStepTiming(request);
      const finishedAt = timing?.finishedAt ?? Date.now();
      const checkpointStep = {
        index: step,
        status: approvals.length ? "waiting_approval" : "completed",
        startedAt: timing?.startedAt ?? finishedAt,
        finishedAt,
        request: snapshotRequest(request, requestOffset, request.messages.slice(requestOffset)),
        response: responseSnapshot,
        toolResults: []
      } satisfies AgentStep;
      checkpointState = {
        ...checkpointState,
        status: approvals.length ? "waiting_approval" : toolCalls.length ? "running" : "completed",
        messages: [...request.messages, ...responseSnapshot.messages],
        steps: [...checkpointState.steps.filter((existing) => existing.index !== step), checkpointStep],
        currentStep: step,
        outputText: response.text ?? checkpointState.outputText,
        finishReason: response.finishReason,
        providerFinishReason: response.providerFinishReason,
        usage: aggregateTokenUsage([checkpointState.usage, response.usage]),
        pendingApprovals: approvals,
        error: undefined,
        updatedAt: Date.now()
      };
      await persistState(agent, checkpointState, runPolicy);
      state.revision = checkpointState.revision;
    },
    onToolExecutionComplete: async ({ toolResults }) => {
      if (!agent.store) return;
      const lastStep = checkpointState.steps.at(-1);
      if (lastStep) {
        lastStep.toolResults = [...lastStep.toolResults, ...toolResults];
      }
      checkpointState = {
        ...checkpointState,
        status: "running",
        messages: [
          ...checkpointState.messages,
          ...toolResults.map((toolResult) => ({
            role: "tool" as const,
            parts: [{ type: "tool-result" as const, toolResult }]
          }))
        ],
        toolResults: [...checkpointState.toolResults, ...toolResults],
        updatedAt: Date.now()
      };
      await persistState(agent, checkpointState, runPolicy);
      state.revision = checkpointState.revision;
    },
    stepOffset: state.currentStep,
    onBeforeToolExecution: ({ toolCalls }) => {
      if (!budget) return;
      reservedToolCalls += toolCalls.length;
      const trigger = evaluateAgentBudgetPreflight(state, budget, {
        operation: "tool",
        requiredToolCalls: reservedToolCalls
      });
      if (trigger) {
        throw new GuardrailTriggeredError("input", trigger.reason ?? "Agent tool budget preflight failed.", {
          metadata: trigger.metadata
        });
      }
    },
    maxSteps,
    temperature: input.temperature ?? agent.temperature,
    maxTokens,
    reasoning: input.reasoning ?? agent.reasoning,
    providerOptions: input.providerOptions ?? agent.providerOptions,
    abortSignal,
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries,
    retryBackoffMs: input.retryBackoffMs
  };
};

const emptyAsyncIterable = async function* () {
  return;
};

const createFailedState = (state: AgentRunState, message: string): AgentRunState => ({
  ...state,
  status: "failed",
  error: {
    message
  },
  updatedAt: Date.now()
});

const createTerminalState = (
  state: AgentRunState,
  status: Extract<AgentStatus, "cancel_requested" | "timed_out">,
  message: string
): AgentRunState => ({
  ...state,
  status,
  error: {
    message
  },
  cancellationReason: status === "cancel_requested" ? message : state.cancellationReason,
  cancelledAt: status === "cancel_requested" ? Date.now() : state.cancelledAt,
  updatedAt: Date.now()
});

const resolveRunPolicy = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel>
): AgentRunPolicy | undefined => {
  const policy = {
    ...(agent.policy ?? {}),
    ...(input.policy ?? {})
  };
  return Object.keys(policy).length ? policy : undefined;
};

const withAgentPolicyTimeout = async <T>(
  operation: Promise<T>,
  timeout: {
    signal?: AbortSignal;
    timeoutPromise?: Promise<never>;
    cleanup: () => void;
    isTimedOut: () => boolean;
  }
): Promise<T> => {
  if (!timeout.timeoutPromise) {
    return operation;
  }

  try {
    return await Promise.race([operation, timeout.timeoutPromise]);
  } finally {
    timeout.cleanup();
  }
};

const createAgentAbortContext = (
  inputAbortSignal: AbortSignal | undefined,
  policy: AgentRunPolicy | undefined
) => {
  if (!policy?.timeoutMs) {
    return {
      signal: inputAbortSignal,
      timeoutPromise: undefined,
      cleanup: () => undefined,
      isTimedOut: () => false
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new AgentPolicyTimeoutError(policy.timeoutMs!));
    }, policy.timeoutMs);
  });

  return {
    signal: mergeAbortSignals(inputAbortSignal, controller.signal),
    timeoutPromise,
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    },
    isTimedOut: () => timedOut
  };
};

interface AgentExecutionLeaseContext {
  supported: boolean;
  signal?: AbortSignal;
  cancelledState: () => AgentRunState | undefined;
  leaseLost: () => boolean;
  release: () => Promise<void>;
}

const acquireAgentExecutionLease = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  policy: AgentRunPolicy | undefined
): Promise<AgentExecutionLeaseContext | undefined> => {
  const store = agent.store;
  if (policy?.leaseMode === "disabled" || !store?.acquireLease || !store.renewLease || !store.releaseLease) {
    return {
      supported: false,
      cancelledState: () => undefined,
      leaseLost: () => false,
      release: async () => undefined
    };
  }

  const ttlMs = policy?.leaseTtlMs ?? DEFAULT_AGENT_LEASE_TTL_MS;
  const heartbeatMs = policy?.heartbeatMs ?? Math.max(250, Math.floor(ttlMs / 3));
  const cancellationPollMs = policy?.cancellationPollMs ?? DEFAULT_AGENT_CANCELLATION_POLL_MS;
  for (const [name, value] of [
    ["leaseTtlMs", ttlMs],
    ["heartbeatMs", heartbeatMs],
    ["cancellationPollMs", cancellationPollMs]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ValidationError(`Agent policy "${name}" must be a positive integer.`);
    }
  }
  if (heartbeatMs >= ttlMs) {
    throw new ValidationError('Agent policy "heartbeatMs" must be less than "leaseTtlMs".');
  }

  const ownerId = randomId("worker");
  const lease = await store.acquireLease(state.runId, { ownerId, ttlMs }, state.scope);
  if (!lease) {
    return undefined;
  }

  const controller = new AbortController();
  let cancelled: AgentRunState | undefined;
  let lost = false;
  let stopped = false;
  let monitoring = false;
  let lastHeartbeat = Date.now();
  let lastCancellationPoll = 0;
  const intervalMs = Math.max(25, Math.min(heartbeatMs, cancellationPollMs));
  const timer = setInterval(async () => {
    if (stopped || monitoring) return;
    monitoring = true;
    const now = Date.now();
    try {
      if (now - lastHeartbeat >= heartbeatMs) {
        const renewed = await store.renewLease?.(state.runId, { ownerId, ttlMs }, state.scope);
        if (!renewed) {
          lost = true;
          controller.abort(new ConflictError(`Agent run "${state.runId}" lost its worker lease.`));
          return;
        }
        lastHeartbeat = now;
      }
      if (now - lastCancellationPoll >= cancellationPollMs) {
        const latest = await store.load(state.runId, state.scope);
        lastCancellationPoll = now;
        if (latest?.status === "cancel_requested" || latest?.status === "cancelled") {
          cancelled = normalizeAgentRunState(latest);
          controller.abort(new Error(latest.cancellationReason ?? "Agent run was cancelled."));
        }
      }
    } catch (error) {
      lost = true;
      controller.abort(error);
    } finally {
      monitoring = false;
    }
  }, intervalMs);
  timer.unref?.();

  return {
    supported: true,
    signal: controller.signal,
    cancelledState: () => cancelled,
    leaseLost: () => lost,
    release: async () => {
      stopped = true;
      clearInterval(timer);
      await store.releaseLease?.(state.runId, ownerId, state.scope);
    }
  };
};

const emitRunStartTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  memoryMessages: ModelMessage[],
  approvals: AgentApprovalResponse[] | undefined
) => {
  await emitTelemetryEvent(agent, {
    type: "run-start",
    runId: state.runId,
    agentId: state.agentId,
    provider: state.provider,
    modelId: state.modelId,
    maxSteps: state.maxSteps
  });

  if (state.handoff) {
    await emitTelemetryEvent(agent, {
      type: "handoff",
      runId: state.runId,
      agentId: state.agentId,
      handoff: state.handoff
    });
  }

  if (memoryMessages.length) {
    await emitTelemetryEvent(agent, {
      type: "memory-loaded",
      runId: state.runId,
      agentId: state.agentId,
      messageCount: memoryMessages.length
    });
  }

  for (const approval of approvals ?? []) {
    await emitTelemetryEvent(agent, {
      type: "approval-resolved",
      runId: state.runId,
      agentId: state.agentId,
      approval
    });
  }
};

const emitRunFinishTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState
) => {
  await emitTelemetryEvent(agent, {
    type: "run-finish",
    runId: state.runId,
    agentId: state.agentId,
    status: state.status,
    state: cloneState(state)
  });
};

export const createAgent = <TModel extends AgentDefinition["model"]>(
  definition: AgentDefinition<TModel>
): AgentDefinition<TModel> => ({
  ...definition,
  metadata: cloneMetadata(definition.metadata)
});

export class Agent<TModel extends LanguageModel = LanguageModel> implements AgentDefinition<TModel> {
  id?: string;
  model: TModel;
  instructions?: string;
  tools?: AgentDefinition<TModel>["tools"];
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  reasoning?: AgentDefinition<TModel>["reasoning"];
  toolExecution?: AgentDefinition<TModel>["toolExecution"];
  toolApprovalPolicy?: AgentDefinition<TModel>["toolApprovalPolicy"];
  inputGuardrails?: AgentDefinition<TModel>["inputGuardrails"];
  outputGuardrails?: AgentDefinition<TModel>["outputGuardrails"];
  providerOptions?: AgentDefinition<TModel>["providerOptions"];
  subagents?: AgentDefinition<TModel>["subagents"];
  policy?: AgentRunPolicy;
  metadata?: Record<string, JsonValue>;
  store?: AgentRunStore;
  memory?: AgentDefinition<TModel>["memory"];
  onTelemetryEvent?: AgentDefinition<TModel>["onTelemetryEvent"];
  hookFailurePolicy?: AgentDefinition<TModel>["hookFailurePolicy"];

  constructor(definition: AgentDefinition<TModel>) {
    Object.assign(this, createAgent(definition));
    this.model = definition.model;
  }

  toDefinition(): AgentDefinition<TModel> {
    return createAgent({
      id: this.id,
      model: this.model,
      instructions: this.instructions,
      tools: this.tools,
      maxSteps: this.maxSteps,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      reasoning: this.reasoning,
      toolExecution: this.toolExecution,
      toolApprovalPolicy: this.toolApprovalPolicy,
      inputGuardrails: this.inputGuardrails,
      outputGuardrails: this.outputGuardrails,
      providerOptions: this.providerOptions,
      subagents: this.subagents,
      policy: this.policy,
      metadata: this.metadata,
      store: this.store,
      memory: this.memory,
      onTelemetryEvent: this.onTelemetryEvent,
      hookFailurePolicy: this.hookFailurePolicy
    });
  }

  run(input: AgentRunInput<TModel> = {}): Promise<AgentRunOutput> {
    return runAgent(this.toDefinition(), input);
  }

  resume(input: AgentRunInput<TModel> & { state: AgentRunState }): Promise<AgentRunOutput> {
    return resumeAgent(this.toDefinition(), input);
  }

  stream(input: AgentRunInput<TModel> = {}): AgentStreamResult {
    return streamAgent(this.toDefinition(), input);
  }
}

export const prepareSubagentsForAgent = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  options: PrepareSubagentsForAgentOptions = {}
): AgentDefinition<TModel> => {
  const store = options.store ?? agent.store;
  const memory = options.memory ?? agent.memory;
  const onTelemetryEvent = options.onTelemetryEvent ?? agent.onTelemetryEvent;
  const toolApprovalPolicy = options.toolApprovalPolicy ?? agent.toolApprovalPolicy;
  const toolExecution = options.toolExecution ?? agent.toolExecution;
  const defaultMetadata = cloneMetadata(agent.metadata, options.metadata);

  return {
    ...agent,
    metadata: cloneMetadata(agent.metadata),
    subagents: (agent.subagents ?? []).map((subagent) => ({
      ...subagent,
      metadata: cloneMetadata(defaultMetadata, subagent.metadata),
      agent: {
        ...subagent.agent,
        store: subagent.agent.store ?? store,
        memory: subagent.agent.memory ?? memory,
        onTelemetryEvent: subagent.agent.onTelemetryEvent ?? onTelemetryEvent,
        toolApprovalPolicy: subagent.agent.toolApprovalPolicy ?? toolApprovalPolicy,
        toolExecution: subagent.agent.toolExecution ?? toolExecution,
        metadata: cloneMetadata(defaultMetadata, subagent.agent.metadata)
      }
    }))
  };
};

export const runAgentGroup = async (
  agents: AgentGroupMember[],
  input: AgentGroupRunInput = {}
): Promise<AgentGroupRunOutput> => {
  const { stopOnError, runId: _runId, state: _state, approvals: _approvals, handoff: _handoff, ...sharedInput } = input;
  const parentRunId = input.parentRunId;
  const controllers = agents.map(() => new AbortController());
  let failFastTriggered = false;
  const isFailingOutput = (output: AgentRunOutput) => output.status === "failed" || output.status === "timed_out";
  const abortPending = (currentIndex: number) => {
    if (!stopOnError || failFastTriggered) {
      return;
    }
    failFastTriggered = true;
    controllers.forEach((controller, index) => {
      if (index !== currentIndex) {
        controller.abort();
      }
    });
  };

  const runs = agents.map(async (member, index) => {
    const runInput = {
      ...sharedInput,
      ...(member.input ?? {}),
      parentRunId: member.input?.parentRunId ?? parentRunId,
      abortSignal: mergeAbortSignals(input.abortSignal, member.input?.abortSignal, controllers[index]!.signal),
      metadata: cloneMetadata(input.metadata, member.input?.metadata, {
        ...(member.name ? { agentGroupMember: member.name } : {})
      })
    } as AgentRunInput;
    try {
      const output = await runAgent(member.agent, runInput);
      if (isFailingOutput(output)) {
        abortPending(index);
      }
      return output;
    } catch (error) {
      abortPending(index);
      throw error;
    }
  });
  const settled = await Promise.allSettled(runs);
  const outputs = settled.map((result, index) => {
    const member = agents[index]!;
    if (result.status === "fulfilled") {
      return {
        name: member.name,
        agentId: result.value.state.agentId ?? member.agent.id,
        status: "fulfilled" as const,
        output: result.value
      };
    }

    return {
      name: member.name,
      agentId: member.agent.id,
      status: "rejected" as const,
      error: {
        message:
          stopOnError && failFastTriggered && controllers[index]!.signal.aborted
            ? AGENT_GROUP_FAIL_FAST_ABORT_MESSAGE
            : result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
      }
    };
  });
  const failed = outputs.some(
    (output) => output.status === "rejected" || output.output?.status === "failed" || output.output?.status === "timed_out"
  );

  return {
    status: stopOnError && failed ? "failed" : failed ? "failed" : "completed",
    parentRunId,
    outputs
  };
};

export const cancelAgentRun = async (
  store: AgentRunStore,
  runId: string,
  options: AgentRunCancellationOptions = {}
): Promise<AgentRunState | undefined> => {
  const loadedState = await store.load(runId, options.scope);
  if (!loadedState) {
    return undefined;
  }

  const cancelledAt = Date.now();
  const status = options.mode === "final" ? "cancelled" : "cancel_requested";
  const state = normalizeAgentRunState({
    ...loadedState,
    status,
    cancelledAt,
    cancellationReason: options.reason,
    updatedAt: cancelledAt,
    error: undefined
  });
  await saveStateWithRevision(store, state);
  return cloneState(state);
};

export const cancelAgentRunTree = async (
  store: AgentRunStore,
  runId: string,
  options: AgentRunCancellationOptions = {}
): Promise<AgentRunTreeCancellationResult> => {
  if (!store.findByParentRunId) {
    throw new ValidationError('The agent run "store" must implement "findByParentRunId()" to cancel an agent run tree.');
  }

  const cancelledAt = Date.now();
  const status = options.mode === "final" ? "cancelled" : "cancel_requested";
  const cancelState = (state: AgentRunState): AgentRunState =>
    normalizeAgentRunState({
      ...state,
      status,
      cancelledAt,
      cancellationReason: options.reason,
      updatedAt: cancelledAt,
      error: undefined
    });

  const parent = await store.load(runId, options.scope);
  if (!parent) {
    return {
      parent: undefined,
      children: []
    };
  }

  const visited = new Set<string>([runId]);
  const children: AgentRunState[] = [];
  const collectChildren = async (parentRunId: string): Promise<void> => {
    const directChildren = await store.findByParentRunId?.(parentRunId, options.scope);
    for (const child of directChildren ?? []) {
      if (visited.has(child.runId)) {
        continue;
      }
      visited.add(child.runId);
      children.push(child);
      await collectChildren(child.runId);
    }
  };

  await collectChildren(runId);

  const cancelledParent = cancelState(parent);
  const cancelledChildren = children.map(cancelState);
  await saveStateWithRevision(store, cancelledParent);
  for (const child of cancelledChildren) {
    await saveStateWithRevision(store, child);
  }

  return {
    parent: cloneState(cancelledParent),
    children: cancelledChildren.map(cloneState)
  };
};

export const runAgent = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel> = {}
): Promise<AgentRunOutput> => {
  const context = await resolveContext(agent, input);
  const currentStatus = normalizeApprovalStatus(context.state.status);
  const policy = resolveRunPolicy(agent, input);

  if (
    currentStatus === "completed" ||
    currentStatus === "cancelled" ||
    currentStatus === "cancel_requested" ||
    currentStatus === "timed_out"
  ) {
    context.state.status = currentStatus;
    return toOutput(context.state);
  }

  if (currentStatus === "waiting_approval" && context.state.pendingApprovals.length > 0 && !input.approvals?.length) {
    context.state.status = currentStatus;
    return toOutput(context.state);
  }

  const supportsLeases = Boolean(
    agent.store?.acquireLease && agent.store.renewLease && agent.store.releaseLease
  );
  if (!context.fresh && currentStatus === "running" && !supportsLeases) {
    return toOutput(context.state);
  }

  const freshRequiresExistingClaim = context.fresh && Boolean(context.state.idempotencyKey);
  if (context.fresh && !freshRequiresExistingClaim) {
    await claimAgentExecution(agent, context.state);
  }
  const executionLease = await acquireAgentExecutionLease(agent, context.state, policy);
  if (!executionLease) {
    if (input.state) {
      throw new ConflictError(`Agent run "${context.state.runId}" is already owned by another worker.`);
    }
    const activeState = await agent.store?.load(context.state.runId, context.state.scope);
    return toOutput(activeState ? normalizeAgentRunState(activeState) : context.state);
  }
  try {
    if (!context.fresh || freshRequiresExistingClaim) {
      await claimAgentExecution(agent, context.state);
    }
    await emitRunStartTelemetry(agent, context.state, context.memoryMessages, input.approvals);
  } catch (error) {
    await executionLease.release();
    throw error;
  }

  if (context.remainingSteps === 0) {
    const state = createFailedState(context.state, "Agent exhausted maxSteps before reaching a terminal response.");
    await persistState(agent, state, policy);
    await emitRunFinishTelemetry(agent, state);
    await executionLease.release();
    return toOutput(state);
  }

  let inputGuardrail: AgentGuardrailTrigger | undefined;
  try {
    inputGuardrail = await runGuardrails(agent, context.state, "input", agent.inputGuardrails, () => ({
      runId: context.state.runId,
      agentId: context.state.agentId,
      state: cloneState(context.state),
      messages: context.messages,
      metadata: context.state.metadata
    }));
  } catch (error) {
    await executionLease.release();
    throw error;
  }
  if (inputGuardrail) {
    const failedState = applyGuardrailFailure(context.state, "input", inputGuardrail);
    await persistState(agent, failedState, policy);
    await emitRunFinishTelemetry(agent, failedState);
    await executionLease.release();
    return toOutput(failedState);
  }

  try {
    await emitTelemetryEvent(agent, {
      type: "step-start",
      runId: context.state.runId,
      agentId: context.state.agentId,
      stepIndex: context.state.currentStep + 1
    });
  } catch (error) {
    await executionLease.release();
    throw error;
  }

  const abortContext = createAgentAbortContext(
    mergeAbortSignals(input.abortSignal, executionLease.signal),
    policy
  );

  try {
    const result = await withAgentPolicyTimeout(
      generateText(createGenerateOptions(agent, context.state, input, context.messages, context.remainingSteps, abortContext.signal)),
      abortContext
    );
    const cancelled = executionLease.cancelledState();
    if (cancelled) {
      await emitRunFinishTelemetry(agent, cancelled);
      return toOutput(cancelled);
    }
    if (executionLease.leaseLost()) {
      throw new ConflictError(`Agent run "${context.state.runId}" lost its worker lease.`);
    }
    const newSteps = mapSteps(result.steps, context.state.currentStep, result.toolResults);
    let output = finalizeState(context.state, result, newSteps, result.toolResults);

    const outputGuardrail = await runGuardrails(agent, output.state, "output", agent.outputGuardrails, () => ({
      runId: output.state.runId,
      agentId: output.state.agentId,
      state: cloneState(output.state),
      output,
      metadata: output.state.metadata
    }));
    if (outputGuardrail) {
      output = toOutput(applyGuardrailFailure(output.state, "output", outputGuardrail));
    }

    await emitFinalizedStepTelemetry(agent, output.state, newSteps);
    await emitApprovalTelemetry(agent, output.state, approvalsFromEvents(newSteps.flatMap((step) => step.response?.messages ?? [])));
    await persistState(agent, output.state, policy);
    await emitRunFinishTelemetry(agent, output.state);

    return output;
  } catch (error) {
    const cancelled = executionLease.cancelledState();
    if (cancelled) {
      await emitRunFinishTelemetry(agent, cancelled);
      return toOutput(cancelled);
    }
    if (executionLease.leaseLost()) {
      throw new ConflictError(`Agent run "${context.state.runId}" lost its worker lease.`);
    }
    if (error instanceof AgentPolicyTimeoutError || abortContext.isTimedOut()) {
      const status = policy?.onTimeout === "cancel-requested" ? "cancel_requested" : "timed_out";
      const message = error instanceof Error ? error.message : `Agent run timed out after ${policy?.timeoutMs}ms.`;
      const durableState = agent.store
        ? normalizeAgentRunState((await agent.store.load(context.state.runId, context.state.scope)) ?? context.state)
        : context.state;
      const timedOutState = createTerminalState(durableState, status, message);
      await persistState(agent, timedOutState, policy);
      await emitRunFinishTelemetry(agent, timedOutState);
      return toOutput(timedOutState);
    }

    const durableState = agent.store
      ? normalizeAgentRunState((await agent.store.load(context.state.runId, context.state.scope)) ?? context.state)
      : context.state;
    const failedState = createFailedState(
      durableState,
      error instanceof Error ? error.message : String(error)
    );
    await persistState(agent, failedState, policy);
    await emitRunFinishTelemetry(agent, failedState);
    throw error;
  } finally {
    await executionLease.release();
  }
};

export const streamAgent = <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel> = {}
): AgentStreamResult => {
  const policy = resolveRunPolicy(agent, input);
  const broadcast = new BoundedReplayBroadcast<AgentStreamEvent>({
    maxHistory: policy?.maxStreamEvents ?? 4096
  });
  const publish = (event: AgentStreamEvent, terminal = false) =>
    broadcast.publish(event, { terminal });
  let activeLease: AgentExecutionLeaseContext | undefined;

  const runner = (async () => {
    const context = await resolveContext(agent, input);
    const currentStatus = normalizeApprovalStatus(context.state.status);

    const supportsLeases = Boolean(
      agent.store?.acquireLease && agent.store.renewLease && agent.store.releaseLease
    );
    if (!context.fresh && currentStatus === "running" && !supportsLeases) {
      broadcast.close();
      return {
        output: toOutput(context.state),
        textStream: emptyAsyncIterable()
      };
    }

    if (
      currentStatus === "completed" ||
      currentStatus === "cancelled" ||
      currentStatus === "cancel_requested" ||
      currentStatus === "timed_out"
    ) {
      context.state.status = currentStatus;
      broadcast.close();
      return {
        output: toOutput(context.state),
        textStream: emptyAsyncIterable()
      };
    }

    if (currentStatus === "waiting_approval" && context.state.pendingApprovals.length > 0 && !input.approvals?.length) {
      context.state.status = currentStatus;
      broadcast.close();
      return {
        output: toOutput(context.state),
        textStream: emptyAsyncIterable()
      };
    }

    const freshRequiresExistingClaim = context.fresh && Boolean(context.state.idempotencyKey);
    if (context.fresh && !freshRequiresExistingClaim) {
      await claimAgentExecution(agent, context.state);
    }
    const executionLease = await acquireAgentExecutionLease(agent, context.state, policy);
    if (!executionLease) {
      if (input.state) {
        throw new ConflictError(`Agent run "${context.state.runId}" is already owned by another worker.`);
      }
      const activeState = await agent.store?.load(context.state.runId, context.state.scope);
      broadcast.close();
      return {
        output: toOutput(activeState ? normalizeAgentRunState(activeState) : context.state),
        textStream: emptyAsyncIterable()
      };
    }
    activeLease = executionLease;
    try {
      if (!context.fresh || freshRequiresExistingClaim) {
        await claimAgentExecution(agent, context.state);
      }
      await emitRunStartTelemetry(agent, context.state, context.memoryMessages, input.approvals);
    } catch (error) {
      await executionLease.release();
      throw error;
    }

    if (context.remainingSteps === 0) {
      const state = createFailedState(context.state, "Agent exhausted maxSteps before reaching a terminal response.");
      await persistState(agent, state, policy);
      await emitRunFinishTelemetry(agent, state);
      await executionLease.release();
      broadcast.close();
      return {
        output: toOutput(state),
        textStream: emptyAsyncIterable()
      };
    }

    let inputGuardrail: AgentGuardrailTrigger | undefined;
    try {
      inputGuardrail = await runGuardrails(agent, context.state, "input", agent.inputGuardrails, () => ({
        runId: context.state.runId,
        agentId: context.state.agentId,
        state: cloneState(context.state),
        messages: context.messages,
        metadata: context.state.metadata
      }));
    } catch (error) {
      await executionLease.release();
      throw error;
    }
    if (inputGuardrail) {
      const failedState = applyGuardrailFailure(context.state, "input", inputGuardrail);
      await persistState(agent, failedState, policy);
      await emitRunFinishTelemetry(agent, failedState);
      await publish({
        type: "error",
        error: new GuardrailTriggeredError("input", failedState.error?.message ?? "Agent input guardrail triggered.", {
          metadata: inputGuardrail.metadata
        })
      }, true);
      await publish({
        type: "agent-run-finish",
        status: failedState.status,
        state: failedState
      }, true);
      broadcast.close();
      await executionLease.release();
      return {
        output: toOutput(failedState),
        textStream: emptyAsyncIterable()
      };
    }

    await publish({
      type: "agent-run-start",
      currentStep: context.state.currentStep + 1,
      maxSteps: context.state.maxSteps
    });

    for (const approval of input.approvals ?? []) {
      await publish({
        type: "agent-approval-resolved",
        approval
      });
    }

    await publish({
      type: "agent-step-start",
      stepIndex: context.state.currentStep + 1
    });

    await emitTelemetryEvent(agent, {
      type: "step-start",
      runId: context.state.runId,
      agentId: context.state.agentId,
      stepIndex: context.state.currentStep + 1
    });

    const abortContext = createAgentAbortContext(
      mergeAbortSignals(input.abortSignal, executionLease.signal),
      policy
    );
    const streamResult = streamText(
      createGenerateOptions(agent, context.state, input, context.messages, context.remainingSteps, abortContext.signal)
    );
    const approvalRequests: AgentApprovalRequest[] = [];

    const eventRelay = (async () => {
      for await (const event of streamResult.eventStream) {
        await publish(event);

        if (
          event.type === "provider-data" &&
          typeof event.data === "object" &&
          event.data !== null &&
          !Array.isArray(event.data) &&
          event.data.type === "mcp_approval_request" &&
          typeof event.data.id === "string" &&
          typeof event.data.name === "string" &&
          typeof event.data.arguments === "string"
        ) {
          const approval = {
            provider: event.provider,
            id: event.data.id,
            name: event.data.name,
            arguments: event.data.arguments,
            serverLabel: typeof event.data.server_label === "string" ? event.data.server_label : undefined,
            rawData: event.data
          } satisfies AgentApprovalRequest;
          approvalRequests.push(approval);
          await publish({
            type: "agent-approval-request",
            approval
          });
          await emitTelemetryEvent(agent, {
            type: "approval-request",
            runId: context.state.runId,
            agentId: context.state.agentId,
            approval
          });
        }
      }
    })();

    const output = (async () => {
      try {
        const final = await withAgentPolicyTimeout(
          eventRelay.then(() => streamResult.collect()),
          abortContext
        );
        const cancelled = executionLease.cancelledState();
        if (cancelled) {
          await emitRunFinishTelemetry(agent, cancelled);
          await publish({
            type: "agent-run-finish",
            status: cancelled.status,
            state: cancelled
          }, true);
          broadcast.close();
          return toOutput(cancelled);
        }
        if (executionLease.leaseLost()) {
          const conflict = new ConflictError(`Agent run "${context.state.runId}" lost its worker lease.`);
          broadcast.fail(conflict);
          throw conflict;
        }
        const newSteps = mapSteps(final.steps, context.state.currentStep, final.toolResults);
        let result = finalizeState(context.state, final, newSteps, final.toolResults);

        const outputGuardrail = await runGuardrails(agent, result.state, "output", agent.outputGuardrails, () => ({
          runId: result.state.runId,
          agentId: result.state.agentId,
          state: cloneState(result.state),
          output: result,
          metadata: result.state.metadata
        }));
        if (outputGuardrail) {
          result = toOutput(applyGuardrailFailure(result.state, "output", outputGuardrail));
          await publish({
            type: "error",
            error: new GuardrailTriggeredError(
              "output",
              result.state.error?.message ?? "Agent output guardrail triggered.",
              { metadata: outputGuardrail.metadata }
            )
          }, true);
        }

        for (const step of newSteps) {
          await publish({
            type: "agent-step-finish",
            step
          });
        }

        await emitFinalizedStepTelemetry(agent, result.state, newSteps);
        if (!approvalRequests.length) {
          await emitApprovalTelemetry(agent, result.state, approvalsFromEvents(newSteps.flatMap((step) => step.response?.messages ?? [])));
        }
        await persistState(agent, result.state, policy);
        await emitRunFinishTelemetry(agent, result.state);

        await publish({
          type: "agent-run-finish",
          status: result.status,
          state: result.state
        }, true);
        broadcast.close();
        return result;
      } catch (error) {
        const cancelled = executionLease.cancelledState();
        if (cancelled) {
          await emitRunFinishTelemetry(agent, cancelled);
          await publish({
            type: "agent-run-finish",
            status: cancelled.status,
            state: cancelled
          }, true);
          broadcast.close();
          return toOutput(cancelled);
        }
        if (executionLease.leaseLost()) {
          const conflict = new ConflictError(`Agent run "${context.state.runId}" lost its worker lease.`);
          broadcast.fail(conflict);
          throw conflict;
        }
        if (error instanceof AgentPolicyTimeoutError || abortContext.isTimedOut()) {
          const status = policy?.onTimeout === "cancel-requested" ? "cancel_requested" : "timed_out";
          const message = error instanceof Error ? error.message : `Agent run timed out after ${policy?.timeoutMs}ms.`;
          const durableState = agent.store
            ? normalizeAgentRunState((await agent.store.load(context.state.runId, context.state.scope)) ?? context.state)
            : context.state;
          const timedOutState = createTerminalState(durableState, status, message);
          await persistState(agent, timedOutState, policy);
          await emitRunFinishTelemetry(agent, timedOutState);
          await publish({
            type: "error",
            error: new AgentPolicyTimeoutError(policy?.timeoutMs ?? 0)
          }, true);
          await publish({
            type: "agent-run-finish",
            status: timedOutState.status,
            state: timedOutState
          }, true);
          broadcast.close();
          return toOutput(timedOutState);
        }

        const durableState = agent.store
          ? normalizeAgentRunState((await agent.store.load(context.state.runId, context.state.scope)) ?? context.state)
          : context.state;
        const failedState = createFailedState(durableState, error instanceof Error ? error.message : String(error));
        await persistState(agent, failedState, policy);
        await emitRunFinishTelemetry(agent, failedState);
        await publish({
          type: "error",
          error: error instanceof Error ? error : new Error(String(error))
        }, true);
        await publish({
          type: "agent-run-finish",
          status: failedState.status,
          state: failedState
        }, true);
        broadcast.close();
        throw error;
      } finally {
        await executionLease.release();
      }
    })();

    return {
      output,
      textStream: streamResult.textStream
    };
  })().catch(async (error) => {
    await activeLease?.release();
    broadcast.fail(error);
    throw error;
  });

  return {
    eventStream: broadcast.stream(),
    textStream: (async function* () {
      const started = await runner;
      for await (const chunk of started.textStream) {
        yield chunk;
      }
    })(),
    collect: async () => (await runner).output
  };
};

export const resumeAgent = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  input: AgentRunInput<TModel> & { state: AgentRunState }
): Promise<AgentRunOutput> => runAgent(agent, input);
