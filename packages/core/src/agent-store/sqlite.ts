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
  resolveScope,
  getRecordField,
  assertExpectedRevision,
  nextStoredState,
  scopePrefix,
  listStates,
  validateLeaseOptions,
  assertJournalRevision,
  nextJournalEntry,
  defaultMemoryKey,
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
