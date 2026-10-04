import { normalizeAgentRunState } from "../agent-state.js";
import { ConflictError, ValidationError } from "../errors.js";
import type { AgentRunCancellationOptions, AgentRunState, AgentRunStore } from "../types.js";
import { cloneState } from "./common.js";

const isTerminal = (state: AgentRunState) => ["completed", "failed", "cancelled", "timed_out"].includes(state.status);
const isCancelled = (state: AgentRunState) => state.status === "cancel_requested" || state.status === "cancelled";
const MAX_CANCELLATION_RETRIES = 32;

export const cancelAgentState = async (
  store: AgentRunStore, runId: string, options: AgentRunCancellationOptions,
  preserveTerminal = false, freshState?: AgentRunState
): Promise<AgentRunState | undefined> => {
  for (let retry = 0; retry < MAX_CANCELLATION_RETRIES; retry++) {
    const current = await store.load(runId, options.scope) ?? freshState;
    if (!current) return undefined;
    if (preserveTerminal && isTerminal(current)) return cloneState(current);
    // Repeated requests never downgrade final cancellation or replace its reason.
    if (isCancelled(current) && (current.status === "cancelled" || options.mode !== "final") &&
      (!options.cascade || current.cancellationCascade)) return cloneState(current);
    const cancelledAt = current.cancelledAt ?? Date.now();
    const revision = current.revision ?? 0;
    const state = normalizeAgentRunState({
      ...current, revision: revision + 1,
      status: options.mode === "final" || current.status === "cancelled" ? "cancelled" : "cancel_requested",
      cancelledAt, cancellationReason: current.cancellationReason ?? options.reason,
      cancellationCascade: current.cancellationCascade || options.cascade || undefined,
      updatedAt: Math.max(Date.now(), current.updatedAt ?? 0),
      // Cancellation clears execution failures, but dispatched-request receipts
      // must survive finalization so uncertain consumption remains explicit.
      error: current.error?.category === "provider-tool-call" && current.error.providerRequestCount !== undefined ? current.error : undefined
    });
    try { await store.save(state, { expectedRevision: revision }); return cloneState(state); }
    catch (error) { if (!(error instanceof ConflictError) || retry === MAX_CANCELLATION_RETRIES - 1) throw error; }
  }
};

/** Scope-bound ancestor checks recover late claims; arbitrary stores must keep
 * parent links and cancellation intent durable. No global admission lock exists. */
export const synchronizeAgentCancellation = async (store: AgentRunStore | undefined, state: AgentRunState): Promise<boolean> => {
  if (!store) return isCancelled(state);
  const current = await store.load(state.runId, state.scope);
  if (current && isCancelled(current)) { Object.assign(state, current); return true; }
  let parentId = state.parentRunId;
  const seen = new Set([state.runId]);
  for (let depth = 0; parentId; depth++) {
    if (depth >= 128 || seen.has(parentId)) throw new ValidationError("Agent ancestry is cyclic or exceeds 128 runs.");
    seen.add(parentId);
    const parent = await store.load(parentId, state.scope);
    if (!parent) break;
    if (parent.cancellationCascade && isCancelled(parent)) {
      const cancelled = await cancelAgentState(store, state.runId, {
        mode: parent.status === "cancelled" ? "final" : "request", reason: parent.cancellationReason, scope: state.scope
      }, true, state);
      if (cancelled) Object.assign(state, cancelled);
      return cancelled !== undefined && isCancelled(cancelled);
    }
    parentId = parent.parentRunId;
  }
  return false;
};

export class AgentCancellationError extends Error {
  constructor(readonly state: AgentRunState) { super("Agent run was cancelled."); }
}

export const assertAgentNotCancelled = async (store: AgentRunStore | undefined, state: AgentRunState) => {
  if (await synchronizeAgentCancellation(store, state)) throw new AgentCancellationError(cloneState(state));
};

/** Failure handling preserves an authoritative cancellation without allowing a
 * secondary store outage to mask the original execution error. */
export const cancellationAfterFailure = async (store: AgentRunStore | undefined, state: AgentRunState) => {
  try {
    const candidate = cloneState(state);
    return await synchronizeAgentCancellation(store, candidate) ? candidate : undefined;
  } catch { return undefined; }
};
