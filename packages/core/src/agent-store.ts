import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { normalizeAgentRunState } from "./agent-state.js";
import { ConflictError, ValidationError } from "./errors.js";
import { assertPostgresClient } from "./postgres-client.js";
import type {
  AgentMemoryContext,
  AgentMemoryStore,
  AgentRunLease,
  AgentRunLeaseOptions,
  AgentRunListOptions,
  AgentRunPage,
  AgentRunRetentionOptions,
  AgentRunState,
  AgentRunSaveOptions,
  AgentRunStore,
  AgentRunStoreScopeOptions,
  AgentStoreScope,
  AgentToolCallJournalEntry,
  AgentToolCallJournalSaveOptions,
  ModelMessage,
  PostgresAgentMemoryStoreOptions,
  PostgresAgentRunStoreOptions,
  PostgresClientLike,
  SqliteAgentMemoryStoreOptions,
  SqliteAgentRunStoreOptions,
  SqliteDatabaseLike,
  SqliteStatementLike
} from "./types.js";

const cloneState = (state: AgentRunState): AgentRunState =>
  JSON.parse(JSON.stringify(normalizeAgentRunState(state))) as AgentRunState;
const cloneMessages = (messages: ModelMessage[]): ModelMessage[] =>
  JSON.parse(JSON.stringify(messages)) as ModelMessage[];

const cloneJournalEntry = (entry: AgentToolCallJournalEntry): AgentToolCallJournalEntry =>
  JSON.parse(JSON.stringify(entry)) as AgentToolCallJournalEntry;

const scopePrefix = (scope?: AgentStoreScope): string => scope
  ? `${encodeURIComponent(scope.namespace ?? "default")}:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.userId ?? "*")}:`
  : "";
const scopedKey = (scope: AgentStoreScope | undefined, value: string): string => `${scopePrefix(scope)}${value}`;

const defaultMemoryKey = (context: AgentMemoryContext) => context.scope
  ? scopedKey(context.scope, context.agentId ?? context.runId)
  : context.runId;

const sameScope = (left: AgentStoreScope, right: AgentStoreScope): boolean =>
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

const resolveScope = (configured: AgentStoreScope | undefined, operation: AgentStoreScope | undefined): AgentStoreScope | undefined => {
  configured = validateScope(configured);
  operation = validateScope(operation);
  if (configured && operation && !sameScope(configured, operation)) {
    throw new ValidationError("The operation scope does not match the store scope.");
  }
  return operation ?? configured;
};
const fileNameForAgentStoreKey = (key: string): string => `${encodeURIComponent(key)}.json`;
const fileNameForIdempotencyKey = (key: string): string =>
  `.idempotency-${createHash("sha256").update(key).digest("hex")}.json`;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const normalizeLimit = (value: number | undefined, fallback = 50): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new ValidationError('The "limit" option must be an integer between 1 and 1000.');
  }
  return value;
};

const validateLeaseOptions = (options: AgentRunLeaseOptions): void => {
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

const listStates = (states: Iterable<AgentRunState>, options: AgentRunListOptions = {}): AgentRunPage => {
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

const assertJournalRevision = (
  current: AgentToolCallJournalEntry | undefined,
  expectedRevision: number | undefined
) => {
  if (expectedRevision !== undefined && (!current || current.revision !== expectedRevision)) {
    throw new ConflictError("Agent tool-call journal revision conflict.");
  }
};

const nextJournalEntry = (
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

const defaultMemoryMessages = (state: AgentRunState): ModelMessage[] => {
  const lastAssistantMessage = [...state.messages].reverse().find((message) => message.role === "assistant");
  return lastAssistantMessage ? [lastAssistantMessage] : [];
};

const validateIdentifier = (value: string, fieldName: string): string => {
  if (!identifierPattern.test(value)) {
    throw new ValidationError(`The "${fieldName}" option must match the SQL identifier pattern [A-Za-z_][A-Za-z0-9_]*.`);
  }
  return value;
};

const getRecordField = (value: unknown, candidates: string[]): unknown => {
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

const prepareSqliteStatement = <TResult extends Record<string, unknown>>(
  db: SqliteDatabaseLike,
  sql: string
): SqliteStatementLike<TResult> => {
  if (typeof db.prepare === "function") {
    return db.prepare<TResult>(sql);
  }

  if (typeof db.query === "function") {
    return db.query<TResult>(sql);
  }

  throw new ValidationError('The "db" option must expose either a "prepare()" or "query()" method.');
};

const initializeSqliteTable = (db: SqliteDatabaseLike, sql: string) => {
  db.exec(sql);
};

const assertExpectedRevision = (
  current: AgentRunState | undefined,
  expectedRevision: number | undefined
) => {
  if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
    throw new ConflictError("AgentRunState revision conflict.");
  }
};

const nextStoredState = (state: AgentRunState, options?: AgentRunSaveOptions): AgentRunState => {
  const normalized = normalizeAgentRunState(state);
  return options?.expectedRevision === undefined
    ? normalized
    : { ...normalized, revision: options.expectedRevision + 1 };
};

const ensurePostgresTable = (() => {
  const initializedTables = new WeakMap<PostgresClientLike, Map<string, Promise<void>>>();

  return async (client: PostgresClientLike, tableName: string, createSql: string) => {
    let tables = initializedTables.get(client);
    if (!tables) {
      tables = new Map<string, Promise<void>>();
      initializedTables.set(client, tables);
    }

    let initialization = tables.get(tableName);
    if (!initialization) {
      initialization = Promise.resolve(client.query(createSql, [])).then(() => undefined);
      tables.set(tableName, initialization);
    }

    await initialization;
  };
})();

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

export const createFileAgentRunStore = (options: AgentRunStoreScopeOptions & {
  directory: string;
}): AgentRunStore => {
  const effectiveScope = (scope?: AgentStoreScope) => resolveScope(options.scope, scope);
  const runPath = (runId: string, scope?: AgentStoreScope) => path.join(options.directory, fileNameForAgentStoreKey(scopedKey(effectiveScope(scope), runId)));
  const idempotencyPath = (key: string, scope?: AgentStoreScope) => path.join(options.directory, fileNameForIdempotencyKey(scopedKey(effectiveScope(scope), key)));
  const leasePath = (runId: string, scope?: AgentStoreScope) => path.join(options.directory, `.lease-${createHash("sha256").update(scopedKey(effectiveScope(scope), runId)).digest("hex")}.json`);
  const toolPath = (runId: string, toolCallId: string, scope?: AgentStoreScope) => path.join(options.directory, `.tool-${createHash("sha256").update(`${scopedKey(effectiveScope(scope), runId)}:${toolCallId}`).digest("hex")}.json`);

  const load = async (runId: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> => {
    try {
      const content = await fs.readFile(runPath(runId, scope), "utf8");
      return normalizeAgentRunState(JSON.parse(content) as AgentRunState);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };

  const findByIdempotencyKey = async (idempotencyKey: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> => {
    const targetScope = effectiveScope(scope);
    try {
      const marker = await fs.readFile(idempotencyPath(idempotencyKey, scope), "utf8");
      const claimed = normalizeAgentRunState(JSON.parse(marker) as AgentRunState);
      return (await load(claimed.runId, scope)) ?? claimed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    let entries: string[];
    try {
      entries = await fs.readdir(options.directory);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error);
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) {
        continue;
      }
      const content = await fs.readFile(path.join(options.directory, entry), "utf8");
      const state = normalizeAgentRunState(JSON.parse(content) as AgentRunState);
      if (state.idempotencyKey === idempotencyKey && (!targetScope || (state.scope && sameScope(state.scope, targetScope)))) {
        return state;
      }
    }

    return undefined;
  };

  return {
    load,
    findByIdempotencyKey,
    async findByParentRunId(parentRunId, scope) {
      const targetScope = effectiveScope(scope);
      let entries: string[];
      try {
        entries = await fs.readdir(options.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }

      const states: AgentRunState[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.startsWith(".")) {
          continue;
        }
        const content = await fs.readFile(path.join(options.directory, entry), "utf8");
        const state = normalizeAgentRunState(JSON.parse(content) as AgentRunState);
        if (state.parentRunId === parentRunId && (!targetScope || (state.scope && sameScope(state.scope, targetScope)))) {
          states.push(state);
        }
      }

      return states;
    },
    async claimIdempotencyKey(state) {
      await fs.mkdir(options.directory, { recursive: true });
      const scope = effectiveScope(state.scope);
      const normalized = normalizeAgentRunState({ ...state, ...(scope ? { scope } : {}) });
      try {
        await fs.writeFile(idempotencyPath(state.idempotencyKey, scope), JSON.stringify(normalized, null, 2), {
          encoding: "utf8",
          flag: "wx"
        });
        await fs.writeFile(runPath(normalized.runId, scope), JSON.stringify(normalized, null, 2), "utf8");
        return { claimed: true, state: normalized };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const existing = await findByIdempotencyKey(state.idempotencyKey, scope);
        if (!existing) {
          throw new ConflictError("AgentRunState idempotency claim could not be loaded.");
        }
        return { claimed: false, state: existing };
      }
    },
    async save(state, saveOptions) {
      await fs.mkdir(options.directory, { recursive: true });
      const scope = effectiveScope(state.scope);
      const current = await load(state.runId, scope);
      assertExpectedRevision(current, saveOptions?.expectedRevision);
      const normalized = nextStoredState(state, saveOptions);
      if (normalized.idempotencyKey) {
        const owner = await findByIdempotencyKey(normalized.idempotencyKey, scope);
        if (owner && owner.runId !== normalized.runId) {
          throw new ConflictError("AgentRunState idempotency key conflict.");
        }
      }
      const stored = { ...normalized, ...(scope ? { scope } : {}) };
      await fs.writeFile(runPath(normalized.runId, scope), JSON.stringify(stored, null, 2), "utf8");
      if (normalized.idempotencyKey) {
        await fs.writeFile(idempotencyPath(normalized.idempotencyKey, scope), JSON.stringify(stored, null, 2), "utf8");
      }
    },
    async delete(runId, scope) {
      const current = await load(runId, scope);
      const targetScope = effectiveScope(scope);
      try {
        await fs.unlink(runPath(runId, scope));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (current?.idempotencyKey) {
        try {
          await fs.unlink(idempotencyPath(current.idempotencyKey, scope));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
      await fs.unlink(leasePath(runId, scope)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      const entries = await fs.readdir(options.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entryName of entries.filter((name) => name.startsWith(".tool-") && name.endsWith(".json"))) {
        const entryPath = path.join(options.directory, entryName);
        try {
          const journalEntry = JSON.parse(await fs.readFile(entryPath, "utf8")) as AgentToolCallJournalEntry;
          const sameEntryScope = targetScope
            ? Boolean(journalEntry.scope && sameScope(journalEntry.scope, targetScope))
            : journalEntry.scope === undefined;
          if (journalEntry.runId === runId && sameEntryScope) {
            await fs.unlink(entryPath);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },
    async list(listOptions, scope) {
      const targetScope = effectiveScope(scope);
      const entries = await fs.readdir(options.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const states: AgentRunState[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
        const state = normalizeAgentRunState(JSON.parse(await fs.readFile(path.join(options.directory, entry), "utf8")) as AgentRunState);
        if (!targetScope || (state.scope && sameScope(state.scope, targetScope))) states.push(state);
      }
      return listStates(states, listOptions);
    },
    async deleteExpired(retention, scope) {
      const page = await this.list?.({ statuses: retention.statuses, updatedBefore: retention.before, limit: retention.limit ?? 1_000 }, scope);
      const items = (page as AgentRunPage).items;
      for (const state of items) await this.delete?.(state.runId, state.scope);
      return items.length;
    },
    async acquireLease(runId, leaseOptions, scope) {
      validateLeaseOptions(leaseOptions);
      if (!await load(runId, scope)) return undefined;
      await fs.mkdir(options.directory, { recursive: true });
      const file = leasePath(runId, scope);
      const now = leaseOptions.now ?? Date.now();
      const lease = { runId, ownerId: leaseOptions.ownerId, expiresAt: now + leaseOptions.ttlMs };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await fs.writeFile(file, JSON.stringify(lease), { encoding: "utf8", flag: "wx" });
          return lease;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const current = JSON.parse(await fs.readFile(file, "utf8")) as AgentRunLease;
          if (current.ownerId === leaseOptions.ownerId) {
            await fs.writeFile(file, JSON.stringify(lease), "utf8");
            return lease;
          }
          if (current.expiresAt > now) return undefined;
          await fs.unlink(file).catch(() => undefined);
        }
      }
      return undefined;
    },
    async renewLease(runId, leaseOptions, scope) {
      validateLeaseOptions(leaseOptions);
      const file = leasePath(runId, scope);
      const now = leaseOptions.now ?? Date.now();
      try {
        const current = JSON.parse(await fs.readFile(file, "utf8")) as AgentRunLease;
        if (current.ownerId !== leaseOptions.ownerId || current.expiresAt <= now) return undefined;
        const lease = { runId, ownerId: leaseOptions.ownerId, expiresAt: now + leaseOptions.ttlMs };
        await fs.writeFile(file, JSON.stringify(lease), "utf8");
        return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async releaseLease(runId, ownerId, scope) {
      const file = leasePath(runId, scope);
      try {
        const current = JSON.parse(await fs.readFile(file, "utf8")) as AgentRunLease;
        if (current.ownerId !== ownerId) return false;
        await fs.unlink(file);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async loadToolCall(runId, toolCallId, scope) {
      try {
        return JSON.parse(await fs.readFile(toolPath(runId, toolCallId, scope), "utf8")) as AgentToolCallJournalEntry;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async loadToolExecution(runId, toolCallId, scope) {
      return this.loadToolCall?.(runId, toolCallId, scope);
    },
    async listToolCalls(runId, scope) {
      const targetScope = effectiveScope(scope);
      const entries = await fs.readdir(options.directory).catch(() => []);
      const results: AgentToolCallJournalEntry[] = [];
      for (const entry of entries) {
        if (!entry.startsWith(".tool-") || !entry.endsWith(".json")) continue;
        const value = JSON.parse(await fs.readFile(path.join(options.directory, entry), "utf8")) as AgentToolCallJournalEntry;
        if (value.runId === runId && (!targetScope || (value.scope && sameScope(value.scope, targetScope)))) results.push(value);
      }
      return results.sort((a, b) => a.updatedAt - b.updatedAt || a.toolCallId.localeCompare(b.toolCallId));
    },
    async saveToolCall(entry, journalOptions) {
      const file = toolPath(entry.runId, entry.toolCallId, entry.scope);
      const current = await this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope);
      assertJournalRevision(current, journalOptions?.expectedRevision);
      const next = nextJournalEntry(entry, journalOptions);
      await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
      return next;
    },
    async claimToolExecution(entry) {
      await fs.mkdir(options.directory, { recursive: true });
      if (!await load(entry.runId, entry.scope)) throw new ValidationError("Cannot journal a tool call for an unknown run.");
      const next = nextJournalEntry({ ...entry, status: "running", revision: 0 });
      try {
        await fs.writeFile(toolPath(entry.runId, entry.toolCallId, entry.scope), JSON.stringify(next, null, 2), { encoding: "utf8", flag: "wx" });
        return { claimed: true, entry: next };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope);
        if (!existing) throw new ConflictError("Tool execution claim could not be loaded.");
        return { claimed: false, entry: existing };
      }
    },
    async completeToolExecution(entry, journalOptions) {
      return this.saveToolCall?.({ ...entry, status: entry.status === "failed" ? "failed" : "completed" }, journalOptions) as Promise<AgentToolCallJournalEntry>;
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

export const createFileAgentMemoryStore = (options: {
  directory: string;
  key?: (context: AgentMemoryContext) => string;
  selectMessages?: (state: AgentRunState) => ModelMessage[];
  scope?: AgentStoreScope;
}): AgentMemoryStore => {
  const keyFor = (context: AgentMemoryContext) => (options.key ?? defaultMemoryKey)({ ...context, scope: resolveScope(options.scope, context.scope) });
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;

  return {
    async load(context) {
      try {
        const file = await fs.readFile(path.join(options.directory, fileNameForAgentStoreKey(keyFor(context))), "utf8");
        return JSON.parse(file) as ModelMessage[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async save(context) {
      await fs.mkdir(options.directory, { recursive: true });
      await fs.writeFile(
        path.join(options.directory, fileNameForAgentStoreKey(keyFor(context))),
        JSON.stringify(selectMessages(context.state), null, 2),
        "utf8"
      );
    }
  };
};

export const createSqliteAgentRunStore = (options: SqliteAgentRunStoreOptions): AgentRunStore => {
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_runs", "tableName");
  const idempotencyTableName = `${tableName}_idempotency`;
  const parentTableName = `${tableName}_parents`;
  const leaseTableName = `${tableName}_leases`;
  const journalTableName = `${tableName}_tool_journal`;
  const dbKey = (value: string, scope?: AgentStoreScope) => scopedKey(resolveScope(options.scope, scope), value);
  initializeSqliteTable(
    options.db,
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      run_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`
  );
  initializeSqliteTable(options.db, `CREATE INDEX IF NOT EXISTS ${tableName}_updated_idx ON ${tableName} (updated_at_ms, run_id)`);
  initializeSqliteTable(options.db, `CREATE TABLE IF NOT EXISTS ${leaseTableName} (
    run_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`);
  initializeSqliteTable(options.db, `CREATE INDEX IF NOT EXISTS ${leaseTableName}_expiry_idx ON ${leaseTableName} (expires_at_ms)`);
  initializeSqliteTable(options.db, `CREATE TABLE IF NOT EXISTS ${journalTableName} (
    run_key TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_key, tool_call_id)
  )`);
  initializeSqliteTable(options.db, `CREATE INDEX IF NOT EXISTS ${journalTableName}_run_idx ON ${journalTableName} (run_key, updated_at_ms)`);
  initializeSqliteTable(
    options.db,
    `CREATE TABLE IF NOT EXISTS ${idempotencyTableName} (
      idempotency_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`
  );
  initializeSqliteTable(
    options.db,
    `CREATE TABLE IF NOT EXISTS ${parentTableName} (
      run_id TEXT PRIMARY KEY,
      parent_run_id TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`
  );

  initializeSqliteTable(options.db, `CREATE INDEX IF NOT EXISTS ${parentTableName}_parent_idx ON ${parentTableName} (parent_run_id, updated_at_ms)`);

  const loadStatement = prepareSqliteStatement<{ state_json?: string; stateJson?: string }>(
    options.db,
    `SELECT state_json FROM ${tableName} WHERE run_id = ?`
  );
  const saveStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${tableName} (run_id, state_json, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at_ms = excluded.updated_at_ms
  `);
  const deleteStatement = prepareSqliteStatement(options.db, `DELETE FROM ${tableName} WHERE run_id = ?`);
  const findIdempotencyStatement = prepareSqliteStatement<{ state_json?: string; stateJson?: string }>(
    options.db,
    `SELECT runs.state_json
     FROM ${tableName} runs
     INNER JOIN ${idempotencyTableName} keys ON keys.run_id = runs.run_id
     WHERE keys.idempotency_key = ?`
  );
  const saveIdempotencyStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${idempotencyTableName} (idempotency_key, run_id, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `);
  const deleteIdempotencyStatement = prepareSqliteStatement(options.db, `DELETE FROM ${idempotencyTableName} WHERE run_id = ?`);
  const findParentStatement = prepareSqliteStatement<{ state_json?: string; stateJson?: string }>(
    options.db,
    `SELECT runs.state_json
     FROM ${tableName} runs
     INNER JOIN ${parentTableName} parents ON parents.run_id = runs.run_id
     WHERE parents.parent_run_id = ?`
  );
  const saveParentStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${parentTableName} (run_id, parent_run_id, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      parent_run_id = excluded.parent_run_id,
      updated_at_ms = excluded.updated_at_ms
  `);
  const deleteParentStatement = prepareSqliteStatement(options.db, `DELETE FROM ${parentTableName} WHERE run_id = ?`);
  const listStatement = prepareSqliteStatement<{ state_json?: string; stateJson?: string }>(options.db, `SELECT state_json FROM ${tableName}`);
  const loadLeaseStatement = prepareSqliteStatement<{ owner_id?: string; ownerId?: string; expires_at_ms?: number; expiresAtMs?: number }>(options.db, `SELECT owner_id, expires_at_ms FROM ${leaseTableName} WHERE run_key = ?`);
  const saveLeaseStatement = prepareSqliteStatement(options.db, `INSERT INTO ${leaseTableName} (run_key, run_id, owner_id, expires_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(run_key) DO UPDATE SET owner_id = excluded.owner_id, expires_at_ms = excluded.expires_at_ms`);
  const deleteLeaseStatement = prepareSqliteStatement(options.db, `DELETE FROM ${leaseTableName} WHERE run_key = ? AND owner_id = ?`);
  const deleteRunLeaseStatement = prepareSqliteStatement(options.db, `DELETE FROM ${leaseTableName} WHERE run_key = ?`);
  const deleteRunJournalStatement = prepareSqliteStatement(options.db, `DELETE FROM ${journalTableName} WHERE run_key = ?`);
  const loadJournalStatement = prepareSqliteStatement<{ entry_json?: string; entryJson?: string }>(options.db, `SELECT entry_json FROM ${journalTableName} WHERE run_key = ? AND tool_call_id = ?`);
  const listJournalStatement = prepareSqliteStatement<{ entry_json?: string; entryJson?: string }>(options.db, `SELECT entry_json FROM ${journalTableName} WHERE run_key = ? ORDER BY updated_at_ms, tool_call_id`);
  const insertJournalStatement = prepareSqliteStatement(options.db, `INSERT INTO ${journalTableName} (run_key, tool_call_id, entry_json, revision, updated_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_key, tool_call_id) DO NOTHING`);
  const saveJournalStatement = prepareSqliteStatement(options.db, `INSERT INTO ${journalTableName} (run_key, tool_call_id, entry_json, revision, updated_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_key, tool_call_id) DO UPDATE SET entry_json = excluded.entry_json, revision = excluded.revision, updated_at_ms = excluded.updated_at_ms`);

  return {
    load(runId, scope) {
      const row = loadStatement.get([dbKey(runId, scope)]);
      const stateJson = getRecordField(row, ["state_json", "stateJson"]);
      return typeof stateJson === "string" ? normalizeAgentRunState(JSON.parse(stateJson) as AgentRunState) : undefined;
    },
    findByIdempotencyKey(idempotencyKey, scope) {
      const row = findIdempotencyStatement.get([dbKey(idempotencyKey, scope)]);
      const stateJson = getRecordField(row, ["state_json", "stateJson"]);
      return typeof stateJson === "string" ? normalizeAgentRunState(JSON.parse(stateJson) as AgentRunState) : undefined;
    },
    findByParentRunId(parentRunId, scope) {
      const rows = findParentStatement.all?.([dbKey(parentRunId, scope)]);
      if (Array.isArray(rows)) {
        return rows.flatMap((row) => {
          const stateJson = getRecordField(row, ["state_json", "stateJson"]);
          return typeof stateJson === "string" ? [normalizeAgentRunState(JSON.parse(stateJson) as AgentRunState)] : [];
        });
      }

      const row = findParentStatement.get([dbKey(parentRunId, scope)]);
      const stateJson = getRecordField(row, ["state_json", "stateJson"]);
      return typeof stateJson === "string" ? [normalizeAgentRunState(JSON.parse(stateJson) as AgentRunState)] : [];
    },
    claimIdempotencyKey(state) {
      options.db.exec("BEGIN IMMEDIATE");
      try {
        const scope = resolveScope(options.scope, state.scope);
        const existingRow = findIdempotencyStatement.get([dbKey(state.idempotencyKey, scope)]);
        const existingJson = getRecordField(existingRow, ["state_json", "stateJson"]);
        if (typeof existingJson === "string") {
          options.db.exec("COMMIT");
          return { claimed: false, state: normalizeAgentRunState(JSON.parse(existingJson) as AgentRunState) };
        }

        const normalized = normalizeAgentRunState({ ...state, ...(scope ? { scope } : {}) });
        const updatedAt = Date.now();
        saveStatement.run([dbKey(normalized.runId, scope), JSON.stringify(normalized), updatedAt]);
        saveIdempotencyStatement.run([dbKey(state.idempotencyKey, scope), dbKey(normalized.runId, scope), updatedAt]);
        if (normalized.parentRunId) {
          saveParentStatement.run([dbKey(normalized.runId, scope), dbKey(normalized.parentRunId, scope), updatedAt]);
        }
        options.db.exec("COMMIT");
        return { claimed: true, state: normalized };
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    save(state, saveOptions) {
      options.db.exec("BEGIN IMMEDIATE");
      try {
        const scope = resolveScope(options.scope, state.scope);
        const currentRow = loadStatement.get([dbKey(state.runId, scope)]);
        const currentJson = getRecordField(currentRow, ["state_json", "stateJson"]);
        const current = typeof currentJson === "string"
          ? normalizeAgentRunState(JSON.parse(currentJson) as AgentRunState)
          : undefined;
        assertExpectedRevision(current, saveOptions?.expectedRevision);

        const normalized = nextStoredState(state, saveOptions);
        if (normalized.idempotencyKey) {
          const ownerRow = findIdempotencyStatement.get([dbKey(normalized.idempotencyKey, scope)]);
          const ownerJson = getRecordField(ownerRow, ["state_json", "stateJson"]);
          const owner = typeof ownerJson === "string"
            ? normalizeAgentRunState(JSON.parse(ownerJson) as AgentRunState)
            : undefined;
          if (owner && owner.runId !== normalized.runId) {
            throw new ConflictError("AgentRunState idempotency key conflict.");
          }
        }

        const updatedAt = Date.now();
        const stored = { ...normalized, ...(scope ? { scope } : {}) };
        saveStatement.run([dbKey(normalized.runId, scope), JSON.stringify(stored), updatedAt]);
        if (normalized.idempotencyKey) {
          saveIdempotencyStatement.run([dbKey(normalized.idempotencyKey, scope), dbKey(normalized.runId, scope), updatedAt]);
        }
        deleteParentStatement.run([dbKey(normalized.runId, scope)]);
        if (normalized.parentRunId) {
          saveParentStatement.run([dbKey(normalized.runId, scope), dbKey(normalized.parentRunId, scope), updatedAt]);
        }
        options.db.exec("COMMIT");
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    delete(runId, scope) {
      const key = dbKey(runId, scope);
      options.db.exec("BEGIN IMMEDIATE");
      try {
        deleteStatement.run([key]);
        deleteIdempotencyStatement.run([key]);
        deleteParentStatement.run([key]);
        deleteRunLeaseStatement.run([key]);
        deleteRunJournalStatement.run([key]);
        options.db.exec("COMMIT");
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    list(listOptions, scope) {
      const rows = listStatement.all?.([]) ?? [];
      const prefix = scopePrefix(resolveScope(options.scope, scope));
      const states = rows.flatMap((row) => {
        const value = getRecordField(row, ["state_json", "stateJson"]);
        if (typeof value !== "string") return [];
        const state = normalizeAgentRunState(JSON.parse(value) as AgentRunState);
        return scopedKey(state.scope, state.runId).startsWith(prefix) ? [state] : [];
      });
      return listStates(states, listOptions);
    },
    deleteExpired(retention, scope) {
      const page = this.list?.({ statuses: retention.statuses, updatedBefore: retention.before, limit: retention.limit ?? 1_000 }, scope) as AgentRunPage;
      for (const state of page.items) this.delete?.(state.runId, state.scope);
      return page.items.length;
    },
    acquireLease(runId, leaseOptions, scope) {
      validateLeaseOptions(leaseOptions);
      const now = leaseOptions.now ?? Date.now();
      const key = dbKey(runId, scope);
      options.db.exec("BEGIN IMMEDIATE");
      try {
        const row = loadLeaseStatement.get([key]);
        const owner = getRecordField(row, ["owner_id", "ownerId"]);
        const expiry = getRecordField(row, ["expires_at_ms", "expiresAtMs"]);
        if (typeof owner === "string" && owner !== leaseOptions.ownerId && typeof expiry === "number" && expiry > now) {
          options.db.exec("COMMIT");
          return undefined;
        }
        const lease = { runId, ownerId: leaseOptions.ownerId, expiresAt: now + leaseOptions.ttlMs };
        saveLeaseStatement.run([key, runId, lease.ownerId, lease.expiresAt]);
        options.db.exec("COMMIT");
        return lease;
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    renewLease(runId, leaseOptions, scope) {
      validateLeaseOptions(leaseOptions);
      const now = leaseOptions.now ?? Date.now();
      const key = dbKey(runId, scope);
      options.db.exec("BEGIN IMMEDIATE");
      try {
        const row = loadLeaseStatement.get([key]);
        const owner = getRecordField(row, ["owner_id", "ownerId"]);
        const expiry = getRecordField(row, ["expires_at_ms", "expiresAtMs"]);
        if (owner !== leaseOptions.ownerId || typeof expiry !== "number" || expiry <= now) {
          options.db.exec("COMMIT");
          return undefined;
        }
        const lease = { runId, ownerId: leaseOptions.ownerId, expiresAt: now + leaseOptions.ttlMs };
        saveLeaseStatement.run([key, runId, lease.ownerId, lease.expiresAt]);
        options.db.exec("COMMIT");
        return lease;
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    releaseLease(runId, ownerId, scope) {
      const key = dbKey(runId, scope);
      options.db.exec("BEGIN IMMEDIATE");
      try {
        const row = loadLeaseStatement.get([key]);
        if (getRecordField(row, ["owner_id", "ownerId"]) !== ownerId) {
          options.db.exec("COMMIT");
          return false;
        }
        deleteLeaseStatement.run([key, ownerId]);
        options.db.exec("COMMIT");
        return true;
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    loadToolCall(runId, toolCallId, scope) {
      const row = loadJournalStatement.get([dbKey(runId, scope), toolCallId]);
      const value = getRecordField(row, ["entry_json", "entryJson"]);
      return typeof value === "string" ? JSON.parse(value) as AgentToolCallJournalEntry : undefined;
    },
    loadToolExecution(runId, toolCallId, scope) {
      return this.loadToolCall?.(runId, toolCallId, scope);
    },
    listToolCalls(runId, scope) {
      const rows = listJournalStatement.all?.([dbKey(runId, scope)]) ?? [];
      return rows.flatMap((row) => {
        const value = getRecordField(row, ["entry_json", "entryJson"]);
        return typeof value === "string" ? [JSON.parse(value) as AgentToolCallJournalEntry] : [];
      });
    },
    saveToolCall(entry, journalOptions) {
      options.db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope) as AgentToolCallJournalEntry | undefined;
        assertJournalRevision(current, journalOptions?.expectedRevision);
        const next = nextJournalEntry(entry, journalOptions);
        saveJournalStatement.run([dbKey(entry.runId, entry.scope), entry.toolCallId, JSON.stringify(next), next.revision, next.updatedAt]);
        options.db.exec("COMMIT");
        return next;
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    claimToolExecution(entry) {
      options.db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope) as AgentToolCallJournalEntry | undefined;
        if (current) {
          options.db.exec("COMMIT");
          return { claimed: false, entry: current };
        }
        const next = nextJournalEntry({ ...entry, status: "running", revision: 0 });
        insertJournalStatement.run([dbKey(entry.runId, entry.scope), entry.toolCallId, JSON.stringify(next), 0, next.updatedAt]);
        options.db.exec("COMMIT");
        return { claimed: true, entry: next };
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    completeToolExecution(entry, journalOptions) {
      return this.saveToolCall?.({ ...entry, status: entry.status === "failed" ? "failed" : "completed" }, journalOptions) as AgentToolCallJournalEntry;
    }
  };
};

export const createSqliteAgentMemoryStore = (options: SqliteAgentMemoryStoreOptions): AgentMemoryStore => {
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_memory", "tableName");
  const keyFor = (context: AgentMemoryContext) => (options.key ?? defaultMemoryKey)({ ...context, scope: resolveScope(options.scope, context.scope) });
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;

  initializeSqliteTable(
    options.db,
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      memory_key TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`
  );

  const loadStatement = prepareSqliteStatement<{ messages_json?: string; messagesJson?: string }>(
    options.db,
    `SELECT messages_json FROM ${tableName} WHERE memory_key = ?`
  );
  const saveStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${tableName} (memory_key, messages_json, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(memory_key) DO UPDATE SET
      messages_json = excluded.messages_json,
      updated_at_ms = excluded.updated_at_ms
  `);

  return {
    load(context) {
      const row = loadStatement.get([keyFor(context)]);
      const messagesJson = getRecordField(row, ["messages_json", "messagesJson"]);
      return typeof messagesJson === "string" ? (JSON.parse(messagesJson) as ModelMessage[]) : [];
    },
    save(context) {
      saveStatement.run([keyFor(context), JSON.stringify(selectMessages(context.state)), Date.now()]);
    }
  };
};

export const createPostgresAgentRunStore = (options: PostgresAgentRunStoreOptions): AgentRunStore => {
  assertPostgresClient(options.client);
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_runs", "tableName");
  const idempotencyTableName = `${tableName}_idempotency`;
  const parentTableName = `${tableName}_parents`;
  const leaseTableName = `${tableName}_leases`;
  const journalTableName = `${tableName}_tool_journal`;
  const dbKey = (value: string, scope?: AgentStoreScope) => scopedKey(resolveScope(options.scope, scope), value);
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      run_id TEXT PRIMARY KEY,
      state_json JSONB NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;
  const createIdempotencySql = `
    CREATE TABLE IF NOT EXISTS ${idempotencyTableName} (
      idempotency_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;
  const createParentSql = `
    CREATE TABLE IF NOT EXISTS ${parentTableName} (
      run_id TEXT PRIMARY KEY,
      parent_run_id TEXT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;
  const createLeaseSql = `CREATE TABLE IF NOT EXISTS ${leaseTableName} (
    run_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    expires_at_ms BIGINT NOT NULL
  )`;
  const createJournalSql = `CREATE TABLE IF NOT EXISTS ${journalTableName} (
    run_key TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    entry_json JSONB NOT NULL,
    revision BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (run_key, tool_call_id)
  )`;
  const createIndexesSql = `
    CREATE INDEX IF NOT EXISTS ${tableName}_updated_idx ON ${tableName} (updated_at_ms DESC, run_id);
    CREATE INDEX IF NOT EXISTS ${parentTableName}_parent_idx ON ${parentTableName} (parent_run_id, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS ${leaseTableName}_expiry_idx ON ${leaseTableName} (expires_at_ms);
    CREATE INDEX IF NOT EXISTS ${journalTableName}_run_idx ON ${journalTableName} (run_key, updated_at_ms, tool_call_id)
  `;
  const ensureAllTables = async () => {
    await ensurePostgresTable(options.client, tableName, createSql);
    await ensurePostgresTable(options.client, idempotencyTableName, createIdempotencySql);
    await ensurePostgresTable(options.client, parentTableName, createParentSql);
    await ensurePostgresTable(options.client, leaseTableName, createLeaseSql);
    await ensurePostgresTable(options.client, journalTableName, createJournalSql);
    await ensurePostgresTable(options.client, `${tableName}:indexes`, createIndexesSql);
  };

  return {
    async load(runId, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(
        `SELECT state_json FROM ${tableName} WHERE run_id = $1`,
        [dbKey(runId, scope)]
      );
      const state = result.rows[0] ? ((getRecordField(result.rows[0], ["state_json", "stateJson"]) as AgentRunState | undefined) ?? undefined) : undefined;
      return state ? normalizeAgentRunState(state) : undefined;
    },
    async findByIdempotencyKey(idempotencyKey, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(
        `SELECT runs.state_json
         FROM ${tableName} runs
         INNER JOIN ${idempotencyTableName} keys ON keys.run_id = runs.run_id
         WHERE keys.idempotency_key = $1`,
        [dbKey(idempotencyKey, scope)]
      );
      const state = result.rows[0] ? ((getRecordField(result.rows[0], ["state_json", "stateJson"]) as AgentRunState | undefined) ?? undefined) : undefined;
      return state ? normalizeAgentRunState(state) : undefined;
    },
    async findByParentRunId(parentRunId, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(
        `SELECT runs.state_json
         FROM ${tableName} runs
         INNER JOIN ${parentTableName} parents ON parents.run_id = runs.run_id
         WHERE parents.parent_run_id = $1`,
        [dbKey(parentRunId, scope)]
      );
      return result.rows.flatMap((row) => {
        const state = (getRecordField(row, ["state_json", "stateJson"]) as AgentRunState | undefined) ?? undefined;
        return state ? [normalizeAgentRunState(state)] : [];
      });
    },
    async claimIdempotencyKey(state) {
      await ensureAllTables();
      const scope = resolveScope(options.scope, state.scope);
      const normalized = normalizeAgentRunState({ ...state, ...(scope ? { scope } : {}) });
      const updatedAt = Date.now();

      await options.client.query(
        `INSERT INTO ${tableName} (run_id, state_json, updated_at_ms)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT(run_id) DO NOTHING`,
        [dbKey(normalized.runId, scope), JSON.stringify(normalized), updatedAt]
      );
      const claim = await options.client.query<{ run_id?: string; runId?: string }>(
        `INSERT INTO ${idempotencyTableName} (idempotency_key, run_id, updated_at_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT(idempotency_key) DO NOTHING
         RETURNING run_id`,
        [dbKey(state.idempotencyKey, scope), dbKey(normalized.runId, scope), updatedAt]
      );
      const claimedRunId = getRecordField(claim.rows[0], ["run_id", "runId"]);
      if (claimedRunId === dbKey(normalized.runId, scope)) {
        if (normalized.parentRunId) {
          await options.client.query(
            `INSERT INTO ${parentTableName} (run_id, parent_run_id, updated_at_ms)
             VALUES ($1, $2, $3)
             ON CONFLICT(run_id) DO UPDATE SET
               parent_run_id = EXCLUDED.parent_run_id,
               updated_at_ms = EXCLUDED.updated_at_ms`,
            [dbKey(normalized.runId, scope), dbKey(normalized.parentRunId, scope), updatedAt]
          );
        }
        return { claimed: true, state: normalized };
      }

      const existing = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(
        `SELECT runs.state_json
         FROM ${tableName} runs
         INNER JOIN ${idempotencyTableName} keys ON keys.run_id = runs.run_id
         WHERE keys.idempotency_key = $1`,
        [dbKey(state.idempotencyKey, scope)]
      );
      const existingState = existing.rows[0]
        ? getRecordField(existing.rows[0], ["state_json", "stateJson"]) as AgentRunState | undefined
        : undefined;
      if (!existingState) {
        throw new ConflictError("AgentRunState idempotency claim could not be loaded.");
      }
      if (existingState.runId !== normalized.runId) {
        await options.client.query(`DELETE FROM ${tableName} WHERE run_id = $1`, [dbKey(normalized.runId, scope)]);
      }
      return { claimed: false, state: normalizeAgentRunState(existingState) };
    },
    async save(state, saveOptions) {
      await ensureAllTables();
      const scope = resolveScope(options.scope, state.scope);
      const normalized = nextStoredState(state, saveOptions);
      const stored = { ...normalized, ...(scope ? { scope } : {}) };
      const updatedAt = Date.now();
      if (normalized.idempotencyKey) {
        const owner = await options.client.query<{ run_id?: string; runId?: string }>(
          `SELECT run_id FROM ${idempotencyTableName} WHERE idempotency_key = $1`,
          [dbKey(normalized.idempotencyKey, scope)]
        );
        const ownerRunId = getRecordField(owner.rows[0], ["run_id", "runId"]);
        if (typeof ownerRunId === "string" && ownerRunId !== dbKey(normalized.runId, scope)) {
          throw new ConflictError("AgentRunState idempotency key conflict.");
        }
      }

      if (saveOptions?.expectedRevision === undefined) {
        await options.client.query(
          `INSERT INTO ${tableName} (run_id, state_json, updated_at_ms)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT(run_id) DO UPDATE SET
             state_json = EXCLUDED.state_json,
             updated_at_ms = EXCLUDED.updated_at_ms`,
          [dbKey(normalized.runId, scope), JSON.stringify(stored), updatedAt]
        );
      } else {
        const saved = await options.client.query<{ run_id?: string; runId?: string }>(
          `INSERT INTO ${tableName} (run_id, state_json, updated_at_ms)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT(run_id) DO UPDATE SET
             state_json = EXCLUDED.state_json,
             updated_at_ms = EXCLUDED.updated_at_ms
           WHERE COALESCE((${tableName}.state_json->>'revision')::bigint, 0) = $4
           RETURNING run_id`,
          [dbKey(normalized.runId, scope), JSON.stringify(stored), updatedAt, saveOptions.expectedRevision]
        );
        if (getRecordField(saved.rows[0], ["run_id", "runId"]) !== dbKey(normalized.runId, scope)) {
          throw new ConflictError("AgentRunState revision conflict.");
        }
      }
      if (normalized.idempotencyKey) {
        await options.client.query(
          `INSERT INTO ${idempotencyTableName} (idempotency_key, run_id, updated_at_ms)
           VALUES ($1, $2, $3)
           ON CONFLICT(idempotency_key) DO NOTHING`,
          [dbKey(normalized.idempotencyKey, scope), dbKey(normalized.runId, scope), updatedAt]
        );
      }
      await options.client.query(`DELETE FROM ${parentTableName} WHERE run_id = $1`, [dbKey(normalized.runId, scope)]);
      if (normalized.parentRunId) {
        await options.client.query(
          `INSERT INTO ${parentTableName} (run_id, parent_run_id, updated_at_ms)
           VALUES ($1, $2, $3)
           ON CONFLICT(run_id) DO UPDATE SET
             parent_run_id = EXCLUDED.parent_run_id,
             updated_at_ms = EXCLUDED.updated_at_ms`,
          [dbKey(normalized.runId, scope), dbKey(normalized.parentRunId, scope), updatedAt]
        );
      }
    },
    async delete(runId, scope) {
      await ensureAllTables();
      const key = dbKey(runId, scope);
      await options.client.query(
        `WITH deleted_run AS (
           DELETE FROM ${tableName} WHERE run_id = $1 RETURNING run_id
         ), deleted_idempotency AS (
           DELETE FROM ${idempotencyTableName} WHERE run_id = $1 RETURNING run_id
         ), deleted_parent AS (
           DELETE FROM ${parentTableName} WHERE run_id = $1 RETURNING run_id
         ), deleted_lease AS (
           DELETE FROM ${leaseTableName} WHERE run_key = $1 RETURNING run_key
         )
         DELETE FROM ${journalTableName} WHERE run_key = $1`,
        [key]
      );
    },
    async list(listOptions, scope) {
      await ensureAllTables();
      const prefix = scopePrefix(resolveScope(options.scope, scope));
      const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(
        `SELECT state_json FROM ${tableName} WHERE run_id >= $1 AND run_id < $2`,
        [prefix, `${prefix}\uffff`]
      );
      const states = result.rows.flatMap((row) => {
        const state = getRecordField(row, ["state_json", "stateJson"]) as AgentRunState | undefined;
        return state ? [normalizeAgentRunState(state)] : [];
      });
      return listStates(states, listOptions);
    },
    async deleteExpired(retention, scope) {
      const page = await this.list?.({ statuses: retention.statuses, updatedBefore: retention.before, limit: retention.limit ?? 1_000 }, scope) as AgentRunPage;
      for (const state of page.items) await this.delete?.(state.runId, state.scope);
      return page.items.length;
    },
    async acquireLease(runId, leaseOptions, scope) {
      validateLeaseOptions(leaseOptions);
      await ensureAllTables();
      const now = leaseOptions.now ?? Date.now();
      const key = dbKey(runId, scope);
      const expiresAt = now + leaseOptions.ttlMs;
      const result = await options.client.query<{ owner_id?: string; ownerId?: string; expires_at_ms?: number | string; expiresAtMs?: number | string }>(
        `INSERT INTO ${leaseTableName} (run_key, run_id, owner_id, expires_at_ms)
         SELECT $1, $2, $3, $4
         WHERE EXISTS (SELECT 1 FROM ${tableName} WHERE run_id = $1)
         ON CONFLICT(run_key) DO UPDATE SET
           owner_id = EXCLUDED.owner_id,
           expires_at_ms = EXCLUDED.expires_at_ms
         WHERE ${leaseTableName}.owner_id = EXCLUDED.owner_id OR ${leaseTableName}.expires_at_ms <= $5
         RETURNING owner_id, expires_at_ms`,
        [key, runId, leaseOptions.ownerId, expiresAt, now]
      );
      const owner = getRecordField(result.rows[0], ["owner_id", "ownerId"]);
      return owner === leaseOptions.ownerId ? { runId, ownerId: leaseOptions.ownerId, expiresAt } : undefined;
    },
    async renewLease(runId, leaseOptions, scope) {
      validateLeaseOptions(leaseOptions);
      await ensureAllTables();
      const now = leaseOptions.now ?? Date.now();
      const expiresAt = now + leaseOptions.ttlMs;
      const result = await options.client.query<{ owner_id?: string; ownerId?: string }>(
        `UPDATE ${leaseTableName}
         SET expires_at_ms = $3
         WHERE run_key = $1 AND owner_id = $2 AND expires_at_ms > $4
         RETURNING owner_id`,
        [dbKey(runId, scope), leaseOptions.ownerId, expiresAt, now]
      );
      return getRecordField(result.rows[0], ["owner_id", "ownerId"]) === leaseOptions.ownerId
        ? { runId, ownerId: leaseOptions.ownerId, expiresAt }
        : undefined;
    },
    async releaseLease(runId, ownerId, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ owner_id?: string; ownerId?: string }>(
        `DELETE FROM ${leaseTableName} WHERE run_key = $1 AND owner_id = $2 RETURNING owner_id`,
        [dbKey(runId, scope), ownerId]
      );
      return getRecordField(result.rows[0], ["owner_id", "ownerId"]) === ownerId;
    },
    async loadToolCall(runId, toolCallId, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ entry_json?: AgentToolCallJournalEntry; entryJson?: AgentToolCallJournalEntry }>(
        `SELECT entry_json FROM ${journalTableName} WHERE run_key = $1 AND tool_call_id = $2`,
        [dbKey(runId, scope), toolCallId]
      );
      const entry = getRecordField(result.rows[0], ["entry_json", "entryJson"]);
      return entry && typeof entry === "object" ? cloneJournalEntry(entry as AgentToolCallJournalEntry) : undefined;
    },
    async loadToolExecution(runId, toolCallId, scope) {
      return this.loadToolCall?.(runId, toolCallId, scope);
    },
    async listToolCalls(runId, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ entry_json?: AgentToolCallJournalEntry; entryJson?: AgentToolCallJournalEntry }>(
        `SELECT entry_json FROM ${journalTableName} WHERE run_key = $1 ORDER BY updated_at_ms, tool_call_id`,
        [dbKey(runId, scope)]
      );
      return result.rows.flatMap((row) => {
        const entry = getRecordField(row, ["entry_json", "entryJson"]);
        return entry && typeof entry === "object" ? [cloneJournalEntry(entry as AgentToolCallJournalEntry)] : [];
      });
    },
    async saveToolCall(entry, journalOptions) {
      await ensureAllTables();
      const next = nextJournalEntry(entry, journalOptions);
      const key = dbKey(entry.runId, entry.scope);
      const result = journalOptions?.expectedRevision === undefined
        ? await options.client.query<{ revision?: number | string }>(
          `INSERT INTO ${journalTableName} (run_key, tool_call_id, entry_json, revision, updated_at_ms)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT(run_key, tool_call_id) DO UPDATE SET
             entry_json = EXCLUDED.entry_json,
             revision = EXCLUDED.revision,
             updated_at_ms = EXCLUDED.updated_at_ms
           RETURNING revision`,
          [key, entry.toolCallId, JSON.stringify(next), next.revision, next.updatedAt]
        )
        : await options.client.query<{ revision?: number | string }>(
          `UPDATE ${journalTableName}
           SET entry_json = $3::jsonb,
               revision = $4,
               updated_at_ms = $5
           WHERE run_key = $1 AND tool_call_id = $2 AND revision = $6
           RETURNING revision`,
          [key, entry.toolCallId, JSON.stringify(next), next.revision, next.updatedAt, journalOptions.expectedRevision]
        );
      if (getRecordField(result.rows[0], ["revision"]) === undefined) {
        throw new ConflictError("Agent tool-call journal revision conflict.");
      }
      return next;
    },
    async claimToolExecution(entry) {
      await ensureAllTables();
      const next = nextJournalEntry({ ...entry, status: "running", revision: 0 });
      const result = await options.client.query<{ entry_json?: AgentToolCallJournalEntry; entryJson?: AgentToolCallJournalEntry }>(
        `INSERT INTO ${journalTableName} (run_key, tool_call_id, entry_json, revision, updated_at_ms)
         SELECT $1, $2, $3::jsonb, 0, $4
         WHERE EXISTS (SELECT 1 FROM ${tableName} WHERE run_id = $1)
         ON CONFLICT(run_key, tool_call_id) DO NOTHING
         RETURNING entry_json`,
        [dbKey(entry.runId, entry.scope), entry.toolCallId, JSON.stringify(next), next.updatedAt]
      );
      const claimed = getRecordField(result.rows[0], ["entry_json", "entryJson"]);
      if (claimed && typeof claimed === "object") return { claimed: true, entry: next };
      const existing = await this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope);
      if (!existing) throw new ValidationError("Cannot journal a tool call for an unknown run.");
      return { claimed: false, entry: existing };
    },
    async completeToolExecution(entry, journalOptions) {
      return this.saveToolCall?.({ ...entry, status: entry.status === "failed" ? "failed" : "completed" }, journalOptions) as Promise<AgentToolCallJournalEntry>;
    }
  };
};

export const createPostgresAgentMemoryStore = (options: PostgresAgentMemoryStoreOptions): AgentMemoryStore => {
  assertPostgresClient(options.client);
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_memory", "tableName");
  const keyFor = (context: AgentMemoryContext) => (options.key ?? defaultMemoryKey)({ ...context, scope: resolveScope(options.scope, context.scope) });
  const selectMessages = options.selectMessages ?? defaultMemoryMessages;
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      memory_key TEXT PRIMARY KEY,
      messages_json JSONB NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;

  return {
    async load(context) {
      await ensurePostgresTable(options.client, tableName, createSql);
      const result = await options.client.query<{ messages_json?: ModelMessage[]; messagesJson?: ModelMessage[] }>(
        `SELECT messages_json FROM ${tableName} WHERE memory_key = $1`,
        [keyFor(context)]
      );
      return result.rows[0]
        ? ((getRecordField(result.rows[0], ["messages_json", "messagesJson"]) as ModelMessage[] | undefined) ?? [])
        : [];
    },
    async save(context) {
      await ensurePostgresTable(options.client, tableName, createSql);
      await options.client.query(
        `INSERT INTO ${tableName} (memory_key, messages_json, updated_at_ms)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT(memory_key) DO UPDATE SET
           messages_json = EXCLUDED.messages_json,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [keyFor(context), JSON.stringify(selectMessages(context.state)), Date.now()]
      );
    }
  };
};
