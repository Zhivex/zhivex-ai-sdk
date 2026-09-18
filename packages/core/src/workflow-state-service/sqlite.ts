import { ConflictError, ValidationError } from "../errors.js";
import type { SqliteDatabaseLike, SqliteStatementLike } from "../types.js";
import { type WorkflowStateRecord, type WorkflowStateService } from "../workflow-state-contracts.js";
import {
  type SqliteWorkflowStateServiceOptions,
  validateIdentifier,
  type WorkflowStateLookup,
  workflowStateKey,
  legacyWorkflowStateKey,
  parseWorkflowStateJson,
  getRecordField,
  matchesWorkflowStateLookup,
  cloneRecord,
  assertExpectedRevision,
  createRecord
} from "./shared.js";

const sqliteMutationCount = (result: unknown): number | undefined => {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const value = record.changes ?? record.changeset ?? record.rowCount;
  return typeof value === "number" ? value : undefined;
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
  const load = (input: WorkflowStateLookup): WorkflowStateRecord | undefined => {
    for (const key of [workflowStateKey(input), legacyWorkflowStateKey(input)]) {
      const record = parseWorkflowStateJson(
        getRecordField(loadStatement.get([key]), ["state_json", "stateJson"])
      );
      if (record && matchesWorkflowStateLookup(record, input)) {
        return record;
      }
    }
    return undefined;
  };
  const save = (
    record: WorkflowStateRecord,
    options?: { existing?: WorkflowStateRecord; expectedRevision?: number }
  ): WorkflowStateRecord => {
    if (options?.expectedRevision !== undefined && options.existing) {
      const canonical = parseWorkflowStateJson(
        getRecordField(loadStatement.get([workflowStateKey(record)]), ["state_json", "stateJson"])
      );
      if (canonical && matchesWorkflowStateLookup(canonical, record)) {
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
        const legacy = parseWorkflowStateJson(
          getRecordField(loadStatement.get([legacyWorkflowStateKey(record)]), ["state_json", "stateJson"])
        );
        if (!legacy || !matchesWorkflowStateLookup(legacy, record) || legacy.updatedAt !== options.existing.updatedAt) {
          throw new ConflictError("WorkflowStateRecord revision conflict.");
        }
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
    const legacy = parseWorkflowStateJson(
      getRecordField(loadStatement.get([legacyWorkflowStateKey(record)]), ["state_json", "stateJson"])
    );
    if (legacy && matchesWorkflowStateLookup(legacy, record)) {
      deleteStatement.run([legacyWorkflowStateKey(record)]);
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
      const records = new Map<string, WorkflowStateRecord>();
      for (const row of rows) {
        const record = parseWorkflowStateJson(getRecordField(row, ["state_json", "stateJson"]));
        if (record) {
          records.set(workflowStateKey(record), record);
        }
      }
      return [...records.values()];
    },
    deleteWorkflowState(input) {
      deleteStatement.run([workflowStateKey(input)]);
      const legacy = parseWorkflowStateJson(
        getRecordField(loadStatement.get([legacyWorkflowStateKey(input)]), ["state_json", "stateJson"])
      );
      if (legacy && matchesWorkflowStateLookup(legacy, input)) {
        deleteStatement.run([legacyWorkflowStateKey(input)]);
      }
    }
  };
};
