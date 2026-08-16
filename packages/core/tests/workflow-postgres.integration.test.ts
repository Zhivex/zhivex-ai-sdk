import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ARTIFACT_SCHEMA_VERSION,
  ConflictError,
  WORKFLOW_RUN_STATE_SCHEMA_VERSION,
  createAgent,
  createPostgresArtifactService,
  createPostgresSessionService,
  createPostgresWorkflowStateService,
  createRunner,
  createTextMessage,
  createWorkflow,
  runWorkflow,
  type LanguageModel,
  type PersistedWorkflowRunState,
  type StreamEvent
} from "../src/index.js";
import {
  createPostgresIntegrationClient,
  dropIntegrationTables,
  integrationTableName,
  type PostgresIntegrationClient
} from "./postgres-integration-client.js";

const postgresUrl = process.env.ZHIVEX_POSTGRES_INTEGRATION_URL;
const postgresCertificationRequired = process.env.ZHIVEX_WORKFLOW_POSTGRES_CERTIFICATION === "1";

if (postgresCertificationRequired && !postgresUrl) {
  throw new Error(
    "ZHIVEX_POSTGRES_INTEGRATION_URL is required when ZHIVEX_WORKFLOW_POSTGRES_CERTIFICATION=1."
  );
}

const describePostgres = postgresUrl ? describe.sequential : describe.skip;

const sessionTable = integrationTableName("workflow_sessions");
const workflowTable = integrationTableName("workflow_states");
const artifactTable = integrationTableName("workflow_artifacts");
const tables = [artifactTable, workflowTable, sessionTable];

const createApprovalModel = (): LanguageModel => ({
  provider: "postgres-certification",
  modelId: "approval-restart-model",
  capabilities: {
    streaming: true,
    tools: true,
    structuredOutput: true,
    jsonMode: true,
    toolChoice: true,
    parallelToolCalls: false,
    vision: false,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false
  },
  async generate(input) {
    const approved = input.messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "provider-data" &&
          part.provider === "openai" &&
          (part.data as { type?: string }).type === "mcp_approval_response"
      )
    );
    if (approved) {
      return {
        messages: [createTextMessage("assistant", "postgres-resume-ok")],
        text: "postgres-resume-ok",
        finishReason: "stop"
      };
    }
    return {
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "provider-data",
              provider: "openai",
              data: {
                type: "mcp_approval_request",
                id: "postgres_restart_approval",
                arguments: "{}",
                name: "certified_side_effect"
              }
            }
          ]
        }
      ],
      text: "approval required",
      finishReason: "stop"
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "postgres-resume-ok" };
      yield { type: "finish", finishReason: "stop" };
    })();
  }
});

const createPersistedState = (
  id: string,
  output: string,
  status: PersistedWorkflowRunState["status"] = "running"
): PersistedWorkflowRunState => {
  const now = Date.now();
  return {
    schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION,
    workflowId: "postgres-cas-workflow",
    runId: `wfr_${id}`,
    userId: "postgres-cas-user",
    sessionId: `postgres-cas-session-${id}`,
    status,
    outputs: { result: output },
    steps: [],
    currentStepIndex: 0,
    createdAt: now,
    updatedAt: now
  };
};

describePostgres("workflow and artifact Postgres integration", () => {
  let cleanupClient: PostgresIntegrationClient;

  beforeAll(async () => {
    cleanupClient = createPostgresIntegrationClient(postgresUrl!);
    const ping = await cleanupClient.query<{ value: number }>("SELECT 1 AS value");
    expect(Number(ping.rows[0]?.value)).toBe(1);
  });

  afterAll(async () => {
    if (!cleanupClient) {
      return;
    }
    await dropIntegrationTables(cleanupClient, tables);
    await cleanupClient.close();
  });

  it("resumes an approval workflow after recreating every Postgres-backed service", async () => {
    const appName = "postgres-workflow-certification";
    const userId = "postgres-restart-user";
    const sessionId = `postgres-restart-session-${Date.now()}`;
    const workflowKey = "approval-restart";
    const firstClient = createPostgresIntegrationClient(postgresUrl!);

    const createDurableWorkflow = (client: PostgresIntegrationClient) => {
      const sessionService = createPostgresSessionService({ client, tableName: sessionTable });
      const workflowStateService = createPostgresWorkflowStateService({ client, tableName: workflowTable });
      const runner = createRunner({
        appName,
        agent: createAgent({ model: createApprovalModel(), maxSteps: 3 }),
        sessionService
      });
      return {
        sessionService,
        workflowStateService,
        workflow: createWorkflow({
          id: "postgres-approval-restart",
          persistence: {
            appName,
            sessionService,
            workflowStateService,
            workflowKey
          },
          steps: [
            {
              id: "approval-step",
              runner,
              prompt: "Request the certified side effect.",
              outputKey: "result"
            }
          ]
        })
      };
    };

    try {
      const firstRuntime = createDurableWorkflow(firstClient);
      const waiting = await runWorkflow(firstRuntime.workflow, { userId, sessionId });
      expect(waiting.status).toBe("waiting_approval");
      expect(waiting.state.session).toMatchObject({ appName, userId, sessionId });

      const persistedWaiting = await firstRuntime.workflowStateService.loadWorkflowState({
        appName,
        userId,
        sessionId,
        workflowKey
      });
      expect(persistedWaiting).toMatchObject({ status: "waiting_approval", revision: 1 });
    } finally {
      await firstClient.close();
    }

    const secondClient = createPostgresIntegrationClient(postgresUrl!);
    let completedRunId = "";
    try {
      const secondRuntime = createDurableWorkflow(secondClient);
      const resumed = await runWorkflow(secondRuntime.workflow, {
        userId,
        sessionId,
        resumeFromPersistedState: true,
        approvals: [
          {
            provider: "openai",
            approvalRequestId: "postgres_restart_approval",
            approve: true
          }
        ]
      });

      expect(resumed.status, JSON.stringify(resumed.steps)).toBe("completed");
      expect(resumed.outputs.result).toBe("postgres-resume-ok");
      completedRunId = resumed.state.runId;

      const artifacts = createPostgresArtifactService({ client: secondClient, tableName: artifactTable });
      const saved = await artifacts.saveArtifact({
        appName,
        userId,
        sessionId,
        id: "workflow-result",
        workflowRunId: completedRunId,
        workflowStepId: "approval-step",
        name: "result.json",
        contentType: "application/json",
        data: { result: resumed.outputs.result }
      });
      expect(saved).toMatchObject({ schemaVersion: ARTIFACT_SCHEMA_VERSION, revision: 1 });
    } finally {
      await secondClient.close();
    }

    const verificationClient = createPostgresIntegrationClient(postgresUrl!);
    try {
      const workflowStates = createPostgresWorkflowStateService({
        client: verificationClient,
        tableName: workflowTable
      });
      const artifacts = createPostgresArtifactService({ client: verificationClient, tableName: artifactTable });
      const persistedCompleted = await workflowStates.loadWorkflowState({
        appName,
        userId,
        sessionId,
        workflowKey
      });
      const artifact = await artifacts.loadArtifact({ appName, userId, sessionId, id: "workflow-result" });

      expect(persistedCompleted).toMatchObject({ status: "completed", revision: 2, runId: completedRunId });
      expect(artifact).toMatchObject({
        workflowRunId: completedRunId,
        workflowStepId: "approval-step",
        data: { result: "postgres-resume-ok" }
      });
    } finally {
      await verificationClient.close();
    }
  });

  it("enforces real Postgres compare-and-swap for workflow state and artifacts", async () => {
    const firstClient = createPostgresIntegrationClient(postgresUrl!);
    const secondClient = createPostgresIntegrationClient(postgresUrl!);
    try {
      const workflowA = createPostgresWorkflowStateService({ client: firstClient, tableName: workflowTable });
      const workflowB = createPostgresWorkflowStateService({ client: secondClient, tableName: workflowTable });
      const stateId = `${Date.now()}`;
      const lookup = {
        appName: "postgres-cas",
        userId: "postgres-cas-user",
        sessionId: `postgres-cas-session-${stateId}`,
        workflowKey: "cas"
      };
      const initial = await workflowA.saveWorkflowState({
        ...lookup,
        state: createPersistedState(stateId, "initial")
      });
      expect(initial.revision).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const workflowResults = await Promise.allSettled([
        workflowA.saveWorkflowState({
          ...lookup,
          state: createPersistedState(stateId, "first"),
          expectedRevision: initial.revision
        }),
        workflowB.saveWorkflowState({
          ...lookup,
          state: createPersistedState(stateId, "second"),
          expectedRevision: initial.revision
        })
      ]);
      expect(workflowResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const workflowRejected = workflowResults.find((result) => result.status === "rejected");
      expect(workflowRejected).toMatchObject({ reason: expect.any(ConflictError) });
      expect((await workflowA.loadWorkflowState(lookup))?.revision).toBe(2);

      const artifactsA = createPostgresArtifactService({ client: firstClient, tableName: artifactTable });
      const artifactsB = createPostgresArtifactService({ client: secondClient, tableName: artifactTable });
      const artifactLookup = {
        appName: "postgres-cas",
        userId: "postgres-cas-user",
        sessionId: `postgres-cas-artifact-session-${stateId}`,
        id: "cas-artifact"
      };
      const initialArtifact = await artifactsA.saveArtifact({
        ...artifactLookup,
        name: "cas.json",
        contentType: "application/json",
        data: { writer: "initial" }
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const artifactResults = await Promise.allSettled([
        artifactsA.saveArtifact({
          ...artifactLookup,
          name: "cas.json",
          contentType: "application/json",
          data: { writer: "first" },
          expectedRevision: initialArtifact.revision
        }),
        artifactsB.saveArtifact({
          ...artifactLookup,
          name: "cas.json",
          contentType: "application/json",
          data: { writer: "second" },
          expectedRevision: initialArtifact.revision
        })
      ]);
      expect(artifactResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const artifactRejected = artifactResults.find((result) => result.status === "rejected");
      expect(artifactRejected).toMatchObject({ reason: expect.any(ConflictError) });
      expect((await artifactsA.loadArtifact(artifactLookup))?.revision).toBe(2);
    } finally {
      await Promise.all([firstClient.close(), secondClient.close()]);
    }
  });

  it("keeps workflow state durable and isolated across Postgres tenant scopes", async () => {
    const appName = "postgres-workflow-tenancy";
    const sessionId = `shared-session-${Date.now()}`;
    const workflowKey = "shared-workflow";
    const firstClient = createPostgresIntegrationClient(postgresUrl!);

    try {
      const states = createPostgresWorkflowStateService({ client: firstClient, tableName: workflowTable });
      for (const tenant of ["tenant-a", "tenant-b"] as const) {
        const state = createPersistedState(`${tenant}-${Date.now()}`, tenant, "completed");
        state.userId = tenant;
        state.sessionId = sessionId;
        await expect(states.saveWorkflowState({
          appName,
          userId: tenant,
          sessionId,
          workflowKey,
          state
        })).resolves.toMatchObject({ revision: 1, userId: tenant, state: { outputs: { result: tenant } } });
      }
    } finally {
      await firstClient.close();
    }

    const restartedClient = createPostgresIntegrationClient(postgresUrl!);
    try {
      const states = createPostgresWorkflowStateService({ client: restartedClient, tableName: workflowTable });
      const tenantA = await states.loadWorkflowState({
        appName,
        userId: "tenant-a",
        sessionId,
        workflowKey
      });
      const tenantB = await states.loadWorkflowState({
        appName,
        userId: "tenant-b",
        sessionId,
        workflowKey
      });
      const tenantAList = await states.listWorkflowStates({ appName, userId: "tenant-a", sessionId });
      const tenantBList = await states.listWorkflowStates({ appName, userId: "tenant-b", sessionId });

      expect(tenantA).toMatchObject({ userId: "tenant-a", state: { outputs: { result: "tenant-a" } } });
      expect(tenantB).toMatchObject({ userId: "tenant-b", state: { outputs: { result: "tenant-b" } } });
      expect(tenantAList).toHaveLength(1);
      expect(tenantAList[0]).toEqual(tenantA);
      expect(tenantBList).toHaveLength(1);
      expect(tenantBList[0]).toEqual(tenantB);
    } finally {
      await restartedClient.close();
    }
  });

  it("keeps identical artifact IDs isolated across Postgres tenant scopes", async () => {
    const client = createPostgresIntegrationClient(postgresUrl!);
    try {
      const artifacts = createPostgresArtifactService({ client, tableName: artifactTable });
      const sessionId = `tenant-session-${Date.now()}`;
      await artifacts.saveArtifact({
        appName: "tenant-app",
        userId: "tenant-a",
        sessionId,
        id: "shared-id",
        name: "shared.json",
        contentType: "application/json",
        data: { tenant: "a" }
      });
      await artifacts.saveArtifact({
        appName: "tenant-app",
        userId: "tenant-b",
        sessionId,
        id: "shared-id",
        name: "shared.json",
        contentType: "application/json",
        data: { tenant: "b" }
      });

      const tenantA = await artifacts.listArtifacts({ appName: "tenant-app", userId: "tenant-a", sessionId });
      const tenantB = await artifacts.listArtifacts({ appName: "tenant-app", userId: "tenant-b", sessionId });
      expect(tenantA).toHaveLength(1);
      expect(tenantA[0]?.data).toEqual({ tenant: "a" });
      expect(tenantB).toHaveLength(1);
      expect(tenantB[0]?.data).toEqual({ tenant: "b" });
    } finally {
      await client.close();
    }
  });
});
