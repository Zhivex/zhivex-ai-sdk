import { promises as fs } from "node:fs";
import path from "node:path";

import { ConflictError, ValidationError } from "./errors.js";
import { assertPostgresClient } from "./postgres-client.js";
import type { JsonValue, PostgresClientLike, SqliteDatabaseLike, SqliteStatementLike } from "./types.js";
import { normalizeWorkflowRunState, WORKFLOW_RUN_STATE_SCHEMA_VERSION, type PersistedWorkflowRunState, type WorkflowStatus } from "./workflow.js";

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const WORKFLOW_STATE_RECORD_SCHEMA_VERSION = 1 as const;

export interface WorkflowStateLookup {
  appName: string;
  userId: string;
  sessionId: string;
  workflowKey: string;
}

export interface WorkflowStateListInput {
  appName: string;
  userId: string;
  sessionId?: string;
  workflowKey?: string;
  status?: WorkflowStatus;
}

export interface WorkflowStateSaveInput extends WorkflowStateLookup {
  state: PersistedWorkflowRunState;
  expectedRevision?: number;
}

export interface WorkflowStateRecord extends WorkflowStateLookup {
  schemaVersion: typeof WORKFLOW_STATE_RECORD_SCHEMA_VERSION;
  revision: number;
  state: PersistedWorkflowRunState;
  status: WorkflowStatus;
  runId: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStateService {
  saveWorkflowState(input: WorkflowStateSaveInput): Promise<WorkflowStateRecord> | WorkflowStateRecord;
  loadWorkflowState(input: WorkflowStateLookup): Promise<WorkflowStateRecord | undefined> | WorkflowStateRecord | undefined;
  listWorkflowStates(input: WorkflowStateListInput): Promise<WorkflowStateRecord[]> | WorkflowStateRecord[];
  deleteWorkflowState(input: WorkflowStateLookup): Promise<void> | void;
}

export interface FileWorkflowStateServiceOptions {
  directory: string;
}

export interface FileWorkflowStateStorePruneOptions extends FileWorkflowStateServiceOptions {
  olderThanMs?: number;
  keepLast?: number;
  now?: number;
  dryRun?: boolean;
}

export interface FileWorkflowStateStorePruneResult {
  directory: string;
  dryRun: boolean;
  deletedWorkflowStateKeys: string[];
  keptWorkflowStateKeys: string[];
}

export interface SqliteWorkflowStateServiceOptions {
  db: SqliteDatabaseLike;
  tableName?: string;
}

export interface PostgresWorkflowStateServiceOptions {
  client: PostgresClientLike;
  tableName?: string;
}

export type WorkflowStateRecordMigrationTarget = typeof WORKFLOW_STATE_RECORD_SCHEMA_VERSION;

const workflowStateKey = (input: WorkflowStateLookup): string =>
  `${input.appName}:${input.userId}:${input.sessionId}:${input.workflowKey}`;

const fileNameForWorkflowState = (input: WorkflowStateLookup): string =>
  [input.appName, input.userId, input.sessionId, input.workflowKey].map((part) => encodeURIComponent(part)).join("__") + ".json";

export const normalizeWorkflowStateRecord = (value: unknown): WorkflowStateRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("WorkflowStateRecord must be an object.");
  }
  const record = value as Partial<WorkflowStateRecord> & { schemaVersion?: number };
  if (record.schemaVersion !== undefined && record.schemaVersion > WORKFLOW_STATE_RECORD_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported WorkflowStateRecord schemaVersion ${record.schemaVersion}.`);
  }
  if (
    typeof record.appName !== "string" ||
    typeof record.userId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.workflowKey !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.status !== "string" ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number" ||
    !record.state
  ) {
    throw new ValidationError("WorkflowStateRecord is missing required fields.");
  }
  return {
    schemaVersion: WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
    revision: typeof record.revision === "number" ? record.revision : 1,
    appName: record.appName,
    userId: record.userId,
    sessionId: record.sessionId,
    workflowKey: record.workflowKey,
    state: normalizeWorkflowRunState(record.state),
    status: record.status as WorkflowStatus,
    runId: record.runId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
};

export const migrateWorkflowStateRecord = (
  value: unknown,
  targetVersion: WorkflowStateRecordMigrationTarget = WORKFLOW_STATE_RECORD_SCHEMA_VERSION
): WorkflowStateRecord => {
  if (targetVersion !== WORKFLOW_STATE_RECORD_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported WorkflowStateRecord migration target ${targetVersion}.`);
  }
  return normalizeWorkflowStateRecord(value);
};

const assertExpectedRevision = (
  current: { revision: number } | undefined,
  expectedRevision: number | undefined
) => {
  if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
    throw new ConflictError("WorkflowStateRecord revision conflict.");
  }
};

const sqliteMutationCount = (result: unknown): number | undefined => {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const value = record.changes ?? record.changeset ?? record.rowCount;
  return typeof value === "number" ? value : undefined;
};

const cloneRecord = (record: WorkflowStateRecord): WorkflowStateRecord => cloneJson(normalizeWorkflowStateRecord(record));

const createRecord = (input: WorkflowStateSaveInput, existing?: WorkflowStateRecord): WorkflowStateRecord => {
  const now = Date.now();
  const state = normalizeWorkflowRunState(input.state);
  return {
    schemaVersion: WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
    revision: existing ? existing.revision + 1 : 1,
    appName: input.appName,
    userId: input.userId,
    sessionId: input.sessionId,
    workflowKey: input.workflowKey,
    state: cloneJson({ ...state, schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION }),
    status: state.status,
    runId: state.runId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
};

const matchesListInput = (record: WorkflowStateRecord, input: WorkflowStateListInput): boolean =>
  record.appName === input.appName &&
  record.userId === input.userId &&
  (input.sessionId === undefined || record.sessionId === input.sessionId) &&
  (input.workflowKey === undefined || record.workflowKey === input.workflowKey) &&
  (input.status === undefined || record.status === input.status);

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

const parseWorkflowStateJson = (value: unknown): WorkflowStateRecord | undefined => {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return normalizeWorkflowStateRecord(JSON.parse(value) as WorkflowStateRecord);
  }
  return normalizeWorkflowStateRecord(value);
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

export const createInMemoryWorkflowStateService = (): WorkflowStateService => {
  const states = new Map<string, WorkflowStateRecord>();
  return {
    saveWorkflowState(input) {
      const existing = states.get(workflowStateKey(input));
      assertExpectedRevision(existing, input.expectedRevision);
      const record = createRecord(input, existing);
      states.set(workflowStateKey(input), cloneRecord(record));
      return cloneRecord(record);
    },
    loadWorkflowState(input) {
      const record = states.get(workflowStateKey(input));
      return record ? cloneRecord(record) : undefined;
    },
    listWorkflowStates(input) {
      return [...states.values()]
        .filter((record) => matchesListInput(record, input))
        .sort((left, right) => left.updatedAt - right.updatedAt || left.workflowKey.localeCompare(right.workflowKey))
        .map(cloneRecord);
    },
    deleteWorkflowState(input) {
      states.delete(workflowStateKey(input));
    }
  };
};

export const createFileWorkflowStateService = (options: FileWorkflowStateServiceOptions): WorkflowStateService => {
  const filePath = (input: WorkflowStateLookup) => path.join(options.directory, fileNameForWorkflowState(input));
  const load = async (input: WorkflowStateLookup): Promise<WorkflowStateRecord | undefined> => {
    try {
      return normalizeWorkflowStateRecord(JSON.parse(await fs.readFile(filePath(input), "utf8")) as WorkflowStateRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };
  return {
    async saveWorkflowState(input) {
      const existing = await load(input);
      assertExpectedRevision(existing, input.expectedRevision);
      const record = createRecord(input, existing);
      await fs.mkdir(options.directory, { recursive: true });
      await fs.writeFile(filePath(input), JSON.stringify(record, null, 2), "utf8");
      return cloneRecord(record);
    },
    loadWorkflowState(input) {
      return load(input);
    },
    async listWorkflowStates(input) {
      let entries: string[];
      try {
        entries = await fs.readdir(options.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
      const records: WorkflowStateRecord[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const record = normalizeWorkflowStateRecord(JSON.parse(await fs.readFile(path.join(options.directory, entry), "utf8")) as WorkflowStateRecord);
        if (matchesListInput(record, input)) {
          records.push(cloneRecord(record));
        }
      }
      return records.sort((left, right) => left.updatedAt - right.updatedAt || left.workflowKey.localeCompare(right.workflowKey));
    },
    async deleteWorkflowState(input) {
      try {
        await fs.unlink(filePath(input));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  };
};

export const pruneFileWorkflowStateStore = async (
  options: FileWorkflowStateStorePruneOptions
): Promise<FileWorkflowStateStorePruneResult> => {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? true;
  let entries: string[];
  try {
    entries = await fs.readdir(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { directory: options.directory, dryRun, deletedWorkflowStateKeys: [], keptWorkflowStateKeys: [] };
    }
    throw error;
  }

  const records: Array<{ filePath: string; key: string; updatedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(options.directory, entry);
    const record = normalizeWorkflowStateRecord(JSON.parse(await fs.readFile(filePath, "utf8")) as WorkflowStateRecord);
    records.push({
      filePath,
      key: workflowStateKey(record),
      updatedAt: record.updatedAt
    });
  }

  const sorted = records.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key));
  const keepByCount = new Set(
    options.keepLast === undefined ? [] : sorted.slice(0, Math.max(0, options.keepLast)).map((record) => record.key)
  );
  const shouldDelete = (record: { key: string; updatedAt: number }) =>
    !keepByCount.has(record.key) &&
    (options.olderThanMs !== undefined ? now - record.updatedAt > options.olderThanMs : options.keepLast !== undefined);
  const deleted = sorted.filter(shouldDelete);

  if (!dryRun) {
    for (const record of deleted) {
      await fs.unlink(record.filePath);
    }
  }

  return {
    directory: options.directory,
    dryRun,
    deletedWorkflowStateKeys: deleted.map((record) => record.key),
    keptWorkflowStateKeys: sorted.filter((record) => !shouldDelete(record)).map((record) => record.key)
  };
};

export const createSqliteWorkflowStateService = (options: SqliteWorkflowStateServiceOptions): WorkflowStateService => {
  const tableName = validateIdentifier(options.tableName ?? "zhivex_workflow_states", "tableName");
  options.db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      workflow_state_key TEXT PRIMARY KEY,
      app_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workflow_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  const loadStatement = prepareSqliteStatement<{ state_json?: string; stateJson?: string }>(
    options.db,
    `SELECT state_json FROM ${tableName} WHERE workflow_state_key = ?`
  );
  const listStatement = prepareSqliteStatement<{ state_json?: string; stateJson?: string }>(
    options.db,
    `SELECT state_json FROM ${tableName}
     WHERE app_name = ?
       AND user_id = ?
       AND (? IS NULL OR session_id = ?)
       AND (? IS NULL OR workflow_key = ?)
       AND (? IS NULL OR status = ?)
     ORDER BY updated_at_ms ASC, workflow_key ASC`
  );
  const saveStatement = prepareSqliteStatement(options.db, `
    INSERT INTO ${tableName} (
      workflow_state_key, app_name, user_id, session_id, workflow_key, run_id, status, state_json, created_at_ms, updated_at_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workflow_state_key) DO UPDATE SET
      app_name = excluded.app_name,
      user_id = excluded.user_id,
      session_id = excluded.session_id,
      workflow_key = excluded.workflow_key,
      run_id = excluded.run_id,
      status = excluded.status,
      state_json = excluded.state_json,
      updated_at_ms = excluded.updated_at_ms
  `);
  const updateCasStatement = prepareSqliteStatement(options.db, `
    UPDATE ${tableName}
    SET app_name = ?,
        user_id = ?,
        session_id = ?,
        workflow_key = ?,
        run_id = ?,
        status = ?,
        state_json = ?,
        updated_at_ms = ?
    WHERE workflow_state_key = ?
      AND updated_at_ms = ?
  `);
  const deleteStatement = prepareSqliteStatement(options.db, `DELETE FROM ${tableName} WHERE workflow_state_key = ?`);
  const load = (input: WorkflowStateLookup): WorkflowStateRecord | undefined =>
    parseWorkflowStateJson(getRecordField(loadStatement.get([workflowStateKey(input)]), ["state_json", "stateJson"]));
  const save = (
    record: WorkflowStateRecord,
    options?: { existing?: WorkflowStateRecord; expectedRevision?: number }
  ): WorkflowStateRecord => {
    if (options?.expectedRevision !== undefined && options.existing) {
      const result = updateCasStatement.run([
        record.appName,
        record.userId,
        record.sessionId,
        record.workflowKey,
        record.runId,
        record.status,
        JSON.stringify(record),
        record.updatedAt,
        workflowStateKey(record),
        options.existing.updatedAt
      ]);
      if (sqliteMutationCount(result) === 0) {
        throw new ConflictError("WorkflowStateRecord revision conflict.");
      }
    } else {
      saveStatement.run([
        workflowStateKey(record),
        record.appName,
        record.userId,
        record.sessionId,
        record.workflowKey,
        record.runId,
        record.status,
        JSON.stringify(record),
        record.createdAt,
        record.updatedAt
      ]);
    }
    return cloneRecord(record);
  };
  return {
    saveWorkflowState(input) {
      const existing = load(input);
      assertExpectedRevision(existing, input.expectedRevision);
      return save(createRecord(input, existing), {
        existing,
        expectedRevision: input.expectedRevision
      });
    },
    loadWorkflowState(input) {
      return load(input);
    },
    listWorkflowStates(input) {
      const params = [
        input.appName,
        input.userId,
        input.sessionId ?? null,
        input.sessionId ?? null,
        input.workflowKey ?? null,
        input.workflowKey ?? null,
        input.status ?? null,
        input.status ?? null
      ];
      const rows = listStatement.all?.(params) ?? [];
      return rows.flatMap((row) => {
        const record = parseWorkflowStateJson(getRecordField(row, ["state_json", "stateJson"]));
        return record ? [record] : [];
      });
    },
    deleteWorkflowState(input) {
      deleteStatement.run([workflowStateKey(input)]);
    }
  };
};

export const createPostgresWorkflowStateService = (options: PostgresWorkflowStateServiceOptions): WorkflowStateService => {
  assertPostgresClient(options.client);
  const tableName = validateIdentifier(options.tableName ?? "zhivex_workflow_states", "tableName");
  const createSql = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      workflow_state_key TEXT PRIMARY KEY,
      app_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workflow_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      state_json JSONB NOT NULL,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )
  `;
  const load = async (input: WorkflowStateLookup): Promise<WorkflowStateRecord | undefined> => {
    await ensurePostgresTable(options.client, tableName, createSql);
    const result = await options.client.query<{ state_json?: WorkflowStateRecord; stateJson?: WorkflowStateRecord }>(
      `SELECT state_json FROM ${tableName} WHERE workflow_state_key = $1`,
      [workflowStateKey(input)]
    );
    return parseWorkflowStateJson(getRecordField(result.rows[0], ["state_json", "stateJson"]));
  };
  const save = async (
    record: WorkflowStateRecord,
    saveOptions?: { existing?: WorkflowStateRecord; expectedRevision?: number }
  ): Promise<WorkflowStateRecord> => {
    await ensurePostgresTable(options.client, tableName, createSql);
    if (saveOptions?.expectedRevision !== undefined && saveOptions.existing) {
      const result = await options.client.query(
        `UPDATE ${tableName}
         SET app_name = $2,
             user_id = $3,
             session_id = $4,
             workflow_key = $5,
             run_id = $6,
             status = $7,
             state_json = $8::jsonb,
             updated_at_ms = $9
         WHERE workflow_state_key = $1
           AND updated_at_ms = $10
         RETURNING state_json`,
        [
          workflowStateKey(record),
          record.appName,
          record.userId,
          record.sessionId,
          record.workflowKey,
          record.runId,
          record.status,
          JSON.stringify(record),
          record.updatedAt,
          saveOptions.existing.updatedAt
        ]
      );
      if (result.rows.length === 0) {
        throw new ConflictError("WorkflowStateRecord revision conflict.");
      }
    } else {
      await options.client.query(
        `INSERT INTO ${tableName} (
           workflow_state_key, app_name, user_id, session_id, workflow_key, run_id, status, state_json, created_at_ms, updated_at_ms
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         ON CONFLICT(workflow_state_key) DO UPDATE SET
           app_name = EXCLUDED.app_name,
           user_id = EXCLUDED.user_id,
           session_id = EXCLUDED.session_id,
           workflow_key = EXCLUDED.workflow_key,
           run_id = EXCLUDED.run_id,
           status = EXCLUDED.status,
           state_json = EXCLUDED.state_json,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [
          workflowStateKey(record),
          record.appName,
          record.userId,
          record.sessionId,
          record.workflowKey,
          record.runId,
          record.status,
          JSON.stringify(record),
          record.createdAt,
          record.updatedAt
        ]
      );
    }
    return cloneRecord(record);
  };
  return {
    async saveWorkflowState(input) {
      const existing = await load(input);
      assertExpectedRevision(existing, input.expectedRevision);
      return save(createRecord(input, existing), {
        existing,
        expectedRevision: input.expectedRevision
      });
    },
    loadWorkflowState(input) {
      return load(input);
    },
    async listWorkflowStates(input) {
      await ensurePostgresTable(options.client, tableName, createSql);
      const result = await options.client.query<{ state_json?: WorkflowStateRecord; stateJson?: WorkflowStateRecord }>(
        `SELECT state_json FROM ${tableName}
         WHERE app_name = $1
           AND user_id = $2
           AND ($3::text IS NULL OR session_id = $3)
           AND ($4::text IS NULL OR workflow_key = $4)
           AND ($5::text IS NULL OR status = $5)
         ORDER BY updated_at_ms ASC, workflow_key ASC`,
        [input.appName, input.userId, input.sessionId ?? null, input.workflowKey ?? null, input.status ?? null]
      );
      return result.rows.flatMap((row) => {
        const record = parseWorkflowStateJson(getRecordField(row, ["state_json", "stateJson"]));
        return record ? [record] : [];
      });
    },
    async deleteWorkflowState(input) {
      await ensurePostgresTable(options.client, tableName, createSql);
      await options.client.query(`DELETE FROM ${tableName} WHERE workflow_state_key = $1`, [workflowStateKey(input)]);
    }
  };
};
