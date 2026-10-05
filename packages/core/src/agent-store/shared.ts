import { canonicalStoreKey } from "../store-key.js";
import { normalizeAgentRunState } from "../agent-state.js";
import { ConflictError, ValidationError } from "../errors.js";
import type {
  AgentMemoryContext,
  AgentRunLease,
  AgentRunLeaseOptions,
  AgentRunListOptions,
  AgentRunPage,
  AgentRunState,
  AgentRunSaveOptions,
  AgentStoreScope,
  AgentToolCallJournalEntry,
  AgentToolCallJournalSaveOptions,
  ModelMessage
} from "../types.js";

export const cloneState = (state: AgentRunState): AgentRunState =>
  JSON.parse(JSON.stringify(normalizeAgentRunState(state))) as AgentRunState;

export const cloneJournalEntry = (entry: AgentToolCallJournalEntry): AgentToolCallJournalEntry =>
  JSON.parse(JSON.stringify(entry)) as AgentToolCallJournalEntry;

export const scopePrefix = (scope?: AgentStoreScope): string => scope
  ? `${encodeURIComponent(scope.namespace ?? "default")}:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.userId ?? "*")}:`
  : "";

export const legacyScopedKey = (scope: AgentStoreScope | undefined, value: string): string => `${scopePrefix(scope)}${value}`;

export const scopedKey = (scope: AgentStoreScope | undefined, value: string): string =>
  canonicalStoreKey("agent-run", [JSON.stringify(scope ? [scope.namespace ?? null, scope.tenantId, scope.userId ?? null] : null), value]);

export const matchesScope = (actual: AgentStoreScope | undefined, expected: AgentStoreScope | undefined): boolean =>
  actual === undefined ? expected === undefined : expected !== undefined && sameScope(actual, expected);

export const matchesRun = (state: { runId: string; scope?: AgentStoreScope }, runId: string, scope?: AgentStoreScope): boolean =>
  state.runId === runId && matchesScope(state.scope, scope);

export const journalKey = (scope: AgentStoreScope | undefined, runId: string, toolCallId: string): string =>
  canonicalStoreKey("agent-journal", [scopedKey(scope, runId), toolCallId]);

export const legacyDefaultMemoryKey = (context: AgentMemoryContext) => context.scope
  ? legacyScopedKey(context.scope, context.agentId ?? context.runId)
  : context.runId;

export const defaultMemoryKey = (context: AgentMemoryContext) =>
  canonicalStoreKey("agent-memory", [JSON.stringify(context.scope ? [context.scope.namespace ?? null, context.scope.tenantId, context.scope.userId ?? null] : null), context.scope ? context.agentId ?? context.runId : context.runId]);

export const LEGACY_MEMORY_MIGRATION_MESSAGE = "Legacy agent memory has no verifiable identity. Migrate it offline from an explicitly selected key into a new store before using canonical keys.";

export const encodeAgentMemory = (context: AgentMemoryContext, messages: ModelMessage[]) => ({
  schemaVersion: 1, memoryKey: defaultMemoryKey(context), messages
});

export const decodeAgentMemory = (context: AgentMemoryContext, value: unknown): ModelMessage[] => {
  const envelope = value as ReturnType<typeof encodeAgentMemory> | undefined;
  if (!envelope || envelope.schemaVersion !== 1 || envelope.memoryKey !== defaultMemoryKey(context) || !Array.isArray(envelope.messages)) {
    throw new ValidationError(LEGACY_MEMORY_MIGRATION_MESSAGE);
  }
  return envelope.messages;
};

export const sameScope = (left: AgentStoreScope, right: AgentStoreScope): boolean =>
  left.tenantId === right.tenantId && left.userId === right.userId && left.namespace === right.namespace;

const validateScope = (value: AgentStoreScope | undefined): AgentStoreScope | undefined => {
  if (!value) return undefined;
  if (typeof value.tenantId !== "string" || value.tenantId.length === 0) {
    throw new ValidationError('Agent store scope "tenantId" must be a non-empty string.');
  }
  for (const field of ["userId", "namespace"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field]!.length === 0)) {
      throw new ValidationError(`Agent store scope "${field}" must be a non-empty string when provided.`);
    }
  }
  return value;
};

export const resolveScope = (configured: AgentStoreScope | undefined, operation: AgentStoreScope | undefined): AgentStoreScope | undefined => {
  configured = validateScope(configured);
  operation = validateScope(operation);
  if (configured && operation && !sameScope(configured, operation)) {
    throw new ValidationError("The operation scope does not match the store scope.");
  }
  return operation ?? configured;
};

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const normalizeLimit = (value: number | undefined, fallback = 50): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new ValidationError('The "limit" option must be an integer between 1 and 1000.');
  }
  return value;
};

export const validateLeaseOptions = (options: AgentRunLeaseOptions): void => {
  if (!options.ownerId.trim()) throw new ValidationError('The lease "ownerId" must not be empty.');
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 86_400_000) {
    throw new ValidationError('The lease "ttlMs" must be an integer between 1 and 86400000.');
  }
  if (options.now !== undefined && (!Number.isSafeInteger(options.now) || options.now < 0)) {
    throw new ValidationError('The lease "now" value must be a non-negative integer.');
  }
};

const encodeCursor = (state: AgentRunState): string =>
  Buffer.from(JSON.stringify([state.updatedAt ?? state.startedAt ?? 0, state.runId, scopedKey(state.scope, state.runId)]), "utf8").toString("base64url");

const decodeCursor = (cursor: string | undefined): readonly [number, string, string?] | undefined => {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3) || typeof value[0] !== "number" || !Number.isFinite(value[0]) || typeof value[1] !== "string" || (value.length === 3 && typeof value[2] !== "string")) {
      throw new Error("invalid");
    }
    return [value[0], value[1], value[2]];
  } catch {
    throw new ValidationError('The "cursor" option is invalid.');
  }
};

/** Shared validation for stores that push pagination down to their database. */
export const parseAgentRunListOptions = (options: AgentRunListOptions = {}) => ({
  limit: normalizeLimit(options.limit),
  cursor: decodeCursor(options.cursor)
});

export const listStates = (states: Iterable<AgentRunState>, options: AgentRunListOptions = {}, hydrate: (state: AgentRunState) => AgentRunState = cloneState): AgentRunPage => {
  const { limit, cursor } = parseAgentRunListOptions(options);
  const filtered = [...states]
    .filter((state) => options.agentId === undefined || state.agentId === options.agentId)
    .filter((state) => options.parentRunId === undefined || state.parentRunId === options.parentRunId)
    .filter((state) => !options.statuses?.length || options.statuses.includes(state.status))
    .filter((state) => options.updatedAfter === undefined || (state.updatedAt ?? 0) > options.updatedAfter)
    .filter((state) => options.updatedBefore === undefined || (state.updatedAt ?? 0) < options.updatedBefore)
    .sort((left, right) => {
      const timeOrder = (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0);
      if (timeOrder) return timeOrder;
      if (right.runId !== left.runId) return right.runId > left.runId ? 1 : -1;
      const leftKey = scopedKey(left.scope, left.runId);
      const rightKey = scopedKey(right.scope, right.runId);
      return rightKey > leftKey ? 1 : rightKey < leftKey ? -1 : 0;
    })
    .filter((state) => {
      if (!cursor) return true;
      const time = state.updatedAt ?? state.startedAt ?? 0;
      if (time !== cursor[0]) return time < cursor[0];
      if (state.runId !== cursor[1]) return state.runId < cursor[1];
      // Legacy cursors have no scope boundary; retain their original semantics.
      return cursor[2] !== undefined && scopedKey(state.scope, state.runId) < cursor[2];
    });
  const page = filtered.slice(0, limit);
  return {
    items: page.map(hydrate),
    ...(filtered.length > limit && page.at(-1) ? { nextCursor: encodeCursor(page.at(-1)!) } : {})
  };
};

export const assertJournalRevision = (
  current: AgentToolCallJournalEntry | undefined,
  expectedRevision: number | undefined
) => {
  if (expectedRevision !== undefined && (!current || current.revision !== expectedRevision)) {
    throw new ConflictError("Agent tool-call journal revision conflict.");
  }
};

export const assertLeaseOwner = (lease: AgentRunLease | undefined, ownerId: string | undefined) => {
  if (ownerId !== undefined && (!lease || lease.ownerId !== ownerId || lease.expiresAt <= Date.now())) {
    throw new ConflictError("Reconciliation lost execution ownership.");
  }
};

export const nextJournalEntry = (
  entry: AgentToolCallJournalEntry,
  options?: AgentToolCallJournalSaveOptions
): AgentToolCallJournalEntry => {
  if (!entry.runId || !entry.toolCallId || !entry.toolName || !entry.idempotencyKey) {
    throw new ValidationError("Tool-call journal entries require runId, toolCallId, toolName, and idempotencyKey.");
  }
  return cloneJournalEntry({
    ...entry,
    revision: options?.expectedRevision === undefined ? entry.revision : options.expectedRevision + 1
  });
};

export const defaultMemoryMessages = (state: AgentRunState): ModelMessage[] => {
  const lastAssistantMessage = [...state.messages].reverse().find((message) => message.role === "assistant");
  return lastAssistantMessage ? [lastAssistantMessage] : [];
};

export const validateIdentifier = (value: string, fieldName: string): string => {
  if (!identifierPattern.test(value)) {
    throw new ValidationError(`The "${fieldName}" option must match the SQL identifier pattern [A-Za-z_][A-Za-z0-9_]*.`);
  }
  return value;
};

export const getRecordField = (value: unknown, candidates: string[]): unknown => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const candidate of candidates) {
    if (candidate in record) {
      return record[candidate];
    }
  }

  return undefined;
};

export const assertExpectedRevision = (
  current: AgentRunState | undefined,
  expectedRevision: number | undefined
) => {
  if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
    throw new ConflictError("AgentRunState revision conflict.");
  }
};

export const nextStoredState = (state: AgentRunState, options?: AgentRunSaveOptions): AgentRunState => {
  const normalized = normalizeAgentRunState(state);
  return options?.expectedRevision === undefined
    ? normalized
    : { ...normalized, revision: options.expectedRevision + 1 };
};
