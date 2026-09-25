import type { AgentChildRun, AgentDefinition, AgentRunState, AgentRunStore } from "../types.js";
import { countToolCallsInSteps, countToolErrors } from "./common.js";

export const runCheckpoints = new WeakMap<AgentRunState, AgentRunState>();

// Private runtime observation also works without a store and when saving fails.
export const childStateObserver = Symbol("childStateObserver");
export type ChildObservedAgent = AgentDefinition & {
  [childStateObserver]?: (state: AgentRunState) => void;
};
export const observeChildState = (agent: AgentDefinition, state: AgentRunState) => {
  (agent as ChildObservedAgent)[childStateObserver]?.(state);
};

export const projectChildRun = (state: AgentRunState): AgentChildRun => ({
  runId: state.runId,
  agentId: state.agentId,
  parentRunId: state.parentRunId,
  toolName: typeof state.metadata?.subagentToolName === "string" ? state.metadata.subagentToolName : undefined,
  toolCallId: typeof state.metadata?.subagentToolCallId === "string" ? state.metadata.subagentToolCallId : undefined,
  status: state.status,
  outputText: state.outputText,
  steps: state.currentStep,
  toolCalls: countToolCallsInSteps(state.steps),
  toolErrors: countToolErrors(state.toolResults),
  usage: state.usage,
  childRuns: state.childRuns,
  unknownCompactionUsage: state.compactionAttempts?.some(attempt => attempt.status !== "confirmed") ?? false,
  startedAt: state.startedAt,
  updatedAt: state.updatedAt,
  error: state.error,
  metadata: state.metadata,
  ...(state.status === "waiting_approval" && state.pendingApprovals.length ? { resumeState: state } : {})
});

export const upsertChildRun = (state: AgentRunState, child: AgentChildRun) => {
  // Identity is the run ID, not a provider tool-call ID which can repeat in later steps.
  const children = state.childRuns ??= [];
  const index = children.findIndex(existing => existing.runId === child.runId);
  if (index < 0) children.push(child);
  else children[index] = child;
};

/** Recover reverse links without executing a model or a tool. Store queries are scope-bound. */
export const reconcileChildRuns = async (state: AgentRunState, store?: AgentRunStore, seen = new Set<string>()): Promise<void> => {
  if (!store?.findByParentRunId || seen.has(state.runId)) return;
  seen.add(state.runId);
  for (const child of await store.findByParentRunId(state.runId, state.scope)) {
    if (child.parentRunId !== state.runId || seen.has(child.runId) ||
      child.scope?.tenantId !== state.scope?.tenantId ||
      child.scope?.userId !== state.scope?.userId ||
      child.scope?.namespace !== state.scope?.namespace) continue;
    await reconcileChildRuns(child, store, seen);
    const existing = state.childRuns?.find(entry => entry.runId === child.runId);
    // A failed save may leave the in-memory terminal observation newer than the store.
    if (existing && (
      (existing.updatedAt ?? 0) > (child.updatedAt ?? 0) ||
      (existing.status === "failed" && child.status === "running" &&
        (existing.updatedAt ?? 0) >= (child.updatedAt ?? 0))
    )) continue;
    const summary = projectChildRun(child);
    upsertChildRun(state, { ...existing, ...summary, toolCallId: summary.toolCallId ?? existing?.toolCallId });
  }
};

export const loadFailureState = async (state: AgentRunState, store?: AgentRunStore): Promise<AgentRunState> => {
  const checkpoint = runCheckpoints.get(state) ?? state;
  let durable = checkpoint;
  try { durable = await store?.load(state.runId, state.scope) ?? checkpoint; } catch { /* preserve primary error */ }
  // A provider response is already billable even when its checkpoint save failed.
  // Keep its confirmed usage while retaining the store's CAS revision.
  if (durable.status !== "cancelled" && durable.status !== "cancel_requested" &&
    checkpoint.currentStep >= durable.currentStep && (checkpoint.updatedAt ?? 0) >= (durable.updatedAt ?? 0)) {
    durable = { ...durable, ...checkpoint, revision: durable.revision };
  }
  for (const child of state.childRuns ?? []) upsertChildRun(durable, child);
  return durable;
};
