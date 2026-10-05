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
  legacyScopedKey,
  matchesRun,
  matchesScope,
  resolveScope,
  getRecordField,
  nextStoredState,
  listStates,
  parseAgentRunListOptions,
  validateLeaseOptions,
  cloneJournalEntry,
  nextJournalEntry,
  defaultMemoryKey,
  legacyDefaultMemoryKey,
  encodeAgentMemory,
  decodeAgentMemory,
  LEGACY_MEMORY_MIGRATION_MESSAGE,
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
  // Use persisted logical timestamps, not the database write timestamp. These
  // expressions also apply to legacy rows without changing their physical keys.
  const sortTimeSql = "COALESCE((state_json->>'updatedAt')::double precision, (state_json->>'startedAt')::double precision, 0)";
  const updatedTimeSql = "COALESCE((state_json->>'updatedAt')::double precision, 0)";
  const tenantSql = "(state_json #>> '{scope,tenantId}')";
  const userSql = "(state_json #>> '{scope,userId}')";
  const namespaceSql = "(state_json #>> '{scope,namespace}')";
  // Scope strings are unbounded. Hash index entries so valid long identifiers
  // cannot exceed PostgreSQL's B-tree tuple limit; raw predicates below still
  // establish exact identity even if two values ever share a digest.
  const scopeHashSql = (expression: string) => `md5(${expression})`;
  // JS string ordering compares UTF-16 code units. PostgreSQL's C collation
  // compares UTF-8 bytes instead, so supplementary characters need surrogate
  // pairs in this sort key to preserve existing cursors exactly.
  const runIdSortSql = `(SELECT string_agg(
    CASE WHEN ascii(character) <= 65535 THEN lpad(to_hex(ascii(character)), 4, '0')
      ELSE lpad(to_hex(55296 + (ascii(character) - 65536) / 1024), 4, '0')
        || lpad(to_hex(56320 + (ascii(character) - 65536) % 1024), 4, '0') END,
    '' ORDER BY position)
    FROM regexp_split_to_table(state_json->>'runId', '') WITH ORDINALITY AS units(character, position)) COLLATE "C"`;
  // Recreate scopedKey from logical JSON identity, including legacy rows. Build
  // compact JSON explicitly: json[b]_build_array textual output adds spaces.
  const scopeTupleSql = `CASE WHEN state_json->'scope' IS NULL THEN 'null' ELSE
    '[' || COALESCE((state_json #> '{scope,namespace}')::text, 'null') || ','
      || (state_json #> '{scope,tenantId}')::text || ','
      || COALESCE((state_json #> '{scope,userId}')::text, 'null') || ']' END`;
  const scopedSortSql = `('agent-run:v2:' || encode(sha256(convert_to(
    '[' || to_json((${scopeTupleSql})::text)::text || ',' || (state_json->'runId')::text || ']',
    'UTF8')), 'hex')) COLLATE "C"`;
  const createIndexesSql = `
    CREATE INDEX IF NOT EXISTS ${tableName}_updated_idx ON ${tableName} (updated_at_ms DESC, run_id);
    CREATE INDEX IF NOT EXISTS ${tableName}_scope_hash_page_idx ON ${tableName} ((${scopeHashSql(tenantSql)}), (${scopeHashSql(userSql)}), (${scopeHashSql(namespaceSql)}), (${sortTimeSql}) DESC);
    CREATE INDEX IF NOT EXISTS ${tableName}_logical_time_idx ON ${tableName} ((${sortTimeSql}) DESC);
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

  const physicalKey = async (runId: string, scope?: AgentStoreScope): Promise<string> => {
    const targetScope = resolveScope(options.scope, scope);
    const canonical = dbKey(runId, scope);
    for (const key of [canonical, legacyScopedKey(targetScope, runId)]) {
      const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(`SELECT state_json FROM ${tableName} WHERE run_id = $1`, [key]);
      const state = getRecordField(result.rows[0], ["state_json", "stateJson"]) as AgentRunState | undefined;
      if (state && matchesRun(state, runId, targetScope)) return key;
      if (state && key === canonical) throw new ConflictError("Canonical agent key is occupied by a different legacy identity; migrate that identity before writing.");
    }
    return canonical;
  };
  const findByIdempotencyKey = async (idempotencyKey: string, scope?: AgentStoreScope): Promise<AgentRunState | undefined> => {
    const targetScope = resolveScope(options.scope, scope);
    for (const key of [dbKey(idempotencyKey, scope), legacyScopedKey(targetScope, idempotencyKey)]) {
      const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(
        `SELECT runs.state_json FROM ${tableName} runs INNER JOIN ${idempotencyTableName} keys ON keys.run_id = runs.run_id WHERE keys.idempotency_key = $1`, [key]);
      const state = getRecordField(result.rows[0], ["state_json", "stateJson"]) as AgentRunState | undefined;
      if (state && state.idempotencyKey === idempotencyKey && matchesScope(state.scope, targetScope)) return normalizeAgentRunState(state);
      if (state && key === dbKey(idempotencyKey, scope)) throw new ConflictError("Canonical idempotency key is occupied by a different legacy identity; migrate that index before writing.");
    }
    return undefined;
  };

  return {
    async load(runId, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(
        `SELECT state_json FROM ${tableName} WHERE run_id = $1`,
        [await physicalKey(runId, scope)]
      );
      const state = result.rows[0] ? ((getRecordField(result.rows[0], ["state_json", "stateJson"]) as AgentRunState | undefined) ?? undefined) : undefined;
      return state && matchesRun(state, runId, resolveScope(options.scope, scope)) ? normalizeAgentRunState(state) : undefined;
    },
    async findByIdempotencyKey(idempotencyKey, scope) {
      await ensureAllTables();
      return findByIdempotencyKey(idempotencyKey, scope);
    },
    async findByParentRunId(parentRunId, scope) {
      await ensureAllTables();
      const targetScope = resolveScope(options.scope, scope);
      const states = new Map<string, AgentRunState>();
      for (const key of [dbKey(parentRunId, scope), legacyScopedKey(targetScope, parentRunId)]) {
        const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(
          `SELECT runs.state_json FROM ${tableName} runs INNER JOIN ${parentTableName} parents ON parents.run_id = runs.run_id WHERE parents.parent_run_id = $1`, [key]);
        for (const row of result.rows) {
          const state = getRecordField(row, ["state_json", "stateJson"]) as AgentRunState | undefined;
          if (state && state.parentRunId === parentRunId && matchesScope(state.scope, targetScope)) states.set(state.runId, normalizeAgentRunState(state));
        }
      }
      return [...states.values()];
    },
    async claimIdempotencyKey(state) {
      await ensureAllTables();
      const scope = resolveScope(options.scope, state.scope);
      const existingOwner = await findByIdempotencyKey(state.idempotencyKey, scope);
      if (existingOwner) return { claimed: false, state: existingOwner };
      const normalized = normalizeAgentRunState({ ...state, ...(scope ? { scope } : {}) });
      const updatedAt = Date.now();

      await options.client.query(
        `INSERT INTO ${tableName} (run_id, state_json, updated_at_ms)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT(run_id) DO NOTHING`,
        [await physicalKey(normalized.runId, scope), normalized, updatedAt]
      );
      const claim = await options.client.query<{ run_id?: string; runId?: string }>(
        `INSERT INTO ${idempotencyTableName} (idempotency_key, run_id, updated_at_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT(idempotency_key) DO NOTHING
         RETURNING run_id`,
        [dbKey(state.idempotencyKey, scope), await physicalKey(normalized.runId, scope), updatedAt]
      );
      const claimedRunId = getRecordField(claim.rows[0], ["run_id", "runId"]);
      if (claimedRunId === await physicalKey(normalized.runId, scope)) {
        if (normalized.parentRunId) {
          await options.client.query(
            `INSERT INTO ${parentTableName} (run_id, parent_run_id, updated_at_ms)
             VALUES ($1, $2, $3)
             ON CONFLICT(run_id) DO UPDATE SET
               parent_run_id = EXCLUDED.parent_run_id,
               updated_at_ms = EXCLUDED.updated_at_ms`,
            [await physicalKey(normalized.runId, scope), dbKey(normalized.parentRunId, scope), updatedAt]
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
      if (!existingState || existingState.idempotencyKey !== state.idempotencyKey || !matchesScope(existingState.scope, scope)) {
        throw new ConflictError("AgentRunState idempotency claim could not be loaded with the expected identity.");
      }
      if (existingState.runId !== normalized.runId) {
        await options.client.query(`DELETE FROM ${tableName} WHERE run_id = $1`, [await physicalKey(normalized.runId, scope)]);
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
        const existingOwner = await findByIdempotencyKey(normalized.idempotencyKey, scope);
        if (existingOwner && existingOwner.runId !== normalized.runId) throw new ConflictError("AgentRunState idempotency key conflict.");
        const owner = await options.client.query<{ run_id?: string; runId?: string }>(
          `SELECT run_id FROM ${idempotencyTableName} WHERE idempotency_key = $1`,
          [dbKey(normalized.idempotencyKey, scope)]
        );
        const ownerRunId = getRecordField(owner.rows[0], ["run_id", "runId"]);
        if (typeof ownerRunId === "string" && ownerRunId !== await physicalKey(normalized.runId, scope)) {
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
          [await physicalKey(normalized.runId, scope), stored, updatedAt]
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
          [await physicalKey(normalized.runId, scope), stored, updatedAt, saveOptions.expectedRevision]
        );
        if (getRecordField(saved.rows[0], ["run_id", "runId"]) !== await physicalKey(normalized.runId, scope)) {
          throw new ConflictError("AgentRunState revision conflict.");
        }
      }
      if (normalized.idempotencyKey) {
        await options.client.query(
          `INSERT INTO ${idempotencyTableName} (idempotency_key, run_id, updated_at_ms)
           VALUES ($1, $2, $3)
           ON CONFLICT(idempotency_key) DO NOTHING`,
          [dbKey(normalized.idempotencyKey, scope), await physicalKey(normalized.runId, scope), updatedAt]
        );
      }
      await options.client.query(`DELETE FROM ${parentTableName} WHERE run_id = $1`, [await physicalKey(normalized.runId, scope)]);
      if (normalized.parentRunId) {
        await options.client.query(
          `INSERT INTO ${parentTableName} (run_id, parent_run_id, updated_at_ms)
           VALUES ($1, $2, $3)
           ON CONFLICT(run_id) DO UPDATE SET
             parent_run_id = EXCLUDED.parent_run_id,
             updated_at_ms = EXCLUDED.updated_at_ms`,
          [await physicalKey(normalized.runId, scope), dbKey(normalized.parentRunId, scope), updatedAt]
        );
      }
    },
    async delete(runId, scope) {
      await ensureAllTables();
      const key = await physicalKey(runId, scope);
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
    async list(listOptions = {}, scope) {
      const targetScope = resolveScope(options.scope, scope);
      const { limit, cursor } = parseAgentRunListOptions(listOptions);
      const parameters: unknown[] = [];
      const bind = (value: unknown) => { parameters.push(value); return `$${parameters.length}`; };
      const predicates: string[] = [];
      if (targetScope) {
        for (const [expression, value] of [
          [tenantSql, targetScope.tenantId],
          [userSql, targetScope.userId],
          [namespaceSql, targetScope.namespace]
        ] as const) {
          if (value === undefined) {
            predicates.push(`${scopeHashSql(expression)} IS NULL`, `${expression} IS NULL`);
          } else {
            const parameter = `${bind(value)}::text`;
            predicates.push(`${scopeHashSql(expression)} = ${scopeHashSql(parameter)}`, `${expression} = ${parameter}`);
          }
        }
      }
      if (listOptions.agentId !== undefined) predicates.push(`state_json->>'agentId' = ${bind(listOptions.agentId)}::text`);
      if (listOptions.parentRunId !== undefined) predicates.push(`state_json->>'parentRunId' = ${bind(listOptions.parentRunId)}::text`);
      if (listOptions.statuses?.length) predicates.push(`state_json->>'status' = ANY(${bind(listOptions.statuses)}::text[])`);
      if (listOptions.updatedAfter !== undefined) predicates.push(`${updatedTimeSql} > ${bind(listOptions.updatedAfter)}::double precision`);
      if (listOptions.updatedBefore !== undefined) predicates.push(`${updatedTimeSql} < ${bind(listOptions.updatedBefore)}::double precision`);
      let cursorPredicate = "";
      if (cursor) {
        const utf16RunId = Array.from({ length: cursor[1].length }, (_, index) => cursor[1].charCodeAt(index).toString(16).padStart(4, "0")).join("");
        const time = bind(cursor[0]);
        const id = bind(utf16RunId);
        cursorPredicate = cursor[2] === undefined
          ? `WHERE (sort_time, run_id_sort) < (${time}::double precision, ${id}::text COLLATE "C")`
          : `WHERE (sort_time, run_id_sort, scope_sort) < (${time}::double precision, ${id}::text COLLATE "C", ${bind(cursor[2])}::text COLLATE "C")`;
      }
      const query = `WITH candidates AS (
        SELECT state_json, ${sortTimeSql} AS sort_time,
          ${runIdSortSql} AS run_id_sort, ${scopedSortSql} AS scope_sort
        FROM ${tableName}
        ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
      )
      SELECT state_json FROM candidates ${cursorPredicate}
      ORDER BY sort_time DESC, run_id_sort DESC, scope_sort DESC
      LIMIT ${bind(limit + 1)}::integer`;
      await ensureAllTables();
      const result = await options.client.query<{ state_json?: AgentRunState; stateJson?: AgentRunState }>(query, parameters);
      const states = result.rows.flatMap((row) => {
        const state = getRecordField(row, ["state_json", "stateJson"]) as AgentRunState | undefined;
        return state && (!targetScope || matchesScope(state.scope, targetScope)) ? [normalizeAgentRunState(state)] : [];
      });
      // At most limit + 1 matching states cross the connection. Shared projection
      // preserves exactly the same cursor format as memory, file and SQLite.
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
      const key = await physicalKey(runId, scope);
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
        [await physicalKey(runId, scope), leaseOptions.ownerId, expiresAt, now]
      );
      return getRecordField(result.rows[0], ["owner_id", "ownerId"]) === leaseOptions.ownerId
        ? { runId, ownerId: leaseOptions.ownerId, expiresAt }
        : undefined;
    },
    async releaseLease(runId, ownerId, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ owner_id?: string; ownerId?: string }>(
        `DELETE FROM ${leaseTableName} WHERE run_key = $1 AND owner_id = $2 RETURNING owner_id`,
        [await physicalKey(runId, scope), ownerId]
      );
      return getRecordField(result.rows[0], ["owner_id", "ownerId"]) === ownerId;
    },
    async loadToolCall(runId, toolCallId, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ entry_json?: AgentToolCallJournalEntry; entryJson?: AgentToolCallJournalEntry }>(
        `SELECT entry_json FROM ${journalTableName} WHERE run_key = $1 AND tool_call_id = $2`,
        [await physicalKey(runId, scope), toolCallId]
      );
      const entry = getRecordField(result.rows[0], ["entry_json", "entryJson"]);
      if (entry && typeof entry === "object" && (!matchesRun(entry as AgentToolCallJournalEntry, runId, resolveScope(options.scope, scope)) || (entry as AgentToolCallJournalEntry).toolCallId !== toolCallId)) throw new ConflictError("Persisted journal identity cannot be verified; reconcile or migrate before executing the tool.");
      return entry && typeof entry === "object" ? cloneJournalEntry(entry as AgentToolCallJournalEntry) : undefined;
    },
    async loadToolExecution(runId, toolCallId, scope) {
      return this.loadToolCall?.(runId, toolCallId, scope);
    },
    async listToolCalls(runId, scope) {
      await ensureAllTables();
      const result = await options.client.query<{ entry_json?: AgentToolCallJournalEntry; entryJson?: AgentToolCallJournalEntry }>(
        `SELECT entry_json FROM ${journalTableName} WHERE run_key = $1 ORDER BY updated_at_ms, tool_call_id`,
        [await physicalKey(runId, scope)]
      );
      return result.rows.flatMap((row) => {
        const entry = getRecordField(row, ["entry_json", "entryJson"]);
        if (entry && typeof entry === "object" && !matchesRun(entry as AgentToolCallJournalEntry, runId, resolveScope(options.scope, scope))) throw new ConflictError("Persisted journal identity cannot be verified; reconcile or migrate before continuing.");
        return entry && typeof entry === "object" ? [cloneJournalEntry(entry as AgentToolCallJournalEntry)] : [];
      });
    },
    async saveToolCall(entry, journalOptions) {
      await ensureAllTables();
      await this.loadToolCall?.(entry.runId, entry.toolCallId, entry.scope);
      const scope = resolveScope(options.scope, entry.scope);
      const next = nextJournalEntry({ ...entry, ...(scope ? { scope } : {}) }, journalOptions);
      const key = await physicalKey(entry.runId, entry.scope);
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
      const scope = resolveScope(options.scope, entry.scope);
      const next = nextJournalEntry({ ...entry, ...(scope ? { scope } : {}), status: "running", revision: 0 });
      const result = await options.client.query<{ entry_json?: AgentToolCallJournalEntry; entryJson?: AgentToolCallJournalEntry }>(
        `INSERT INTO ${journalTableName} (run_key, tool_call_id, entry_json, revision, updated_at_ms)
         SELECT $1, $2, $3::jsonb, 0, $4
         WHERE EXISTS (SELECT 1 FROM ${tableName} WHERE run_id = $1)
         ON CONFLICT(run_key, tool_call_id) DO NOTHING
         RETURNING entry_json`,
        [await physicalKey(entry.runId, entry.scope), entry.toolCallId, next, next.updatedAt]
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
  const memoryContext = (context: AgentMemoryContext) => ({ ...context, scope: resolveScope(options.scope, context.scope) });
  const encode = (context: AgentMemoryContext, messages: ModelMessage[]) => options.key ? messages : encodeAgentMemory(memoryContext(context), messages);
  const decode = (context: AgentMemoryContext, value: unknown) => options.key ? value as ModelMessage[] : decodeAgentMemory(memoryContext(context), value);

  const selectMessages = options.selectMessages ?? defaultMemoryMessages;
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      memory_key TEXT PRIMARY KEY,
      messages_json JSONB NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;

  const assertMemoryIdentity = async (context: AgentMemoryContext) => {
    if (options.key) return;
    const canonical = await options.client.query(`SELECT messages_json FROM ${tableName} WHERE memory_key = $1`, [keyFor(context)]);
    if (canonical.rows.length) { decode(context, getRecordField(canonical.rows[0], ["messages_json", "messagesJson"])); return; }
    const legacy = legacyDefaultMemoryKey({ ...context, scope: resolveScope(options.scope, context.scope) });
    const previous = await options.client.query(`SELECT messages_json FROM ${tableName} WHERE memory_key = $1`, [legacy]);
    if (previous.rows.length) throw new ValidationError(LEGACY_MEMORY_MIGRATION_MESSAGE);
  };

  return {
    async load(context) {
      await ensurePostgresTable(options.client, tableName, createSql);
      await assertMemoryIdentity(context);
      const result = await options.client.query<{ messages_json?: ModelMessage[]; messagesJson?: ModelMessage[] }>(
        `SELECT messages_json FROM ${tableName} WHERE memory_key = $1`,
        [keyFor(context)]
      );
      return result.rows[0]
        ? decode(context, getRecordField(result.rows[0], ["messages_json", "messagesJson"]))
        : [];
    },
    async save(context) {
      await ensurePostgresTable(options.client, tableName, createSql);
      await assertMemoryIdentity(context);
      await options.client.query(
        `INSERT INTO ${tableName} (memory_key, messages_json, updated_at_ms)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT(memory_key) DO UPDATE SET
           messages_json = EXCLUDED.messages_json,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [keyFor(context), encode(context, selectMessages(context.state)), Date.now()]
      );
    }
  };
};
