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

export const scopedKey = (scope: AgentStoreScope | undefined, value: string): string => `${scopePrefix(scope)}${value}`;

export const defaultMemoryKey = (context: AgentMemoryContext) => context.scope
  ? scopedKey(context.scope, context.agentId ?? context.runId)
  : context.runId;

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
  Buffer.from(JSON.stringify([state.updatedAt ?? state.startedAt ?? 0, state.runId]), "utf8").toString("base64url");

const decodeCursor = (cursor: string | undefined): readonly [number, string] | undefined => {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "string") {
      throw new Error("invalid");
    }
    return [value[0], value[1]];
  } catch {
    throw new ValidationError('The "cursor" option is invalid.');
  }
};

export const listStates = (states: Iterable<AgentRunState>, options: AgentRunListOptions = {}): AgentRunPage => {
  const limit = normalizeLimit(options.limit);
  const cursor = decodeCursor(options.cursor);
  const filtered = [...states]
    .filter((state) => options.agentId === undefined || state.agentId === options.agentId)
    .filter((state) => options.parentRunId === undefined || state.parentRunId === options.parentRunId)
    .filter((state) => !options.statuses?.length || options.statuses.includes(state.status))
    .filter((state) => options.updatedAfter === undefined || (state.updatedAt ?? 0) > options.updatedAfter)
    .filter((state) => options.updatedBefore === undefined || (state.updatedAt ?? 0) < options.updatedBefore)
    .sort((left, right) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0) || right.runId.localeCompare(left.runId))
    .filter((state) => !cursor || (state.updatedAt ?? state.startedAt ?? 0) < cursor[0] || ((state.updatedAt ?? state.startedAt ?? 0) === cursor[0] && state.runId < cursor[1]));
  const page = filtered.slice(0, limit);
  return {
    items: page.map(cloneState),
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
