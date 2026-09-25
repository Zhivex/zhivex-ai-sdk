import { validateMaxSteps } from "../validate-max-steps.js";
import {
  createAgentHandoffMessage
} from "../agent-handoff-contracts.js";
import {
  createAgentExecutionEnvironmentBinding,
  fingerprintAgentHarness
} from "../agent-harness.js";
import {
  AGENT_RUN_STATE_SCHEMA_VERSION,
  normalizeAgentRunState
} from "../agent-state.js";
import {
  ConflictError,
  ValidationError
} from "../errors.js";
import {
  normalizeMessages
} from "../generate-text.js";
import type {
  AgentDefinition,
  AgentExecutionEnvironmentBinding,
  AgentRunInput,
  AgentRunState,
  AgentRunStore,
  JsonValue,
  LanguageModel,
  ModelMessage
} from "../types.js";
import {
  cloneMetadata,
  joinInstructions,
  promptedOutputInstruction,
  randomId,
  resolveAgentOutputMode
} from "./common.js";
import {
  invokeOperationalHook
} from "./telemetry.js";
import {
  applyApprovalResponses
} from "./approvals.js";

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
  scope: AgentRunInput["scope"],
  outputMode: "native" | "prompted" | undefined,
  harness: AgentDefinition["harness"],
  executionEnvironment: AgentExecutionEnvironmentBinding | undefined
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
    harness,
    executionEnvironment,
    status: "running",
    messages: initialMessages,
    steps: [],
    toolResults: [],
    currentStep: 0,
    maxSteps,
    outputText: "",
    outputMode,
    pendingApprovals: [],
    approvalHistory: [],
    compactions: [],
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

export const ensureValidIdempotencyInput = (input: AgentRunInput, store: AgentRunStore | undefined) => {
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

export const ensureValidScope = (scope: AgentRunInput["scope"]) => {
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
    system: joinInstructions(agent.instructions, input.system, promptedOutputInstruction(agent))
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

const bindDurableRuntime = (
  agent: AgentDefinition,
  input: AgentRunInput,
  state: AgentRunState,
  executionEnvironment: AgentExecutionEnvironmentBinding | undefined
) => {
  const policy = {
    ...(agent.policy ?? {}),
    ...(input.policy ?? {})
  };
  if (state.budgetCoordinatorId && state.budgetCoordinatorId !== policy.budgetCoordinator?.id) {
    throw new ConflictError("Cannot resume with a different shared budget coordinator.");
  }
  if (policy.budgetCoordinator) state.budgetCoordinatorId = policy.budgetCoordinator.id;
  const compaction = input.compaction === false ? undefined : input.compaction ?? agent.compaction;
  const routeFingerprint = compaction?.auxiliary ? fingerprintAgentHarness(compaction.auxiliary) : undefined;
  if (state.compactionRouteFingerprint && state.compactionRouteFingerprint !== routeFingerprint) {
    throw new ConflictError("Cannot resume with a different auxiliary compaction route.");
  }
  if (routeFingerprint) state.compactionRouteFingerprint = routeFingerprint;
  if (state.compactionAttempts?.some(attempt => attempt.status !== "confirmed")) {
    throw new ConflictError("Auxiliary compaction consumption is unknown; reconcile the durable attempt before resuming.");
  }
  if (state.harness && !agent.harness) {
    throw new ConflictError(
      `Agent run "${state.runId}" is bound to harness "${state.harness.id}", but the current agent has no harness binding.`
    );
  }
  if (state.harness && agent.harness) {
    if (
      state.harness.id !== agent.harness.id ||
      state.harness.version !== agent.harness.version ||
      state.harness.fingerprint !== agent.harness.fingerprint
    ) {
      throw new ConflictError(`Agent run "${state.runId}" was created by a different harness fingerprint.`);
    }
  } else if (!state.harness && agent.harness) {
    if (!policy?.allowLegacyHarnessResume) {
      throw new ConflictError(
        `Agent run "${state.runId}" predates harness binding; set allowLegacyHarnessResume only for an explicit migration.`
      );
    }
    state.harness = agent.harness;
  }

  if (state.executionEnvironment && !executionEnvironment) {
    throw new ConflictError(
      `Agent run "${state.runId}" is bound to execution environment "${state.executionEnvironment.environmentId}".`
    );
  }
  if (state.executionEnvironment && executionEnvironment) {
    if (
      state.executionEnvironment.environmentId !== executionEnvironment.environmentId ||
      state.executionEnvironment.environmentVersion !== executionEnvironment.environmentVersion ||
      state.executionEnvironment.fingerprint !== executionEnvironment.fingerprint ||
      state.executionEnvironment.workspaceId !== executionEnvironment.workspaceId
    ) {
      throw new ConflictError(`Agent run "${state.runId}" was created in a different execution environment.`);
    }
  } else if (!state.executionEnvironment && executionEnvironment) {
    if (!policy?.allowLegacyExecutionEnvironmentResume) {
      throw new ConflictError(
        `Agent run "${state.runId}" predates execution-environment binding; enable the explicit migration policy to resume it.`
      );
    }
    state.executionEnvironment = executionEnvironment;
  }
};

const validateHarnessBinding = (binding: AgentDefinition["harness"]) => {
  if (!binding) {
    return;
  }
  if (
    binding.schemaVersion !== 1 ||
    binding.algorithm !== "sha256" ||
    !binding.id ||
    !binding.version ||
    !/^sha256:[0-9a-f]{64}$/.test(binding.fingerprint)
  ) {
    throw new ValidationError("Agent harness binding is invalid.");
  }
};

export const resolveContext = async <
  TModel extends LanguageModel,
  TContext,
  TOutput,
  TContextInput
>(
  agent: AgentDefinition<TModel, TContext, TOutput, TContextInput>,
  input: AgentRunInput<TModel, TContext, NoInfer<TContextInput>>
) => {
  validateHarnessBinding(agent.harness);
  const executionEnvironment = input.executionEnvironment ?? agent.executionEnvironment;
  const executionEnvironmentBinding = executionEnvironment
    ? createAgentExecutionEnvironmentBinding(executionEnvironment.manifest)
    : undefined;
  let parsedContext = input.context as unknown as TContext | undefined;
  if (agent.contextSchema) {
    const result = await agent.contextSchema.safeParseAsync(input.context);
    if (!result.success) {
      throw new ValidationError(`Invalid agent context: ${result.error.message}`);
    }
    parsedContext = result.data;
  }
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
    const maxSteps = validateMaxSteps(input.maxSteps ?? agent.maxSteps);
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
      inputScope,
      resolveAgentOutputMode(agent),
      agent.harness,
      executionEnvironmentBinding
    ) as AgentRunState & { idempotencyKey: string };
    bindDurableRuntime(agent, input, candidate, executionEnvironmentBinding);
    const claim = await agent.store!.claimIdempotencyKey!(candidate);
    if (claim.claimed) {
      return {
        state: normalizeAgentRunState(claim.state),
        messages: prepared.messages,
        remainingSteps: maxSteps,
        memoryMessages: prepared.memoryMessages,
        context: parsedContext,
        executionEnvironment,
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
    const groupIdentity = input.metadata?.agentGroupIdentity;
    if (groupIdentity !== undefined && (
      loadedState.metadata?.agentGroupIdentity !== groupIdentity ||
      loadedState.agentId !== agent.id
    )) {
      throw new ConflictError("Agent group idempotency key belongs to a different member or agent.");
    }
    bindDurableRuntime(agent, input, loadedState, executionEnvironmentBinding);
    const maxSteps = validateMaxSteps(input.maxSteps ?? loadedState.maxSteps);
    const resumed = await applyApprovalResponses(
      loadedState.messages,
      input.approvals,
      loadedState.pendingApprovals,
      loadedState.approvalHistory,
      agent.toolApprovalSigner
    );

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
        approvalHistory: resumed.approvalHistory,
        metadata,
        updatedAt: Date.now()
      } satisfies AgentRunState,
      messages: resumed.messages,
      remainingSteps: Math.max(0, maxSteps - loadedState.currentStep),
      memoryMessages: [] as ModelMessage[],
      context: parsedContext,
      executionEnvironment,
      fresh: false
    };
  }

  const runId = input.runId ?? randomId("run");
  const maxSteps = validateMaxSteps(input.maxSteps ?? agent.maxSteps);
  const prepared = await prepareFreshMessages(agent, input, runId);

  const state = createBaseState(
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
      inputScope,
      resolveAgentOutputMode(agent),
      agent.harness,
      executionEnvironmentBinding
    );
  bindDurableRuntime(agent, input, state, executionEnvironmentBinding);
  return {
    state,
    messages: prepared.messages,
    remainingSteps: maxSteps,
    memoryMessages: prepared.memoryMessages,
    context: parsedContext,
    executionEnvironment,
    fresh: true
  };
};
