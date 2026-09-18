import { normalizeAgentRunState } from "../agent-state.js";
import { ConflictError, ValidationError } from "../errors.js";
import type {
  AgentMemoryContext,
  AgentMemoryStore,
  AgentRunLease,
  AgentRunState,
  AgentRunStore,
  AgentRunStoreScopeOptions,
  AgentStoreScope,
  AgentToolCallJournalEntry,
  ModelMessage
} from "../types.js";
import {
  scopedKey,
  resolveScope,
  cloneState,
  assertLeaseOwner,
  assertExpectedRevision,
  nextStoredState,
  scopePrefix,
  listStates,
  validateLeaseOptions,
  cloneJournalEntry,
  assertJournalRevision,
  nextJournalEntry,
  defaultMemoryKey,
  defaultMemoryMessages
} from "./shared.js";

const cloneMessages = (messages: ModelMessage[]): ModelMessage[] =>
  JSON.parse(JSON.stringify(messages)) as ModelMessage[];

export const createInMemoryAgentRunStore = (options: AgentRunStoreScopeOptions = {}): AgentRunStore => {
  const states = new Map<string, AgentRunState>();
  const idempotencyKeys = new Map<string, string>();
  const parentRunIds = new Map<string, Set<string>>();
  const leases = new Map<string, AgentRunLease>();
  const journal = new Map<string, AgentToolCallJournalEntry>();
  const runKey = (runId: string, scope?: AgentStoreScope) => scopedKey(resolveScope(options.scope, scope), runId);
  const idempotencyKey = (key: string, scope?: AgentStoreScope) => scopedKey(resolveScope(options.scope, scope), key);
  const journalKey = (runId: string, toolCallId: string, scope?: AgentStoreScope) => `${runKey(runId, scope)}:${toolCallId}`;

  const removeParentIndex = (state: AgentRunState | undefined) => {
    if (!state?.parentRunId) {
      return;
    }
    const parentKey = scopedKey(resolveScope(options.scope, state.scope), state.parentRunId);
    const children = parentRunIds.get(parentKey);
    children?.delete(runKey(state.runId, state.scope));
    if (children?.size === 0) {
      parentRunIds.delete(parentKey);
    }
  };

  return {
    reconciliationFencing: true,
    load(runId, scope) {
      const state = states.get(runKey(runId, scope));
      return state ? cloneState(normalizeAgentRunState(state)) : undefined;
    },
    findByIdempotencyKey(idempotencyKeyValue, scope) {
      const runId = idempotencyKeys.get(idempotencyKey(idempotencyKeyValue, scope));
      if (!runId) {
        return undefined;
      }
      const state = states.get(runId);
      return state ? cloneState(normalizeAgentRunState(state)) : undefined;
    },
    findByParentRunId(parentRunId, scope) {
      return [...(parentRunIds.get(scopedKey(resolveScope(options.scope, scope), parentRunId)) ?? [])].flatMap((runId) => {
        const state = states.get(runId);
        return state ? [cloneState(normalizeAgentRunState(state))] : [];
      });
    },
    claimIdempotencyKey(state) {
      const scope = resolveScope(options.scope, state.scope);
      const existingRunId = idempotencyKeys.get(idempotencyKey(state.idempotencyKey, scope));
      const existing = existingRunId ? states.get(existingRunId) : undefined;
      if (existing) {
        return { claimed: false, state: cloneState(existing) };
      }

      const normalized = normalizeAgentRunState(state);
      removeParentIndex(states.get(runKey(normalized.runId, scope)));
      const stored = cloneState({ ...normalized, ...(scope ? { scope } : {}) });
      states.set(runKey(normalized.runId, scope), stored);
      idempotencyKeys.set(idempotencyKey(state.idempotencyKey, scope), runKey(normalized.runId, scope));
      if (normalized.parentRunId) {
        const parentKey = scopedKey(scope, normalized.parentRunId);
        const children = parentRunIds.get(parentKey) ?? new Set<string>();
        children.add(runKey(normalized.runId, scope));
        parentRunIds.set(parentKey, children);
      }
      return { claimed: true, state: cloneState(stored) };
    },
    save(state, saveOptions) {
      const scope = resolveScope(options.scope, state.scope);
      assertLeaseOwner(leases.get(runKey(state.runId, scope)), saveOptions?.leaseOwnerId);
      const current = states.get(runKey(state.runId, scope));
      assertExpectedRevision(current, saveOptions?.expectedRevision);
      const normalized = nextStoredState(state, saveOptions);
      removeParentIndex(current);
      states.set(runKey(normalized.runId, scope), cloneState({ ...normalized, ...(scope ? { scope } : {}) }));
      if (normalized.idempotencyKey) {
        const owner = idempotencyKeys.get(idempotencyKey(normalized.idempotencyKey, scope));
        if (owner && owner !== runKey(normalized.runId, scope)) {
          throw new ConflictError("AgentRunState idempotency key conflict.");
        }
        idempotencyKeys.set(idempotencyKey(normalized.idempotencyKey, scope), runKey(normalized.runId, scope));
      }
      if (normalized.parentRunId) {
        const parentKey = scopedKey(scope, normalized.parentRunId);
        const children = parentRunIds.get(parentKey) ?? new Set<string>();
        children.add(runKey(normalized.runId, scope));
        parentRunIds.set(parentKey, children);
      }
    },
    delete(runId, scope) {
      const key = runKey(runId, scope);
      const state = states.get(key);
      if (state?.idempotencyKey) {
        idempotencyKeys.delete(idempotencyKey(state.idempotencyKey, state.scope));
      }
      removeParentIndex(state);
      states.delete(key);
      leases.delete(key);
      for (const journalEntryKey of journal.keys()) {
        if (journalEntryKey.startsWith(`${key}:`)) journal.delete(journalEntryKey);
      }
    },
    list(listOptions, scope) {
      const prefix = scopePrefix(resolveScope(options.scope, scope));
      return listStates([...states.entries()].filter(([key]) => key.startsWith(prefix)).map(([, state]) => state), listOptions);
    },
    deleteExpired(retention, scope) {
      const prefix = scopePrefix(resolveScope(options.scope, scope));
      const candidates = listStates([...states.entries()].filter(([key]) => key.startsWith(prefix)).map(([, state]) => state), {
        statuses: retention.statuses,
        updatedBefore: retention.before,
        limit: retention.limit ?? 1_000
      }).items;
      for (const state of candidates) this.delete?.(state.runId, state.scope);
      return candidates.length;
    },
    acquireLease(runId, leaseOptions, scope) {
      validateLeaseOptions(leaseOptions);
      const key = runKey(runId, scope);
      if (!states.has(key)) return undefined;
      const now = leaseOptions.now ?? Date.now();
      const current = leases.get(key);
      if (current && current.expiresAt > now && current.ownerId !== leaseOptions.ownerId) return undefined;
      const lease = { runId, ownerId: leaseOptions.ownerId, expiresAt: now + leaseOptions.ttlMs };
      leases.set(key, lease);
      return { ...lease };
    },
    renewLease(runId, leaseOptions, scope) {
      validateLeaseOptions(leaseOptions);
      const key = runKey(runId, scope);
      const now = leaseOptions.now ?? Date.now();
      const current = leases.get(key);
      if (!current || current.ownerId !== leaseOptions.ownerId || current.expiresAt <= now) return undefined;
      const lease = { runId, ownerId: leaseOptions.ownerId, expiresAt: now + leaseOptions.ttlMs };
      leases.set(key, lease);
      return { ...lease };
    },
    releaseLease(runId, ownerId, scope) {
      const key = runKey(runId, scope);
      if (leases.get(key)?.ownerId !== ownerId) return false;
      return leases.delete(key);
    },
    loadToolCall(runId, toolCallId, scope) {
      const entry = journal.get(journalKey(runId, toolCallId, scope));
      return entry ? cloneJournalEntry(entry) : undefined;
    },
    loadToolExecution(runId, toolCallId, scope) {
      return this.loadToolCall?.(runId, toolCallId, scope);
    },
    listToolCalls(runId, scope) {
      const prefix = `${runKey(runId, scope)}:`;
      return [...journal.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, entry]) => cloneJournalEntry(entry))
        .sort((left, right) => left.updatedAt - right.updatedAt || left.toolCallId.localeCompare(right.toolCallId));
    },
    saveToolCall(entry, journalOptions) {
      const scope = resolveScope(options.scope, entry.scope);
      if (!states.has(runKey(entry.runId, scope))) throw new ValidationError("Cannot journal a tool call for an unknown run.");
      assertLeaseOwner(leases.get(runKey(entry.runId, scope)), journalOptions?.leaseOwnerId);
      const key = journalKey(entry.runId, entry.toolCallId, scope);
      const current = journal.get(key);
      assertJournalRevision(current, journalOptions?.expectedRevision);
      const next = nextJournalEntry(entry, journalOptions);
      journal.set(key, next);
      return cloneJournalEntry(next);
    },
    claimToolExecution(entry) {
      const key = journalKey(entry.runId, entry.toolCallId, entry.scope);
      const existing = journal.get(key);
      if (existing) return { claimed: false, entry: cloneJournalEntry(existing) };
      const claimed = this.saveToolCall?.({ ...entry, status: "running", revision: 0 });
      return { claimed: true, entry: claimed as AgentToolCallJournalEntry };
    },
    completeToolExecution(entry, journalOptions) {
      return this.saveToolCall?.({ ...entry, status: entry.status === "failed" ? "failed" : "completed" }, journalOptions) as AgentToolCallJournalEntry;
    }
  };
};

export const createInMemoryAgentMemoryStore = (options: {
  key?: (context: AgentMemoryContext) => string;
  initialMessages?: Record<string, ModelMessage[]>;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
  scope?: AgentStoreScope;
} = {}): AgentMemoryStore => {
  const keyFor = (context: AgentMemoryContext) => (options.key ?? defaultMemoryKey)({ ...context, scope: resolveScope(options.scope, context.scope) });
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;
  const memories = new Map(
    Object.entries(options.initialMessages ?? {}).map(([key, messages]) => [key, cloneMessages(messages)])
  );

  return {
    load(context) {
      return cloneMessages(memories.get(keyFor(context)) ?? (context.agentId ? options.initialMessages?.[context.agentId] : undefined) ?? []);
    },
    save(context) {
      memories.set(keyFor(context), cloneMessages(selectMessages(context.state)));
    }
  };
};
