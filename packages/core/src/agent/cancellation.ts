import {
  normalizeAgentRunState
} from "../agent-state.js";
import {
  ValidationError
} from "../errors.js";
import type {
  AgentRunCancellationOptions,
  AgentRunState,
  AgentRunStore,
  AgentRunTreeCancellationResult
} from "../types.js";
import {
  cloneState
} from "./common.js";
import {
  saveStateWithRevision
} from "./state.js";

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
