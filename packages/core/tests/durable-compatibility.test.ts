import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import fixtures from "./fixtures/durable-compatibility.json" with { type: "json" };
import {
  ARTIFACT_SCHEMA_VERSION,
  createFileArtifactService,
  createFileSessionService,
  createFileWorkflowStateService,
  normalizeAgentSession,
  normalizeArtifactRecord,
  normalizeWorkflowRunState,
  normalizeWorkflowStateRecord,
  SESSION_SCHEMA_VERSION,
  ValidationError,
  WORKFLOW_RUN_STATE_SCHEMA_VERSION,
  WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
  type AgentSession,
  type ArtifactRecord,
  type WorkflowStateRecord
} from "../src/index.js";

const tempDir = () => mkdtemp(path.join(os.tmpdir(), "zhivex-durable-compat-"));
const safeName = (...parts: string[]) => `${parts.map((part) => encodeURIComponent(part)).join("__")}.json`;

describe("durable compatibility fixtures", () => {
  it("normalizes legacy records without schemaVersion or revision", () => {
    expect(normalizeAgentSession(fixtures.agentSession)).toMatchObject({
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: 1
    });
    expect(normalizeArtifactRecord(fixtures.artifactRecord)).toMatchObject({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      revision: 1
    });
    expect(normalizeWorkflowRunState(fixtures.workflowRunState)).toMatchObject({
      schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION
    });
    expect(normalizeWorkflowStateRecord(fixtures.workflowStateRecord)).toMatchObject({
      schemaVersion: WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
      revision: 1,
      state: {
        schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION
      }
    });
  });

  it("preserves v1 durable records", () => {
    const session = normalizeAgentSession({
      ...fixtures.agentSession,
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: 7
    });
    const artifact = normalizeArtifactRecord({
      ...fixtures.artifactRecord,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      revision: 8
    });
    const workflowState = normalizeWorkflowStateRecord({
      ...fixtures.workflowStateRecord,
      schemaVersion: WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
      revision: 9,
      state: {
        ...fixtures.workflowStateRecord.state,
        schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION
      }
    });

    expect(session.revision).toBe(7);
    expect(artifact.revision).toBe(8);
    expect(workflowState.revision).toBe(9);
  });

  it("rejects future durable record versions", () => {
    expect(() => normalizeAgentSession({ ...fixtures.agentSession, schemaVersion: 999 })).toThrow(ValidationError);
    expect(() => normalizeArtifactRecord({ ...fixtures.artifactRecord, schemaVersion: 999 })).toThrow(ValidationError);
    expect(() => normalizeWorkflowRunState({ ...fixtures.workflowRunState, schemaVersion: 999 })).toThrow(ValidationError);
    expect(() => normalizeWorkflowStateRecord({ ...fixtures.workflowStateRecord, schemaVersion: 999 })).toThrow(ValidationError);
  });

  it("loads legacy file-backed records as schema v1", async () => {
    const root = await tempDir();
    const sessionDir = path.join(root, "sessions");
    const artifactDir = path.join(root, "artifacts");
    const workflowStateDir = path.join(root, "workflow-states");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await mkdir(workflowStateDir, { recursive: true });

    await writeFile(
      path.join(sessionDir, safeName("compat-app", "compat-user", "compat-session")),
      JSON.stringify(fixtures.agentSession),
      "utf8"
    );
    await writeFile(
      path.join(artifactDir, safeName("compat-app", "compat-user", "compat-session", "compat-artifact")),
      JSON.stringify(fixtures.artifactRecord),
      "utf8"
    );
    await writeFile(
      path.join(workflowStateDir, safeName("compat-app", "compat-user", "compat-session", "compat-workflow")),
      JSON.stringify(fixtures.workflowStateRecord),
      "utf8"
    );

    await expect(createFileSessionService({ directory: sessionDir }).loadSession({
      appName: "compat-app",
      userId: "compat-user",
      sessionId: "compat-session"
    })).resolves.toMatchObject({ schemaVersion: SESSION_SCHEMA_VERSION, revision: 1 } satisfies Partial<AgentSession>);

    await expect(createFileArtifactService({ directory: artifactDir }).loadArtifact({
      appName: "compat-app",
      userId: "compat-user",
      sessionId: "compat-session",
      id: "compat-artifact"
    })).resolves.toMatchObject({ schemaVersion: ARTIFACT_SCHEMA_VERSION, revision: 1 } satisfies Partial<ArtifactRecord>);

    await expect(createFileWorkflowStateService({ directory: workflowStateDir }).loadWorkflowState({
      appName: "compat-app",
      userId: "compat-user",
      sessionId: "compat-session",
      workflowKey: "compat-workflow"
    })).resolves.toMatchObject({
      schemaVersion: WORKFLOW_STATE_RECORD_SCHEMA_VERSION,
      revision: 1,
      state: { schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION }
    } satisfies Partial<WorkflowStateRecord>);
  });
});
