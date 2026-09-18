import type { AgentDefinition, AgentRunView, AgentTelemetryEvent } from "./types.js";

// Internal per-invocation sink; independent of application telemetry failure policy.
export const runViewSink = Symbol("runViewSink");
export const runViewParent = Symbol("runViewParent");
export type ObservedAgent = AgentDefinition & {
  [runViewSink]?: (event: AgentTelemetryEvent, agent: ObservedAgent) => Promise<void>;
  [runViewParent]?: string;
};

export function createRunViewSink(publish: (run: AgentRunView) => Promise<void>) {
  const runs = new Map<string, AgentRunView>();
  return async (event: AgentTelemetryEvent, agent: ObservedAgent) => {
    if (!["run-start", "step-start", "step-finish", "state-saved", "approval-request", "run-finish", "handoff"].includes(event.type)) return;
    const previous = runs.get(event.runId);
    // Bound retained projection state independently from durable runtime state.
    if (!previous && runs.size >= 512) runs.delete(runs.keys().next().value!);
    const run: AgentRunView = { runId: event.runId, agentId: event.agentId,
      parentRunId: agent[runViewParent], name: agent.name,
      status: "running", currentStep: 0, maxSteps: agent.maxSteps ?? 10,
      ...previous, updatedAt: Date.now() };
    if (event.type === "run-start") Object.assign(run, { status: "running", provider: event.provider, modelId: event.modelId, maxSteps: event.maxSteps, startedAt: event.startedAt });
    if (event.type === "step-start") run.currentStep = event.stepIndex;
    if (event.type === "approval-request") run.status = "waiting_approval";
    if (event.type === "state-saved") run.status = event.status;
    if (event.type === "run-finish") {
      run.status = event.status;
      run.currentStep = event.state.currentStep;
      run.maxSteps = event.state.maxSteps;
      run.usage = event.state.usage;
      run.toolCalls = event.state.toolResults.length;
      run.parentRunId = event.state.parentRunId ?? run.parentRunId;
    }
    if (event.type === "handoff") run.handoffToAgentId = event.handoff.toAgentId;
    const budget = agent.policy?.budget;
    if (budget) run.budget = { maxTotalTokens: budget.maxTotalTokens, maxToolCalls: budget.maxToolCalls };
    runs.set(run.runId, run);
    await publish(run);
  };
}
