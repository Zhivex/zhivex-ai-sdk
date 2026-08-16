import assert from "node:assert/strict";

import {
  WORKFLOW_RUN_STATE_SCHEMA_VERSION,
  createPostgresWorkflowStateService
} from "@zhivex-ai/sdk";
import { ConflictError } from "@zhivex-ai/core";
import postgres from "postgres";

const postgresUrl = process.env.ZHIVEX_POSTGRES_INTEGRATION_URL;
if (!postgresUrl) {
  throw new Error("ZHIVEX_POSTGRES_INTEGRATION_URL is required.");
}

const createClient = () => {
  const sql = postgres(postgresUrl, { max: 4, onnotice: () => {} });
  return {
    async query(text, params = []) {
      const rows = await sql.unsafe(text, [...params]);
      return { rows };
    },
    async close() {
      await sql.end({ timeout: 1 });
    }
  };
};

const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const tableName = `zhivex_it_workflow_package_${suffix}`;
const appName = "installed-workflow-certification";
const sessionId = "shared-session";
const workflowKey = "durable-workflow";

const createState = (userId, output) => {
  const now = Date.now();
  return {
    schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION,
    workflowId: "installed-postgres-workflow",
    runId: `wfr_installed_${userId}`,
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
  const firstClient = createClient();
  try {
    const states = createPostgresWorkflowStateService({ client: firstClient, tableName });
    for (const tenant of ["tenant-a", "tenant-b"]) {
      const saved = await states.saveWorkflowState({
        appName,
        userId: tenant,
        sessionId,
        workflowKey,
        state: createState(tenant, tenant)
      });
      assert.equal(saved.revision, 1);
    }
  } finally {
    await firstClient.close();
  }

  const restartedClient = createClient();
  try {
    const states = createPostgresWorkflowStateService({ client: restartedClient, tableName });
    const lookupA = { appName, userId: "tenant-a", sessionId, workflowKey };
    const lookupB = { appName, userId: "tenant-b", sessionId, workflowKey };
    const tenantA = await states.loadWorkflowState(lookupA);
    const tenantB = await states.loadWorkflowState(lookupB);
    assert.equal(tenantA?.state.outputs.result, "tenant-a");
    assert.equal(tenantB?.state.outputs.result, "tenant-b");
    assert.deepEqual((await states.listWorkflowStates({ appName, userId: "tenant-a" })).map((record) => record.userId), ["tenant-a"]);
    assert.deepEqual((await states.listWorkflowStates({ appName, userId: "tenant-b" })).map((record) => record.userId), ["tenant-b"]);

    const updated = await states.saveWorkflowState({
      ...lookupA,
      state: createState("tenant-a", "updated"),
      expectedRevision: tenantA?.revision
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.state.outputs.result, "updated");
    await assert.rejects(
      states.saveWorkflowState({
        ...lookupA,
        state: createState("tenant-a", "stale"),
        expectedRevision: tenantA?.revision
      }),
      ConflictError
    );
  } finally {
    await restartedClient.close();
  }

  console.log("INSTALLED_WORKFLOW_POSTGRES_SMOKE_OK");
} finally {
  const cleanupClient = createClient();
  try {
    if (!/^zhivex_it_[a-z0-9_]+$/.test(tableName)) {
      throw new Error(`Refusing to drop unexpected integration table ${tableName}.`);
    }
    await cleanupClient.query(`DROP TABLE IF EXISTS ${tableName}`);
  } finally {
    await cleanupClient.close();
  }
}
