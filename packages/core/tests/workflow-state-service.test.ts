import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFileWorkflowStateService,
  ConflictError,
  createInMemoryWorkflowStateService,
  createPostgresWorkflowStateService,
  createSqliteWorkflowStateService,
  migrateWorkflowStateRecord,
  normalizeWorkflowStateRecord,
  pruneFileWorkflowStateStore,
  ValidationError,
  WORKFLOW_RUN_STATE_SCHEMA_VERSION,
  WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
  type WorkflowStateRecord
} from "../src/index.js";

const state = {
  workflowId: "workflow",
  runId: "wfr_1",
  userId: "user",
  sessionId: "session",
  status: "completed" as const,
  outputs: { answer: "ok" },
  steps: [],
  currentStepIndex: 1,
  createdAt: 1,
  updatedAt: 2
};

class FakeSqliteWorkflowStateStatement<TResult extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private readonly db: FakeSqliteWorkflowStateDatabase,
    private readonly sql: string
  ) {}

  get(params: unknown[]): TResult | undefined {
    const record = this.db.states.get(params[0] as string);
    return record ? ({ state_json: JSON.stringify(record) } as TResult) : undefined;
  }

  all(params: unknown[]): TResult[] {
    const [appName, userId, sessionId, _sessionIdAgain, workflowKey, _workflowKeyAgain, status] = params as Array<string | null>;
    return [...this.db.states.values()]
      .filter((record) =>
        record.appName === appName &&
        record.userId === userId &&
        (sessionId === null || record.sessionId === sessionId) &&
        (workflowKey === null || record.workflowKey === workflowKey) &&
        (status === null || record.status === status)
      )
      .map((record) => ({ state_json: JSON.stringify(record) } as TResult));
  }

  run(params: unknown[]) {
    if (this.sql.includes("INSERT INTO")) {
      const [key, _appName, _userId, _sessionId, _workflowKey, _runId, _status, stateJson] = params as string[];
      this.db.states.set(key, JSON.parse(stateJson) as WorkflowStateRecord);
      return { changes: 1 };
    }
    if (this.sql.includes("UPDATE")) {
      const [
        _appName,
        _userId,
        _sessionId,
        _workflowKey,
        _runId,
        _status,
        stateJson,
        _updatedAt,
        key,
        expectedUpdatedAt
      ] = params as [string, string, string, string, string, string, string, number, string, number];
      const existing = this.db.states.get(key);
      if (this.db.mutateBeforeCas && existing) {
        this.db.states.set(key, { ...existing, updatedAt: existing.updatedAt + 1 });
        this.db.mutateBeforeCas = false;
      }
      const current = this.db.states.get(key);
      if (!current || current.updatedAt !== expectedUpdatedAt) {
        return { changes: 0 };
      }
      this.db.states.set(key, JSON.parse(stateJson) as WorkflowStateRecord);
      return { changes: 1 };
    }
    if (this.sql.includes("DELETE FROM")) {
      this.db.states.delete(params[0] as string);
    }
  }
}

class FakeSqliteWorkflowStateDatabase {
  states = new Map<string, WorkflowStateRecord>();
  execCalls: string[] = [];
  mutateBeforeCas = false;
  exec(sql: string) {
    this.execCalls.push(sql);
  }
  prepare<TResult extends Record<string, unknown>>(sql: string) {
    return new FakeSqliteWorkflowStateStatement<TResult>(this, sql);
  }
}

class FakePostgresWorkflowStateClient {
  states = new Map<string, WorkflowStateRecord>();
  queries: Array<{ sql: string; params: unknown[] }> = [];
  mutateBeforeCas = false;

  async query<TResult extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: TResult[] }> {
    this.queries.push({ sql, params });
    if (sql.includes("SELECT state_json") && sql.includes("WHERE workflow_state_key")) {
      const record = this.states.get(params[0] as string);
      return { rows: record ? ([{ state_json: record }] as TResult[]) : [] };
    }
    if (sql.includes("SELECT state_json")) {
      const [appName, userId, sessionId, workflowKey, status] = params as Array<string | null>;
      return {
        rows: [...this.states.values()]
          .filter((record) =>
            record.appName === appName &&
            record.userId === userId &&
            (sessionId === null || record.sessionId === sessionId) &&
            (workflowKey === null || record.workflowKey === workflowKey) &&
            (status === null || record.status === status)
          )
          .map((record) => ({ state_json: record } as TResult))
      };
    }
    if (sql.includes("INSERT INTO")) {
      const [key, _appName, _userId, _sessionId, _workflowKey, _runId, _status, stateJson] = params as string[];
      this.states.set(key, JSON.parse(stateJson) as WorkflowStateRecord);
    }
    if (sql.includes("UPDATE")) {
      const [key, _appName, _userId, _sessionId, _workflowKey, _runId, _status, stateJson, _updatedAt, expectedUpdatedAt] =
        params as [string, string, string, string, string, string, string, string, number, number];
      const existing = this.states.get(key);
      if (this.mutateBeforeCas && existing) {
        this.states.set(key, { ...existing, updatedAt: existing.updatedAt + 1 });
        this.mutateBeforeCas = false;
      }
      const current = this.states.get(key);
      if (!current || current.updatedAt !== expectedUpdatedAt) {
        return { rows: [] };
      }
      const record = JSON.parse(stateJson) as WorkflowStateRecord;
      this.states.set(key, record);
      return { rows: [{ state_json: record }] as TResult[] };
    }
    if (sql.includes("DELETE FROM")) {
      this.states.delete(params[0] as string);
    }
    return { rows: [] };
  }
}

describe("workflow state services", () => {
  it("saves loads lists and deletes in-memory workflow states", async () => {
    const service = createInMemoryWorkflowStateService();
    const record = await service.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state
    });

    expect(await service.loadWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow"
    })).toEqual(record);
    expect(record.schemaVersion).toBe(WORKFLOW_STATE_RECORD_SCHEMA_VERSION);
    expect(record.state.schemaVersion).toBe(WORKFLOW_RUN_STATE_SCHEMA_VERSION);
    expect(record.revision).toBe(1);
    expect(await service.listWorkflowStates({ appName: "app", userId: "user", sessionId: "session" })).toEqual([record]);

    await service.deleteWorkflowState({ appName: "app", userId: "user", sessionId: "session", workflowKey: "workflow" });
    expect(await service.listWorkflowStates({ appName: "app", userId: "user" })).toEqual([]);
  });

  it("persists file workflow states across service instances", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-workflow-states-"));
    const service = createFileWorkflowStateService({ directory });
    const record = await service.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state
    });

    const reloaded = createFileWorkflowStateService({ directory });
    await expect(reloaded.loadWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow"
    })).resolves.toEqual(record);
  });

  it("normalizes legacy file workflow states and rejects future schema versions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-workflow-states-"));
    const service = createFileWorkflowStateService({ directory });
    await service.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state
    });
    const filePath = path.join(directory, (await fs.readdir(directory))[0]!);
    const legacy = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    delete legacy.schemaVersion;
    if (legacy.state && typeof legacy.state === "object") {
      delete (legacy.state as Record<string, unknown>).schemaVersion;
    }
    await fs.writeFile(filePath, JSON.stringify(legacy), "utf8");

    await expect(service.loadWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow"
    })).resolves.toMatchObject({
      schemaVersion: WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
      state: { schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION }
    });

    await fs.writeFile(filePath, JSON.stringify({ ...legacy, schemaVersion: 999 }), "utf8");
    await expect(service.loadWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow"
    })).rejects.toThrow(ValidationError);
  });

  it("saves loads and lists SQLite workflow states", async () => {
    const service = createSqliteWorkflowStateService({ db: new FakeSqliteWorkflowStateDatabase() });
    const record = await service.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state
    });

    expect(await service.loadWorkflowState({ appName: "app", userId: "user", sessionId: "session", workflowKey: "workflow" })).toEqual(record);
    expect(await service.listWorkflowStates({ appName: "app", userId: "user", status: "completed" })).toEqual([record]);
  });

  it("detects optimistic concurrency conflicts for workflow states", async () => {
    const service = createInMemoryWorkflowStateService();
    const record = await service.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state
    });

    const updated = await service.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state: { ...state, updatedAt: 3 },
      expectedRevision: record.revision
    });

    expect(updated.revision).toBe(2);
    expect(() =>
      service.saveWorkflowState({
        appName: "app",
        userId: "user",
        sessionId: "session",
        workflowKey: "workflow",
        state,
        expectedRevision: record.revision
      })
    ).toThrow(ConflictError);
  });

  it("uses SQL compare-and-swap for workflow state expected revisions", async () => {
    const sqliteDb = new FakeSqliteWorkflowStateDatabase();
    const sqlite = createSqliteWorkflowStateService({ db: sqliteDb });
    const sqliteRecord = await sqlite.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "sqlite-cas",
      state
    });
    sqliteDb.mutateBeforeCas = true;
    expect(() =>
      sqlite.saveWorkflowState({
        appName: "app",
        userId: "user",
        sessionId: "session",
        workflowKey: "sqlite-cas",
        state: { ...state, updatedAt: 3 },
        expectedRevision: sqliteRecord.revision
      })
    ).toThrow(ConflictError);

    const postgresClient = new FakePostgresWorkflowStateClient();
    const postgres = createPostgresWorkflowStateService({ client: postgresClient });
    const postgresRecord = await postgres.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "postgres-cas",
      state
    });
    postgresClient.mutateBeforeCas = true;
    await expect(postgres.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "postgres-cas",
      state: { ...state, updatedAt: 3 },
      expectedRevision: postgresRecord.revision
    })).rejects.toThrow(ConflictError);
  });

  it("saves loads and lists Postgres workflow states", async () => {
    const client = new FakePostgresWorkflowStateClient();
    const service = createPostgresWorkflowStateService({ client });
    const record = await service.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state
    });

    await expect(service.loadWorkflowState({ appName: "app", userId: "user", sessionId: "session", workflowKey: "workflow" })).resolves.toEqual(record);
    await expect(service.listWorkflowStates({ appName: "app", userId: "user", sessionId: "session" })).resolves.toEqual([record]);
    expect(client.queries.filter((query) => query.sql.includes("CREATE TABLE IF NOT EXISTS")).length).toBe(1);
  });

  it("rejects invalid SQL workflow state table names and exports APIs", async () => {
    expect(() => createSqliteWorkflowStateService({ db: new FakeSqliteWorkflowStateDatabase(), tableName: "bad-name" })).toThrow(ValidationError);
    expect(() => createPostgresWorkflowStateService({ client: new FakePostgresWorkflowStateClient(), tableName: "bad-name" })).toThrow(ValidationError);

    const api = await import("../src/index.js");
    expect(api.createFileWorkflowStateService).toBeTypeOf("function");
    expect(api.createInMemoryWorkflowStateService).toBeTypeOf("function");
    expect(api.createPostgresWorkflowStateService).toBeTypeOf("function");
    expect(api.createSqliteWorkflowStateService).toBeTypeOf("function");
    expect(api.normalizeWorkflowStateRecord).toBeTypeOf("function");
  });

  it("normalizes workflow state records directly", () => {
    const normalized = normalizeWorkflowStateRecord({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state,
      status: "completed",
      runId: "wfr_1",
      createdAt: 1,
      updatedAt: 2
    });

    expect(normalized.schemaVersion).toBe(WORKFLOW_STATE_RECORD_SCHEMA_VERSION);
    expect(normalized.revision).toBe(1);
    expect(() => normalizeWorkflowStateRecord({ ...normalized, schemaVersion: 999 })).toThrow(ValidationError);
    expect(migrateWorkflowStateRecord(normalized)).toMatchObject({ schemaVersion: WORKFLOW_STATE_RECORD_SCHEMA_VERSION });
    expect(() => migrateWorkflowStateRecord(normalized, 999 as 1)).toThrow(ValidationError);
  });

  it("prunes file-backed workflow states by retention policy", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-workflow-state-prune-"));
    const fileName = (...parts: string[]) => `${parts.map((part) => encodeURIComponent(part)).join("__")}.json`;
    await fs.writeFile(path.join(directory, fileName("app", "user", "session", "old")), JSON.stringify(normalizeWorkflowStateRecord({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "old",
      state: { ...state, runId: "old", updatedAt: 10 },
      status: "completed",
      runId: "old",
      createdAt: 1,
      updatedAt: 10
    })), "utf8");
    await fs.writeFile(path.join(directory, fileName("app", "user", "session", "new")), JSON.stringify(normalizeWorkflowStateRecord({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "new",
      state: { ...state, runId: "new", updatedAt: 100 },
      status: "completed",
      runId: "new",
      createdAt: 1,
      updatedAt: 100
    })), "utf8");

    await expect(pruneFileWorkflowStateStore({ directory, keepLast: 1, dryRun: false })).resolves.toMatchObject({
      deletedWorkflowStateKeys: ["app:user:session:old"],
      keptWorkflowStateKeys: ["app:user:session:new"]
    });
  });
});
