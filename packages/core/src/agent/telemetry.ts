import {
  runViewSink,
  type ObservedAgent
} from "../agent-run-view.js";
import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentDefinition,
  AgentRunState,
  AgentStep,
  AgentStatus,
  AgentTelemetryEvent,
  LanguageModel,
  ModelMessage,
  ToolApprovalEvent
} from "../types.js";
import {
  cloneState
} from "./common.js";

export const invokeOperationalHook = async <TModel extends LanguageModel, TResult>(
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

export const emitTelemetryEvent = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  event: AgentTelemetryEvent
) => {
  await (agent as ObservedAgent)[runViewSink]?.(event, agent as ObservedAgent);
  await invokeOperationalHook(
    agent,
    "telemetry",
    event.type,
    event.runId,
    agent.onTelemetryEvent ? () => agent.onTelemetryEvent!(event) : undefined,
    undefined
  );
};

export const emitInvocationStartTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  runId: string,
  startedAt: number,
  maxSteps: number
) => {
  try {
    await agent.onTelemetryEvent?.startInvocation?.({
      runId,
      agentId: agent.id,
      agentName: agent.name,
      provider: agent.model.provider,
      modelId: agent.model.modelId,
      maxSteps,
      startedAt
    });
  } catch {
    // Invocation telemetry is best-effort and cannot replace setup/business errors.
  }
};

export const emitInvocationFinishTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  runId: string,
  status: AgentStatus,
  error: Error | undefined
) => {
  try {
    await agent.onTelemetryEvent?.finishInvocation?.({
      runId,
      agentId: agent.id,
      agentName: agent.name,
      status,
      error,
      finishedAt: Date.now()
    });
  } catch {
    // Invocation telemetry is best-effort and cannot replace setup/business errors.
  }
};

export const withAgentTelemetryRunContext = <TModel extends LanguageModel, TResult>(
  agent: AgentDefinition<TModel>,
  runId: string,
  callback: () => TResult | Promise<TResult>
): Promise<TResult> => {
  const telemetryObserver = agent.onTelemetryEvent;
  const wrapper = telemetryObserver?.withRunContext;
  if (!wrapper) return Promise.resolve().then(callback);

  let execution: Promise<TResult> | undefined;
  let callbackError: unknown;
  let callbackFailed = false;
  const executeOnce = () => {
    execution ??= Promise.resolve()
      .then(callback)
      .catch((error) => {
        callbackFailed = true;
        callbackError = error;
        throw error;
      });
    return execution;
  };

  return Promise.resolve()
    .then(async () => {
      await wrapper.call(telemetryObserver, runId, executeOnce);
      return executeOnce();
    })
    .catch(async (wrapperError) => {
      if (callbackFailed) throw callbackError;
      try {
        return await executeOnce();
      } catch (executionError) {
        throw callbackFailed ? callbackError : executionError ?? wrapperError;
      }
    });
};

export const emitFinalizedStepTelemetry = async <TModel extends LanguageModel>(
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

export const emitApprovalTelemetry = async <TModel extends LanguageModel>(
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

export const emitToolApprovalTelemetry = async <TModel extends LanguageModel>(
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

export const emitRunStartTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState,
  memoryMessages: ModelMessage[],
  approvals: AgentApprovalResponse[] | undefined,
  invocationStartedAt: number
) => {
    await emitTelemetryEvent(agent, {
      type: "run-start",
      runId: state.runId,
      agentId: state.agentId,
      agentName: agent.name,
      provider: state.provider,
      modelId: state.modelId,
      maxSteps: state.maxSteps,
      startedAt: invocationStartedAt
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

export const emitRunFinishTelemetry = async <TModel extends LanguageModel>(
  agent: AgentDefinition<TModel>,
  state: AgentRunState
) => {
  await emitTelemetryEvent(agent, {
    type: "run-finish",
    runId: state.runId,
    agentId: state.agentId,
    agentName: agent.name,
    status: state.status,
    state: cloneState(state),
    finishedAt: Date.now()
  });
};
