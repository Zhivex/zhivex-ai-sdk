import { ValidationError } from "../errors.js";
import type { AgentRunCancellationOptions, AgentRunState, AgentRunStore, AgentRunTreeCancellationResult } from "../types.js";
import { cancelAgentState } from "./cancellation-intent.js";

export const cancelAgentRun = async (store: AgentRunStore, runId: string, options: AgentRunCancellationOptions = {}): Promise<AgentRunState | undefined> =>
  options.cascade ? (await cancelAgentRunTree(store, runId, options)).parent : cancelAgentState(store, runId, options);

export const cancelAgentRunTree = async (store: AgentRunStore, runId: string, options: AgentRunCancellationOptions = {}): Promise<AgentRunTreeCancellationResult> => {
  if (!store.findByParentRunId) throw new ValidationError('The agent run "store" must implement "findByParentRunId()" to cancel an agent run tree.');
  // Durable intent precedes descendant discovery. Late runtime admissions consult
  // this marker even through terminal intermediate nodes.
  const parent = await cancelAgentState(store, runId, { ...options, cascade: true });
  if (!parent) return { parent: undefined, children: [] };
  const scope = parent.scope ?? options.scope;
  const known = new Set([runId]);
  const children = new Map<string, AgentRunState>();
  // Recover claims concurrent with discovery without an unbounded rescan. This
  // is cooperative cancellation, not an atomic cross-run store transaction.
  for (let pass = 0; pass < 4; pass++) {
    let discovered = false;
    for (const parentId of known) {
      for (const child of await store.findByParentRunId(parentId, scope)) {
        if (child.runId === runId || child.parentRunId !== parentId ||
          child.scope?.tenantId !== scope?.tenantId || child.scope?.userId !== scope?.userId ||
          child.scope?.namespace !== scope?.namespace) continue;
        if (!known.has(child.runId)) {
          if (known.size >= 10000) throw new ValidationError("Agent cancellation tree exceeds 10000 runs; cancel remaining branches explicitly.");
          known.add(child.runId); discovered = true;
        }
        const cancelled = await cancelAgentState(store, child.runId, { ...options, scope }, true);
        if (cancelled) children.set(child.runId, cancelled);
      }
    }
    if (pass > 0 && !discovered) break;
  }
  return { parent, children: [...children.values()] };
};
