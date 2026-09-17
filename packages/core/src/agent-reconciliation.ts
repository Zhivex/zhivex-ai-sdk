import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ConflictError, ValidationError } from "./errors.js";
import { normalizeAgentRunState } from "./agent-state.js";
import type { AgentRunState, AgentRunStore, AgentTaskOutcome, AgentToolCallJournalEntry, AgentToolReconciliationEvidence } from "./types.js";

/** Technical completion is not proof of business success; pending effects always take precedence. */
export async function refreshAgentTaskOutcome(state: AgentRunState, store?: AgentRunStore): Promise<void> {
  const entries = await store?.listToolCalls?.(state.runId, state.scope);
  const operations = entries?.filter(entry => entry.status === "running" || entry.status === "pending" || (entry.reconciliation !== undefined && !state.reconciliations?.some(record => isDeepStrictEqual(record, entry.reconciliation)))).map(entry => ({
    toolCallId: entry.toolCallId, toolName: entry.toolName, idempotencyKey: entry.idempotencyKey,
    diagnosticCode: "INDETERMINATE_TOOL_EXECUTION" as const
  })) ?? state.taskOutcome?.operations ?? [];
  const status: AgentTaskOutcome["status"] = operations.length ? "needs_reconciliation"
    : state.status === "completed" ? state.approvalHistory?.some(item => !item.approve) ? "denied" : "resolved"
    : ["failed", "cancelled", "timed_out"].includes(state.status) ? "failed" : "in_progress";
  state.taskOutcome = { status, operations };
}

export interface ReconcileAgentToolExecutionOptions {
  store: AgentRunStore;
  evidence: AgentToolReconciliationEvidence;
  /** Must verify identity, arguments AND output against authenticated external evidence. Never delegate to a model. */
  verifyEvidence: (evidence: Readonly<AgentToolReconciliationEvidence>, entry: Readonly<AgentToolCallJournalEntry>) => boolean | Promise<boolean>;
}

/** Confirm an external effect without executing a tool. Resume the returned queued state to finish the task. */
export async function reconcileAgentToolExecution(options: ReconcileAgentToolExecutionOptions): Promise<AgentRunState> {
  const { store } = options;
  if (!store.reconciliationFencing || !store.acquireLease || !store.renewLease || !store.releaseLease || !store.loadToolExecution || !store.completeToolExecution || !store.listToolCalls) {
    throw new ValidationError("Reconciliation requires a store with lease-fenced journal and state writes.");
  }
  const evidence = structuredClone(options.evidence);
  for (const key of ["operationId", "runId", "toolCallId", "toolName", "idempotencyKey", "source"] as const) {
    if (typeof evidence[key] !== "string" || !evidence[key].trim()) throw new ValidationError(`Reconciliation evidence requires ${key}.`);
  }
  if (evidence.input === undefined || evidence.output === undefined || evidence.proof === undefined) throw new ValidationError("Reconciliation requires input, output and proof.");
  // The JSON round trip also prevents non-durable values from silently changing after verification.
  if (!isDeepStrictEqual(evidence, JSON.parse(JSON.stringify(evidence)))) throw new ValidationError("Evidence must be JSON-compatible.");
  const ownerId = randomUUID();
  const leaseOptions = { ownerId, ttlMs: 30_000 };
  if (!await store.acquireLease(evidence.runId, leaseOptions, evidence.scope)) throw new ConflictError("Agent execution is owned by another worker or does not exist.");
  try {
    const state = normalizeAgentRunState(await store.load(evidence.runId, evidence.scope));
    if (["cancelled", "cancel_requested"].includes(state.status)) throw new ConflictError("Cancelled runs cannot be reopened by reconciliation.");
    const entry = await store.loadToolExecution(evidence.runId, evidence.toolCallId, evidence.scope);
    if (!entry || entry.runId !== evidence.runId || entry.toolName !== evidence.toolName || entry.idempotencyKey !== evidence.idempotencyKey || !isDeepStrictEqual(state.scope, evidence.scope) || !isDeepStrictEqual(entry.scope, evidence.scope) || !isDeepStrictEqual(entry.input, evidence.input)) {
      throw new ValidationError("Evidence does not match the persisted operation and scope.");
    }
    if (entry.reconciliation && !isDeepStrictEqual(entry.reconciliation.evidence, evidence)) throw new ConflictError("Contradictory reconciliation evidence.");
    if (!entry.reconciliation && entry.status !== "running") throw new ConflictError("Only indeterminate running operations can be reconciled.");
    if (await options.verifyEvidence(structuredClone(evidence), structuredClone(entry)) !== true) throw new ValidationError("External evidence was not verified.");
    if (!await store.renewLease(evidence.runId, leaseOptions, evidence.scope)) throw new ConflictError("Reconciliation lost execution ownership.");
    if (state.reconciliations?.some(record => isDeepStrictEqual(record.evidence, evidence))) return state;
    await refreshAgentTaskOutcome(state, store);
    const record = entry.reconciliation ?? { evidence, decision: "confirmed" as const, verifiedAt: Date.now(), previousOutcome: state.taskOutcome, previousOutputText: state.outputText };
    if (!entry.reconciliation) {
      await store.completeToolExecution({ ...entry, status: "completed", output: evidence.output, error: undefined, reconciliation: record, completedAt: Date.now(), updatedAt: Date.now() }, { expectedRevision: entry.revision, leaseOwnerId: ownerId });
    }
    // Journal is the write-ahead decision: if the process dies before state save, retry repairs the projection.
    state.reconciliations = [...(state.reconciliations ?? []), record];
    const matchingCalls = state.messages.flatMap(message => message.parts).flatMap(part => part.type === "tool-call" && part.toolCall.name === entry.toolName && isDeepStrictEqual(part.toolCall.input, entry.input) ? [part.toolCall.id] : []);
    const providerId = entry.providerToolCallId ?? (new Set(matchingCalls).size === 1 ? matchingCalls[0] : undefined);
    if (providerId) {
      const replacement = { toolCallId: providerId, toolName: entry.toolName, isError: false, output: evidence.output };
      state.toolResults = state.toolResults.map(result => result.toolCallId === providerId ? replacement : result);
      state.messages = state.messages.map(message => ({ ...message, parts: message.parts.map(part => part.type === "tool-result" && part.toolResult.toolCallId === providerId ? { ...part, toolResult: replacement } : part) }));
    }
    // Preserve previous transcript/steps; authoritative evidence is explicitly supplied for the continuation.
    state.messages.push({ role: "user", parts: [{ type: "text", text: `Verified external tool reconciliation (do not repeat the mutation): ${JSON.stringify({ toolName: entry.toolName, idempotencyKey: entry.idempotencyKey, output: evidence.output })}. Continue using this confirmed result.` }] });
    state.status = "queued";
    state.outputText = "";
    state.finalOutput = undefined;
    state.error = undefined;
    state.finishReason = undefined;
    state.providerFinishReason = undefined;
    state.updatedAt = Date.now();
    await refreshAgentTaskOutcome(state, store);
    const expectedRevision = state.revision ?? 0;
    await store.save(state, { expectedRevision, leaseOwnerId: ownerId });
    return normalizeAgentRunState(await store.load(state.runId, state.scope));
  } finally {
    await store.releaseLease(evidence.runId, ownerId, evidence.scope);
  }
}
