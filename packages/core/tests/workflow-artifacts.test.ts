import { describe, expect, it } from "vitest";

import {
  createInMemoryArtifactService,
  createWorkflowEvaluationReport,
  saveWorkflowEvaluationReportAsArtifact,
  saveWorkflowOutputsAsArtifacts,
  saveWorkflowReplayAsArtifact,
  type WorkflowEvaluationResult,
  type WorkflowRunOutput
} from "../src/index.js";

const workflowOutput = (): WorkflowRunOutput => ({
  status: "completed",
  outputs: {
    intake: { summary: "ok" },
    review: "approved"
  },
  steps: [
    {
      id: "intake-step",
      kind: "task",
      status: "completed",
      outputKey: "intake",
      outputText: "ok"
    },
    {
      id: "review-step",
      kind: "task",
      status: "completed",
      outputKey: "review",
      outputText: "approved"
    }
  ],
  state: {
    workflowId: "candidate-review",
    runId: "wfr_1",
    userId: "user_1",
    sessionId: "session_1",
    status: "completed",
    outputs: {
      intake: { summary: "ok" },
      review: "approved"
    },
    steps: [
      {
        id: "intake-step",
        kind: "task",
        status: "completed",
        outputKey: "intake",
        outputText: "ok"
      },
      {
        id: "review-step",
        kind: "task",
        status: "completed",
        outputKey: "review",
        outputText: "approved"
      }
    ],
    currentStepIndex: 2,
    createdAt: 1,
    updatedAt: 2
  }
});

const evaluationResult = (): WorkflowEvaluationResult => ({
  ok: false,
  cases: [
    {
      name: "case",
      ok: false,
      failures: ["Expected output."],
      output: {
        status: "failed",
        outputs: {},
        steps: [],
        state: {
          runId: "wfr_eval",
          userId: "user_1",
          sessionId: "session_1",
          status: "failed",
          outputs: {},
          steps: [],
          currentStepIndex: 0,
          createdAt: 1,
          updatedAt: 2
        }
      }
    }
  ]
});

describe("workflow artifact helpers", () => {
  it("saves workflow outputs as artifacts by outputKey", async () => {
    const artifactService = createInMemoryArtifactService();

    const artifacts = await saveWorkflowOutputsAsArtifacts(workflowOutput(), {
      artifactService,
      appName: "app"
    });

    expect(artifacts.map((artifact) => artifact.name)).toEqual([
      "workflow-output-intake.json",
      "workflow-output-review.json"
    ]);
    expect(artifacts).toEqual([
      expect.objectContaining({
        appName: "app",
        userId: "user_1",
        sessionId: "session_1",
        workflowRunId: "wfr_1",
        workflowStepId: "intake-step",
        data: { summary: "ok" },
        metadata: { kind: "workflow-output", outputKey: "intake" }
      }),
      expect.objectContaining({
        workflowStepId: "review-step",
        data: "approved",
        metadata: { kind: "workflow-output", outputKey: "review" }
      })
    ]);
  });

  it("respects explicit identity and metadata for workflow outputs", async () => {
    const artifactService = createInMemoryArtifactService();

    const artifacts = await saveWorkflowOutputsAsArtifacts(workflowOutput(), {
      artifactService,
      appName: "explicit-app",
      userId: "explicit-user",
      sessionId: "explicit-session",
      namePrefix: "output",
      metadata: { source: "test" }
    });

    expect(artifacts[0]).toMatchObject({
      appName: "explicit-app",
      userId: "explicit-user",
      sessionId: "explicit-session",
      name: "output-intake.json",
      metadata: { source: "test", kind: "workflow-output", outputKey: "intake" }
    });
  });

  it("saves workflow replay as an artifact without re-running models", async () => {
    const artifactService = createInMemoryArtifactService();

    const artifact = await saveWorkflowReplayAsArtifact(workflowOutput(), {
      artifactService,
      appName: "app"
    });

    expect(artifact).toMatchObject({
      appName: "app",
      userId: "user_1",
      sessionId: "session_1",
      workflowRunId: "wfr_1",
      name: "workflow-replay.json",
      contentType: "application/json",
      metadata: { kind: "workflow-replay" }
    });
    expect((artifact.data as { timeline: Array<{ type: string }> }).timeline.map((event) => event.type)).toEqual([
      "workflow-start",
      "step-start",
      "step-finish",
      "step-start",
      "step-finish",
      "workflow-finish"
    ]);
  });

  it("saves workflow evaluation reports from evaluation results", async () => {
    const artifactService = createInMemoryArtifactService();

    const artifact = await saveWorkflowEvaluationReportAsArtifact(evaluationResult(), {
      artifactService,
      appName: "app",
      userId: "user_1",
      sessionId: "session_1",
      workflowRunId: "wfr_eval"
    });

    expect(artifact).toMatchObject({
      appName: "app",
      userId: "user_1",
      sessionId: "session_1",
      workflowRunId: "wfr_eval",
      name: "workflow-evaluation-report.json",
      metadata: { kind: "workflow-evaluation-report" }
    });
    expect(artifact.data).toMatchObject({
      ok: false,
      total: 1,
      passed: 0,
      failed: 1,
      passRate: 0
    });
  });

  it("saves existing workflow evaluation reports without recomputing them", async () => {
    const artifactService = createInMemoryArtifactService();
    const report = createWorkflowEvaluationReport(evaluationResult(), {
      metadata: { prepared: true }
    });

    const artifact = await saveWorkflowEvaluationReportAsArtifact(report, {
      artifactService,
      appName: "app",
      userId: "user_1",
      sessionId: "session_1",
      name: "prepared-report.json",
      metadata: { source: "prepared" }
    });

    expect(artifact).toMatchObject({
      name: "prepared-report.json",
      metadata: { source: "prepared", kind: "workflow-evaluation-report" },
      data: {
        metadata: { prepared: true },
        total: 1
      }
    });
  });

  it("requires identity when it cannot be inferred from workflow state", async () => {
    const artifactService = createInMemoryArtifactService();

    await expect(
      saveWorkflowEvaluationReportAsArtifact(evaluationResult(), {
        artifactService,
        appName: "app"
      })
    ).rejects.toThrow("userId");
  });

  it("exports workflow artifact helpers from the public index", async () => {
    const api = await import("../src/index.js");

    expect(api.saveWorkflowEvaluationReportAsArtifact).toBeTypeOf("function");
    expect(api.saveWorkflowOutputsAsArtifacts).toBeTypeOf("function");
    expect(api.saveWorkflowReplayAsArtifact).toBeTypeOf("function");
  });
});
