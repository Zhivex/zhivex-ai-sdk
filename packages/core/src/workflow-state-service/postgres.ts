import { ConflictError } from "../errors.js";
import { assertPostgresClient } from "../postgres-client.js";
import type { PostgresClientLike } from "../types.js";
import { type WorkflowStateRecord, type WorkflowStateService } from "../workflow-state-contracts.js";
import {
  type PostgresWorkflowStateServiceOptions,
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
    for (const key of [workflowStateKey(input), legacyWorkflowStateKey(input)]) {
      const result = await options.client.query<{ state_json?: WorkflowStateRecord; stateJson?: WorkflowStateRecord }>(
        `SELECT state_json FROM ${tableName} WHERE workflow_state_key = $1`,
        [key]
      );
      const record = parseWorkflowStateJson(getRecordField(result.rows[0], ["state_json", "stateJson"]));
      if (record && matchesWorkflowStateLookup(record, input)) {
        return record;
      }
    }
    return undefined;
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
        const migrated = await options.client.query(
          `UPDATE ${tableName}
           SET workflow_state_key = $1,
               app_name = $2,
               user_id = $3,
               session_id = $4,
               workflow_key = $5,
               run_id = $6,
               status = $7,
               state_json = $8::jsonb,
               updated_at_ms = $9
           WHERE workflow_state_key = $10
             AND updated_at_ms = $11
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
            legacyWorkflowStateKey(record),
            saveOptions.existing.updatedAt
          ]
        );
        if (migrated.rows.length === 0) {
          throw new ConflictError("WorkflowStateRecord revision conflict.");
        }
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
    const legacyResult = await options.client.query<{ state_json?: WorkflowStateRecord; stateJson?: WorkflowStateRecord }>(
      `SELECT state_json FROM ${tableName} WHERE workflow_state_key = $1`,
      [legacyWorkflowStateKey(record)]
    );
    const legacy = parseWorkflowStateJson(getRecordField(legacyResult.rows[0], ["state_json", "stateJson"]));
    if (legacy && matchesWorkflowStateLookup(legacy, record)) {
      await options.client.query(
        `DELETE FROM ${tableName} WHERE workflow_state_key = $1`,
        [legacyWorkflowStateKey(record)]
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
      const records = new Map<string, WorkflowStateRecord>();
      for (const row of result.rows) {
        const record = parseWorkflowStateJson(getRecordField(row, ["state_json", "stateJson"]));
        if (record) {
          records.set(workflowStateKey(record), record);
        }
      }
      return [...records.values()];
    },
    async deleteWorkflowState(input) {
      await ensurePostgresTable(options.client, tableName, createSql);
      await options.client.query(`DELETE FROM ${tableName} WHERE workflow_state_key = $1`, [workflowStateKey(input)]);
      const legacyResult = await options.client.query<{ state_json?: WorkflowStateRecord; stateJson?: WorkflowStateRecord }>(
        `SELECT state_json FROM ${tableName} WHERE workflow_state_key = $1`,
        [legacyWorkflowStateKey(input)]
      );
      const legacy = parseWorkflowStateJson(getRecordField(legacyResult.rows[0], ["state_json", "stateJson"]));
      if (legacy && matchesWorkflowStateLookup(legacy, input)) {
        await options.client.query(
          `DELETE FROM ${tableName} WHERE workflow_state_key = $1`,
          [legacyWorkflowStateKey(input)]
        );
      }
    }
  };
};
