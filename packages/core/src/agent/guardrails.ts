import type {
  AgentDefinition,
  AgentGuardrailTrigger,
  AgentRunState,
  LanguageModel
} from "../types.js";
import {
  emitTelemetryEvent
} from "./telemetry.js";

const normalizeGuardrailTrigger = (value: AgentGuardrailTrigger | void): AgentGuardrailTrigger | undefined =>
  value?.triggered ? value : undefined;

export const applyGuardrailFailure = (
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

export const runGuardrails = async <TModel extends LanguageModel, TRequest>(
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
