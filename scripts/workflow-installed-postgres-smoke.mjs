import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ARTIFACT_SCHEMA_VERSION,
  WORKFLOW_RUN_STATE_SCHEMA_VERSION,
  createPostgresArtifactService,
  verifyArtifactIntegrity,
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
const workflowTableName = `zhivex_it_workflow_package_${suffix}`;
const artifactTableName = `zhivex_it_artifact_package_${suffix}`;
const tableNames = [artifactTableName, workflowTableName];
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
    const states = createPostgresWorkflowStateService({ client: firstClient, tableName: workflowTableName });
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

    const artifacts = createPostgresArtifactService({ client: firstClient, tableName: artifactTableName });
    const binaryData = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const binarySha256 = createHash("sha256").update(binaryData).digest("hex");
    const binary = await artifacts.saveBinaryArtifact({
      appName,
      userId: "tenant-a",
      sessionId,
      id: "installed-binary",
      name: "installed.bin",
      contentType: "application/octet-stream",
      data: binaryData,
      sha256: binarySha256,
      expectedRevision: 0
    });
    assert.equal(binary.schemaVersion, ARTIFACT_SCHEMA_VERSION);
    assert.equal(binary.storageMode, "json");
    assert.equal(binary.encoding, "base64");
    assert.equal(binary.size, binaryData.byteLength);
    assert.equal(binary.sha256, binarySha256);
    assert.equal(binary.data, Buffer.from(binaryData).toString("base64"));

    await artifacts.saveArtifact({
      appName,
      userId: "tenant-a",
      sessionId,
      id: "shared-artifact",
      name: "tenant.json",
      contentType: "application/json",
      data: { tenant: "tenant-a" },
      expectedRevision: 0
    });
    await artifacts.saveArtifact({
      appName,
      userId: "tenant-b",
      sessionId,
      id: "shared-artifact",
      name: "tenant.json",
      contentType: "application/json",
      data: { tenant: "tenant-b" },
      expectedRevision: 0
    });
  } finally {
    await firstClient.close();
  }

  const restartedClient = createClient();
  try {
    const states = createPostgresWorkflowStateService({ client: restartedClient, tableName: workflowTableName });
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

    const artifacts = createPostgresArtifactService({ client: restartedClient, tableName: artifactTableName });
    const binaryLookup = {
      appName,
      userId: "tenant-a",
      sessionId,
      id: "installed-binary"
    };
    const binary = await artifacts.loadBinaryArtifact(binaryLookup);
    assert.ok(binary);
    assert.deepEqual(binary.data, new Uint8Array([0, 1, 2, 253, 254, 255]));
    assert.equal((await verifyArtifactIntegrity(artifacts, binaryLookup)).ok, true);

    const artifactLookupA = { appName, userId: "tenant-a", sessionId, id: "shared-artifact" };
    const artifactLookupB = { appName, userId: "tenant-b", sessionId, id: "shared-artifact" };
    const artifactA = await artifacts.loadArtifact(artifactLookupA);
    const artifactB = await artifacts.loadArtifact(artifactLookupB);
    assert.deepEqual(artifactA?.data, { tenant: "tenant-a" });
    assert.deepEqual(artifactB?.data, { tenant: "tenant-b" });
    assert.deepEqual(
      (await artifacts.listArtifacts({ appName, userId: "tenant-a", sessionId })).map((artifact) => artifact.id).sort(),
      ["installed-binary", "shared-artifact"]
    );
    assert.deepEqual(
      (await artifacts.listArtifacts({ appName, userId: "tenant-b", sessionId })).map((artifact) => artifact.id),
      ["shared-artifact"]
    );

    const updatedArtifact = await artifacts.saveArtifact({
      ...artifactLookupA,
      name: "tenant.json",
      contentType: "application/json",
      data: { tenant: "tenant-a", revision: 2 },
      expectedRevision: artifactA?.revision
    });
    assert.equal(updatedArtifact.revision, 2);
    await assert.rejects(
      artifacts.saveArtifact({
        ...artifactLookupA,
        name: "tenant.json",
        contentType: "application/json",
        data: { tenant: "tenant-a", stale: true },
        expectedRevision: artifactA?.revision
      }),
      ConflictError
    );

    const createOnlyLookup = { appName, userId: "tenant-a", sessionId, id: "create-only-cas" };
    const createOnlyResults = await Promise.allSettled([
      artifacts.saveArtifact({
        ...createOnlyLookup,
        name: "create-only.json",
        contentType: "application/json",
        data: { writer: "first" },
        expectedRevision: 0
      }),
      artifacts.saveArtifact({
        ...createOnlyLookup,
        name: "create-only.json",
        contentType: "application/json",
        data: { writer: "second" },
        expectedRevision: 0
      })
    ]);
    assert.equal(createOnlyResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.ok(createOnlyResults.some((result) => result.status === "rejected" && result.reason instanceof ConflictError));

    await artifacts.deleteArtifact(artifactLookupB);
    assert.equal(await artifacts.loadArtifact(artifactLookupB), undefined);
    assert.deepEqual((await artifacts.listArtifacts({ appName, userId: "tenant-b", sessionId })), []);
  } finally {
    await restartedClient.close();
  }

  console.log("INSTALLED_WORKFLOW_POSTGRES_SMOKE_OK");
} finally {
  const cleanupClient = createClient();
  try {
    for (const tableName of tableNames) {
      if (!/^zhivex_it_[a-z0-9_]+$/.test(tableName)) {
        throw new Error(`Refusing to drop unexpected integration table ${tableName}.`);
      }
      await cleanupClient.query(`DROP TABLE IF EXISTS ${tableName}`);
    }
  } finally {
    await cleanupClient.close();
  }
}
