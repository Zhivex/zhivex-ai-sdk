import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  ConflictError,
  WORKFLOW_RUN_STATE_SCHEMA_VERSION,
  createSqliteWorkflowStateService,
  type PersistedWorkflowRunState
} from "../packages/core/src/index.ts";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "zhivex-workflow-sqlite-"));
const databasePath = join(temporaryDirectory, "workflow-state.sqlite");
const appName = "sqlite-certification";
const sessionId = "shared-session";
const workflowKey = "durable-workflow";

const createState = (userId: string, output: string): PersistedWorkflowRunState => {
  const now = Date.now();
  return {
    schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION,
    workflowId: "sqlite-certified-workflow",
    runId: `wfr_sqlite_${userId}`,
    userId,
    sessionId,
    status: "completed",
    outputs: { result: output },
    steps: [],
    currentStepIndex: 0,
    createdAt: now,
    updatedAt: now
  };
};

try {
  const firstDatabase = new Database(databasePath, { create: true });
  try {
    const states = createSqliteWorkflowStateService({ db: firstDatabase });
    for (const tenant of ["tenant-a", "tenant-b"] as const) {
      const saved = await states.saveWorkflowState({
        appName,
        userId: tenant,
        sessionId,
        workflowKey,
        state: createState(tenant, tenant)
      });
      assert.equal(saved.revision, 1);
      assert.equal(saved.userId, tenant);
    }
  } finally {
    firstDatabase.close();
  }

  const restartedDatabase = new Database(databasePath);
  try {
    const states = createSqliteWorkflowStateService({ db: restartedDatabase });
    const tenantA = await states.loadWorkflowState({ appName, userId: "tenant-a", sessionId, workflowKey });
    const tenantB = await states.loadWorkflowState({ appName, userId: "tenant-b", sessionId, workflowKey });

    assert.equal(tenantA?.state.outputs.result, "tenant-a");
    assert.equal(tenantB?.state.outputs.result, "tenant-b");
    assert.deepEqual(
      (await states.listWorkflowStates({ appName, userId: "tenant-a", sessionId })).map((record) => record.userId),
      ["tenant-a"]
    );
    assert.deepEqual(
      (await states.listWorkflowStates({ appName, userId: "tenant-b", sessionId })).map((record) => record.userId),
      ["tenant-b"]
    );

    const updated = await states.saveWorkflowState({
      appName,
      userId: "tenant-a",
      sessionId,
      workflowKey,
      state: createState("tenant-a", "updated"),
      expectedRevision: tenantA?.revision
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.state.outputs.result, "updated");

    await assert.rejects(
      async () => states.saveWorkflowState({
        appName,
        userId: "tenant-a",
        sessionId,
        workflowKey,
        state: createState("tenant-a", "stale"),
        expectedRevision: tenantA?.revision
      }),
      ConflictError
    );
  } finally {
    restartedDatabase.close();
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("WORKFLOW_SQLITE_CERTIFICATION_OK");
