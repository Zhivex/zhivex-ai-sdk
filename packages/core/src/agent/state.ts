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
  await store.save(serializedNextState === undefined ? cloneState(nextState) : JSON.parse(serializedNextState) as AgentRunState, { expectedRevision });
  state.revision = nextRevision;
};

export const claimAgentExecution = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState
) => {
  state.status = "running";
  state.updatedAt = Date.now();
  const serialized = assertStateSize(agent, agent.store ? normalizeAgentRunState({ ...state, revision: (state.revision ?? 0) + 1 }) : state);
  if (agent.store) {
    await saveStateWithRevision(agent.store, state, serialized);
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
  const serialized = JSON.stringify(state);
  const bytes = new TextEncoder().encode(serialized).byteLength;
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
  policy?: AgentRunPolicy
) => {
  state.updatedAt = Date.now();
  await refreshAgentTaskOutcome(state, agent.store);
  const serialized = assertStateSize(agent, agent.store ? normalizeAgentRunState({ ...state, revision: (state.revision ?? 0) + 1 }) : state, policy);
  if (agent.store) {
    await saveStateWithRevision(agent.store, state, serialized);
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
