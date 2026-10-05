import { historyCheckpoint, sqliteHistory } from "./sqlite-history.js";
import { normalizeAgentRunState } from "../agent-state.js";
import { ConflictError, ValidationError } from "../errors.js";
import type {
  AgentMemoryContext,
  AgentMemoryStore,
  AgentRunPage,
  AgentRunState,
  AgentRunStore,
  AgentStoreScope,
  AgentToolCallJournalEntry,
  ModelMessage,
  SqliteAgentMemoryStoreOptions,
  SqliteAgentRunStoreOptions,
  SqliteDatabaseLike,
  SqliteStatementLike
} from "../types.js";
import {
  validateIdentifier,
  scopedKey,
  legacyScopedKey,
  matchesRun,
  matchesScope,
  resolveScope,
  getRecordField,
  assertExpectedRevision,
  nextStoredState,
  listStates,
  validateLeaseOptions,
  assertJournalRevision,
  nextJournalEntry,
  defaultMemoryKey,
  legacyDefaultMemoryKey,
  encodeAgentMemory,
  decodeAgentMemory,
  LEGACY_MEMORY_MIGRATION_MESSAGE,
  defaultMemoryMessages
} from "./shared.js";

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

export const createSqliteAgentRunStore = (options: SqliteAgentRunStoreOptions): AgentRunStore => {
  const tableName = validateIdentifier(options.tableName ?? "zhivex_agent_runs", "tableName");
  const idempotencyTableName = `${tableName}_idempotency`;
  const parentTableName = `${tableName}_parents`;
  const leaseTableName = `${tableName}_leases`;
  const journalTableName = `${tableName}_tool_journal`;
  const history = options.history === "incremental" ? sqliteHistory(options.db, tableName) : undefined;
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

  const physicalKey = (runId: string, scope?: AgentStoreScope): string => {
    const targetScope = resolveScope(options.scope, scope);
    const canonical = dbKey(runId, scope);
    for (const key of [canonical, legacyScopedKey(targetScope, runId)]) {
      const json = getRecordField(loadStatement.get([key]), ["state_json", "stateJson"]);
      if (typeof json === "string") {
        if (matchesRun(JSON.parse(json) as AgentRunState, runId, targetScope)) return key;
        if (key === canonical) throw new ConflictError("Canonical agent key is occupied by a different legacy identity; migrate that identity before writing.");
      }
    }
    return canonical;
  };
  const deserialize = (json: string): AgentRunState => {
    const state = JSON.parse(json) as ReturnType<typeof historyCheckpoint>;
    if (state.checkpointHistory && !history) throw new ValidationError("This run requires incremental history storage.");
    return normalizeAgentRunState(history ? history.hydrate(physicalKey(state.runId, state.scope), state) : state);
  };
  const serialize = (state: AgentRunState) => JSON.stringify(history ? history.save(physicalKey(state.runId, state.scope), state) : state);
  // A checkpoint and its history must be read from the same WAL snapshot,
  // including when another process commits a new revision during hydration.
  const readSnapshot = <T>(read: () => T): T => {
    if (!history) return read();
    options.db.exec("SAVEPOINT zhivex_history_read");
    try {
      const result = read();
      options.db.exec("RELEASE zhivex_history_read");
      return result;
    } catch (error) {
      options.db.exec("ROLLBACK TO zhivex_history_read");
      options.db.exec("RELEASE zhivex_history_read");
      throw error;
    }
  };

  const findByIdempotencyKey = (idempotencyKey: string, scope?: AgentStoreScope): AgentRunState | undefined => {
    const targetScope = resolveScope(options.scope, scope);
    for (const key of [dbKey(idempotencyKey, scope), legacyScopedKey(targetScope, idempotencyKey)]) {
      const json = getRecordField(findIdempotencyStatement.get([key]), ["state_json", "stateJson"]);
      if (typeof json !== "string") continue;
      const state = JSON.parse(json) as AgentRunState;
      if (state.idempotencyKey === idempotencyKey && matchesScope(state.scope, targetScope)) return deserialize(json);
      if (key === dbKey(idempotencyKey, scope)) throw new ConflictError("Canonical idempotency key is occupied by a different legacy identity; migrate that index before writing.");
    }
    return undefined;
  };

  return {
    ...(history ? {
      checkpointBytes: (state: AgentRunState) => new TextEncoder().encode(JSON.stringify(historyCheckpoint(state))).byteLength,
      loadHistory: (runId: string, page: { field: "steps" | "toolResults" | "compactions"; offset?: number; limit?: number }, scope?: AgentStoreScope) =>
        readSnapshot(() => {
          const key = physicalKey(runId, scope);
          const values = history.page(key, page.field, page.offset ?? 0, page.limit ?? 50).map(row => row.value);
          const row = loadStatement.get([key]);
          const json = getRecordField(row, ["state_json", "stateJson"]);
          if (typeof json !== "string") return [];
          const checkpoint = JSON.parse(json) as ReturnType<typeof historyCheckpoint>;
          return checkpoint.checkpointHistory ? values : (normalizeAgentRunState(checkpoint)[page.field] ?? []).slice(page.offset ?? 0, (page.offset ?? 0) + (page.limit ?? 50));
        })
    } : {}),
    load(runId, scope) {
      return readSnapshot(() => {
        const row = loadStatement.get([physicalKey(runId, scope)]);
        const stateJson = getRecordField(row, ["state_json", "stateJson"]);
        if (typeof stateJson !== "string") return undefined;
        const state = deserialize(stateJson);
        return matchesRun(state, runId, resolveScope(options.scope, scope)) ? state : undefined;
      });
    },
    findByIdempotencyKey(idempotencyKey, scope) {
      return readSnapshot(() => findByIdempotencyKey(idempotencyKey, scope));
    },
    findByParentRunId(parentRunId, scope) {
      return readSnapshot(() => {
        const targetScope = resolveScope(options.scope, scope);
        const states = new Map<string, AgentRunState>();
        for (const key of [dbKey(parentRunId, scope), legacyScopedKey(targetScope, parentRunId)]) {
          const rows = findParentStatement.all?.([key]) ?? [findParentStatement.get([key])];
          for (const row of rows) {
            const json = getRecordField(row, ["state_json", "stateJson"]);
            if (typeof json !== "string") continue;
            const state = JSON.parse(json) as AgentRunState;
            if (state.parentRunId === parentRunId && matchesScope(state.scope, targetScope)) states.set(state.runId, deserialize(json));
          }
        }
        return [...states.values()];
      });
    },
    claimIdempotencyKey(state) {
      options.db.exec("BEGIN IMMEDIATE");
      try {
        const scope = resolveScope(options.scope, state.scope);
        const existingState = findByIdempotencyKey(state.idempotencyKey, scope);
        if (existingState) {
          options.db.exec("COMMIT");
          return { claimed: false, state: existingState };
        }

        const normalized = normalizeAgentRunState({ ...state, ...(scope ? { scope } : {}) });
        const updatedAt = Date.now();
        saveStatement.run([physicalKey(normalized.runId, scope), serialize(normalized), updatedAt]);
        saveIdempotencyStatement.run([dbKey(state.idempotencyKey, scope), physicalKey(normalized.runId, scope), updatedAt]);
        if (normalized.parentRunId) {
          saveParentStatement.run([physicalKey(normalized.runId, scope), dbKey(normalized.parentRunId, scope), updatedAt]);
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
        const currentRow = loadStatement.get([physicalKey(state.runId, scope)]);
        const currentJson = getRecordField(currentRow, ["state_json", "stateJson"]);
        const current = typeof currentJson === "string"
          ? JSON.parse(currentJson) as AgentRunState
          : undefined;
        assertExpectedRevision(current, saveOptions?.expectedRevision);

        const normalized = nextStoredState(state, saveOptions);
        if (normalized.idempotencyKey) {
          const owner = findByIdempotencyKey(normalized.idempotencyKey, scope);
          if (owner && owner.runId !== normalized.runId) {
            throw new ConflictError("AgentRunState idempotency key conflict.");
          }
        }

        const updatedAt = Date.now();
        const stored = { ...normalized, ...(scope ? { scope } : {}) };
        saveStatement.run([physicalKey(normalized.runId, scope), serialize(stored), updatedAt]);
        if (normalized.idempotencyKey) {
          saveIdempotencyStatement.run([dbKey(normalized.idempotencyKey, scope), physicalKey(normalized.runId, scope), updatedAt]);
        }
        deleteParentStatement.run([physicalKey(normalized.runId, scope)]);
        if (normalized.parentRunId) {
          saveParentStatement.run([physicalKey(normalized.runId, scope), dbKey(normalized.parentRunId, scope), updatedAt]);
        }
        options.db.exec("COMMIT");
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    delete(runId, scope) {
      const key = physicalKey(runId, scope);
      options.db.exec("BEGIN IMMEDIATE");
      try {
        deleteStatement.run([key]);
        deleteIdempotencyStatement.run([key]);
        deleteParentStatement.run([key]);
        deleteRunLeaseStatement.run([key]);
        deleteRunJournalStatement.run([key]);
        history?.delete(key);
        options.db.exec("COMMIT");
      } catch (error) {
        options.db.exec("ROLLBACK");
        throw error;
      }
    },
    list(listOptions, scope) {
      return readSnapshot(() => {
        const rows = listStatement.all?.([]) ?? [];
        const targetScope = resolveScope(options.scope, scope);
        const states = rows.flatMap((row) => {
          const value = getRecordField(row, ["state_json", "stateJson"]);
          if (typeof value !== "string") return [];
          const state = JSON.parse(value) as AgentRunState;
          return !targetScope || matchesScope(state.scope, targetScope) ? [state] : [];
        });
        return listStates(states, listOptions, state => deserialize(JSON.stringify(state)));
      });
    },
    deleteExpired(retention, scope) {
      const page = this.list?.({ statuses: retention.statuses, updatedBefore: retention.before, limit: retention.limit ?? 1_000 }, scope) as AgentRunPage;
      for (const state of page.items) this.delete?.(state.runId, state.scope);
      return page.items.length;
    },
    acquireLease(runId, leaseOptions, scope) {
      validateLeaseOptions(leaseOptions);
      const now = leaseOptions.now ?? Date.now();
      const key = physicalKey(runId, scope);
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
      const key = physicalKey(runId, scope);
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
      const key = physicalKey(runId, scope);
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
      const row = loadJournalStatement.get([physicalKey(runId, scope), toolCallId]);
      const value = getRecordField(row, ["entry_json", "entryJson"]);
      const entry = typeof value === "string" ? JSON.parse(value) as AgentToolCallJournalEntry : undefined;
      if (entry && (!matchesRun(entry, runId, resolveScope(options.scope, scope)) || entry.toolCallId !== toolCallId)) throw new ConflictError("Persisted journal identity cannot be verified; reconcile or migrate before executing the tool.");
      return entry;
    },
    loadToolExecution(runId, toolCallId, scope) {
      return this.loadToolCall?.(runId, toolCallId, scope);
    },
    listToolCalls(runId, scope) {
      const rows = listJournalStatement.all?.([physicalKey(runId, scope)]) ?? [];
      return rows.flatMap((row) => {
        const value = getRecordField(row, ["entry_json", "entryJson"]);
        const entry = typeof value === "string" ? JSON.parse(value) as AgentToolCallJournalEntry : undefined;
        if (entry && !matchesRun(entry, runId, resolveScope(options.scope, scope))) throw new ConflictError("Persisted journal identity cannot be verified; reconcile or migrate before continuing.");
        return entry ? [entry] : [];
      });
    },
    saveToolCall(entry, journalOptions) {
      options.db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope) as AgentToolCallJournalEntry | undefined;
        assertJournalRevision(current, journalOptions?.expectedRevision);
        const scope = resolveScope(options.scope, entry.scope);
        const next = nextJournalEntry({ ...entry, ...(scope ? { scope } : {}) }, journalOptions);
        saveJournalStatement.run([physicalKey(entry.runId, entry.scope), entry.toolCallId, JSON.stringify(next), next.revision, next.updatedAt]);
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
        const scope = resolveScope(options.scope, entry.scope);
        const next = nextJournalEntry({ ...entry, ...(scope ? { scope } : {}), status: "running", revision: 0 });
        insertJournalStatement.run([physicalKey(entry.runId, entry.scope), entry.toolCallId, JSON.stringify(next), 0, next.updatedAt]);
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
  const memoryContext = (context: AgentMemoryContext) => ({ ...context, scope: resolveScope(options.scope, context.scope) });
  const encode = (context: AgentMemoryContext, messages: ModelMessage[]) => options.key ? messages : encodeAgentMemory(memoryContext(context), messages);
  const decode = (context: AgentMemoryContext, value: unknown) => options.key ? value as ModelMessage[] : decodeAgentMemory(memoryContext(context), value);

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

  const assertMemoryIdentity = (context: AgentMemoryContext) => {
    if (options.key) return;
    const current = getRecordField(loadStatement.get([keyFor(context)]), ["messages_json", "messagesJson"]);
    if (typeof current === "string") { decode(context, JSON.parse(current)); return; }
    const legacy = legacyDefaultMemoryKey({ ...context, scope: resolveScope(options.scope, context.scope) });
    if (loadStatement.get([legacy])) throw new ValidationError(LEGACY_MEMORY_MIGRATION_MESSAGE);
  };

  return {
    load(context) {
      assertMemoryIdentity(context);
      const row = loadStatement.get([keyFor(context)]);
      const messagesJson = getRecordField(row, ["messages_json", "messagesJson"]);
      return typeof messagesJson === "string" ? decode(context, JSON.parse(messagesJson)) : [];
    },
    save(context) {
      assertMemoryIdentity(context);
      saveStatement.run([keyFor(context), JSON.stringify(encode(context, selectMessages(context.state))), Date.now()]);
    }
  };
};
