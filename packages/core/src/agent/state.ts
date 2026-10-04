import { isDeepStrictEqual } from "node:util";
import { synchronizeAgentCancellation } from "./cancellation-intent.js";
import { observeChildState, reconcileChildRuns } from "./children.js";
import {
  refreshAgentTaskOutcome
} from "../agent-reconciliation.js";
import {
  getAgentApprovalRequests
} from "../agent-approval.js";
import {
  normalizeAgentRunState
} from "../agent-state.js";
import {
  ConflictError,
  ValidationError
} from "../errors.js";
import {
  aggregateTokenUsage
} from "../generate-text.js";
import {
  serializeJsonValue
} from "../messages.js";
import type {
  AgentDefinition,
  AgentRunOutput,
  AgentRunState,
  AgentRunPolicy,
  AgentRunStore,
  AgentStep,
  GenerateTextOutput,
  LanguageModel,
  ToolExecutionResult
} from "../types.js";
import {
  cloneState,
  hasToolCalls,
  toOutput
} from "./common.js";
import {
  emitTelemetryEvent,
  invokeOperationalHook
} from "./telemetry.js";

const DEFAULT_AGENT_MAX_STATE_BYTES = 4 * 1024 * 1024;

// Only successful writes establish provenance. Keep an immutable snapshot tied
// to the store and worker object, rather than trusting its mutable current state.
const confirmedCheckpoints = new WeakMap<AgentRunState, { store: AgentRunStore; state: AgentRunState }>();
const withoutCancellationTransition = (state: AgentRunState) => {
  const { revision, status, updatedAt, cancelledAt, cancellationReason, cancellationCascade, error, ...durable } = state;
  return durable;
};

export const finalizeState = <TOutput>(
  agent: AgentDefinition<LanguageModel, any, TOutput>,
  state: AgentRunState,
  result: GenerateTextOutput,
  newSteps: AgentStep[],
  newToolResults: ToolExecutionResult[]
): AgentRunOutput<TOutput> => {
  const nextCurrentStep = state.currentStep + newSteps.length;
  const exhausted = nextCurrentStep >= state.maxSteps;
  const lastStep = newSteps.at(-1);
  const unresolvedToolCalls = lastStep?.response ? hasToolCalls(lastStep.response.messages) : false;
  const pendingApprovals = [
    ...(result.approvalRequests ?? []),
    ...getAgentApprovalRequests(newSteps.flatMap((step) => step.response?.messages ?? []))
  ];

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
  if (state.status === "completed") {
    const terminalText = result.steps.at(-1)?.response.text ?? result.text;
    if (agent.outputSchema) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(terminalText);
      } catch (error) {
        throw new ValidationError("Agent final output is not valid JSON.", { cause: error });
      }
      const parsedOutput = agent.outputSchema.safeParse(parsedJson);
      if (!parsedOutput.success) {
        throw new ValidationError(`Agent final output validation failed: ${parsedOutput.error.message}`);
      }
      state.finalOutput = serializeJsonValue(parsedOutput.data);
    }
  }
  state.finishReason = result.finishReason;
  state.providerFinishReason = result.providerFinishReason;
  state.usage = aggregateTokenUsage([state.usage, result.usage]);
  state.pendingApprovals = pendingApprovals;
  state.updatedAt = Date.now();

  return toOutput(state);
};

export const saveStateWithRevision = async (store: AgentRunStore, state: AgentRunState, serializedNextState?: string) => {
  const expectedRevision = state.revision ?? 0;
  const nextRevision = expectedRevision + 1;
  const nextState = { ...state, revision: nextRevision } satisfies AgentRunState;
  const payload = serializedNextState === undefined ? cloneState(nextState) : JSON.parse(serializedNextState) as AgentRunState;
  const confirmed = cloneState(payload);
  await store.save(payload, { expectedRevision });
  state.revision = nextRevision;
  confirmedCheckpoints.set(state, { store, state: confirmed });
};

export const claimAgentExecution = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState
) => {
  if (await synchronizeAgentCancellation(agent.store, state)) return false;
  state.status = "running";
  observeChildState(agent, state);
  state.updatedAt = Date.now();
  const serialized = assertStateSize(agent, agent.store ? normalizeAgentRunState({ ...state, revision: (state.revision ?? 0) + 1 }) : state);
  if (agent.store) {
    try { await saveStateWithRevision(agent.store, state, serialized); }
    catch (error) {
      if (!(error instanceof ConflictError) || !await synchronizeAgentCancellation(agent.store, state)) throw error;
      return false;
    }
  }
  return !await synchronizeAgentCancellation(agent.store, state);
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
  const serialized = agent.store?.checkpointBytes ? undefined : JSON.stringify(state);
  const bytes = agent.store?.checkpointBytes ? agent.store.checkpointBytes(state) : new TextEncoder().encode(serialized!).byteLength;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ValidationError("Invalid durable checkpoint size.");
  if (bytes > limit) {
    throw new ValidationError(
      `Agent run state is ${bytes} bytes and exceeds maxStateBytes=${limit}. Offload large tool outputs to artifacts or raise the explicit limit.`
    );
  }
  return serialized;
};

export const persistState = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  policy?: AgentRunPolicy,
  baselineState: AgentRunState = state
) => {
  state.updatedAt = Date.now();
  observeChildState(agent, state);
  await reconcileChildRuns(state, agent.store);
  await refreshAgentTaskOutcome(state, agent.store);
  const serialized = assertStateSize(agent, agent.store ? normalizeAgentRunState({ ...state, revision: (state.revision ?? 0) + 1 }) : state, policy);
  if (agent.store) {
    const confirmed = confirmedCheckpoints.get(baselineState);
    let baseline = confirmed?.store === agent.store && confirmed.state.runId === state.runId &&
      confirmed.state.revision === state.revision && isDeepStrictEqual(confirmed.state.scope, state.scope)
      ? confirmed.state : undefined;
    for (let retry = 0; ; retry++) {
      try {
        const nextSerialized = retry === 0 ? serialized : assertStateSize(agent, normalizeAgentRunState({ ...state, revision: (state.revision ?? 0) + 1 }), policy);
        await saveStateWithRevision(agent.store, state, nextSerialized);
        confirmedCheckpoints.set(baselineState, confirmedCheckpoints.get(state)!);
        break;
      } catch (error) {
        if (!(error instanceof ConflictError) || retry >= 7) throw error;
        const loaded = await agent.store.load(state.runId, state.scope);
        const latest = loaded ? cloneState(loaded) : undefined;
        // A single revision and an otherwise identical durable payload prove a
        // cancellation-only race. Larger gaps or competing evidence fail closed.
        if (!baseline || !latest || !["cancel_requested", "cancelled"].includes(latest.status) || latest.error !== undefined ||
          latest.revision !== (baseline.revision ?? 0) + 1 ||
          !isDeepStrictEqual(withoutCancellationTransition(latest), withoutCancellationTransition(baseline))) throw error;
        baseline = latest;
        Object.assign(state, { status: latest.status, revision: latest.revision,
          cancelledAt: latest.cancelledAt, cancellationReason: latest.cancellationReason,
          cancellationCascade: latest.cancellationCascade, error: undefined });
        await refreshAgentTaskOutcome(state, agent.store);
      }
    }
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

/** Emergency terminal update has a 4 KiB allowance above the last durable
 * checkpoint, never above the failed in-memory payload. Preserve evidence and
 * the original error; do not retry any tool execution here. */
export const persistFailureState = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>, state: AgentRunState, policy?: AgentRunPolicy
) => {
  try { await persistState(agent, state, policy); }
  catch (error) {
    if (!(error instanceof ValidationError) || !/^Agent run state is \d+ bytes and exceeds maxStateBytes=\d+\./.test(error.message) || !agent.store) throw error;
    const durable = await agent.store.load(state.runId, state.scope);
    if (!durable || durable.revision !== state.revision || durable.status === "completed" || durable.status === "cancelled") throw error;
    const failure = { ...durable, ...(state.usage ? { usage: state.usage } : {}), status: "failed" as const, updatedAt: Date.now(),
      error: { message: (state.error?.message ?? error.message).slice(0, 1024), diagnosticCode: "AGENT_STATE_LIMIT" } };
    const size = (value: AgentRunState) => agent.store!.checkpointBytes?.(value) ?? new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (size(failure) > size(durable) + 4096) throw error;
    await saveStateWithRevision(agent.store, failure);
    Object.assign(state, failure);
  }
};
