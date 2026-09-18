import { normalizeAgentRunState } from "../agent-state.js";
import { ConflictError, ValidationError } from "../errors.js";
import { assertPostgresClient } from "../postgres-client.js";
import type {
  AgentMemoryContext,
  AgentMemoryStore,
  AgentRunPage,
  AgentRunState,
  AgentRunStore,
  AgentStoreScope,
  AgentToolCallJournalEntry,
  ModelMessage,
  PostgresAgentMemoryStoreOptions,
  PostgresAgentRunStoreOptions,
  PostgresClientLike
} from "../types.js";
import {
  validateIdentifier,
  scopedKey,
  resolveScope,
  getRecordField,
  nextStoredState,
  scopePrefix,
  listStates,
  validateLeaseOptions,
  cloneJournalEntry,
  nextJournalEntry,
  defaultMemoryKey,
  defaultMemoryMessages
} from "./shared.js";

const isConcurrentPostgresTableCreationConflict = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
  return record.code === "23505" &&
    (record.constraint === "pg_type_typname_nsp_index" ||
      record.constraint_name === "pg_type_typname_nsp_index");
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
      initialization = (async () => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await client.query(createSql, []);
            return;
          } catch (error) {
            if (!isConcurrentPostgresTableCreationConflict(error) || attempt >= 2) {
              throw error;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          }
        }
      })();
      tables.set(tableName, initialization);
    }

    try {
      await initialization;
    } catch (error) {
      if (tables.get(tableName) === initialization) {
        tables.delete(tableName);
      }
      throw error;
    }
  };
})();

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
        [dbKey(normalized.runId, scope), normalized, updatedAt]
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
          [dbKey(normalized.runId, scope), stored, updatedAt]
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
          [dbKey(normalized.runId, scope), stored, updatedAt, saveOptions.expectedRevision]
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
          [key, entry.toolCallId, next, next.revision, next.updatedAt]
        )
        : await options.client.query<{ revision?: number | string }>(
          `UPDATE ${journalTableName}
           SET entry_json = $3::jsonb,
               revision = $4,
               updated_at_ms = $5
           WHERE run_key = $1 AND tool_call_id = $2 AND revision = $6
           RETURNING revision`,
          [key, entry.toolCallId, next, next.revision, next.updatedAt, journalOptions.expectedRevision]
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
        [dbKey(entry.runId, entry.scope), entry.toolCallId, next, next.updatedAt]
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
        [keyFor(context), selectMessages(context.state), Date.now()]
      );
    }
  };
};
