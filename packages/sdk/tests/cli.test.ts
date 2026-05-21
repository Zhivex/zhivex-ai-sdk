import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAgentRunLedger,
  createFileArtifactService,
  createFileSessionService,
  createFileWorkflowStateService,
  createTextMessage,
  type AgentRunState
} from "@zhivex-ai/core";

import { runCli } from "../src/cli.js";

const createCapture = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text)
    }
  };
};

const tempDir = async (prefix: string) => fs.mkdtemp(path.join(os.tmpdir(), prefix));
const readJson = async <T = unknown>(filePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(filePath, "utf8")) as T;

const baseAgentState = (overrides: Partial<AgentRunState> = {}): AgentRunState => ({
  schemaVersion: 1,
  runId: "run_1",
  agentId: "agent_1",
  provider: "test",
  modelId: "model",
  status: "completed",
  messages: [createTextMessage("assistant", "done")],
  steps: [],
  toolResults: [],
  currentStep: 1,
  maxSteps: 4,
  outputText: "done",
  pendingApprovals: [],
  startedAt: 1,
  updatedAt: 2,
  ...overrides
});

describe("zhivex-ai CLI", () => {
  it("prints help output", async () => {
    const capture = createCapture();
    await expect(runCli(["--help"], capture.io)).resolves.toBe(0);
    expect(capture.stdout[0]).toContain("agents ledger|diff|golden");
    expect(capture.stdout[0]).toContain("sessions list|show|workflow-state|prune");
  });

  it("creates agent ledgers and golden traces from local JSON", async () => {
    const directory = await tempDir("zhivex-cli-agents-");
    const statePath = path.join(directory, "state.json");
    const ledgerPath = path.join(directory, "ledger.json");
    const goldenPath = path.join(directory, "golden.json");
    await fs.writeFile(statePath, JSON.stringify(baseAgentState()), "utf8");
    const capture = createCapture();

    const ledgerCode = await runCli(["agents", "ledger", "--state", statePath, "--out", ledgerPath], capture.io);
    const goldenCode = await runCli(["agents", "golden", "--ledger", ledgerPath, "--name", "happy-path", "--out", goldenPath], capture.io);

    expect(ledgerCode).toBe(0);
    expect(goldenCode).toBe(0);
    expect(await readJson(ledgerPath)).toMatchObject({
      type: "agent_run_ledger",
      runId: "run_1",
      status: "completed"
    });
    expect(await readJson(goldenPath)).toMatchObject({
      type: "agent_golden_trace",
      name: "happy-path",
      expectations: { status: "completed", outputText: "done" }
    });
  });

  it("diffs agent ledgers from local JSON", async () => {
    const directory = await tempDir("zhivex-cli-agents-");
    const basePath = path.join(directory, "base.json");
    const targetPath = path.join(directory, "target.json");
    await fs.writeFile(basePath, JSON.stringify(createAgentRunLedger(baseAgentState())), "utf8");
    await fs.writeFile(targetPath, JSON.stringify(createAgentRunLedger(baseAgentState({ runId: "run_2", outputText: "changed" }))), "utf8");
    const capture = createCapture();

    const code = await runCli(["agents", "diff", "--base", basePath, "--target", targetPath], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      ok: false,
      changes: [expect.objectContaining({ field: "outputText" })]
    });
  });

  it("lists file-backed sessions", async () => {
    const directory = await tempDir("zhivex-cli-sessions-");
    const service = createFileSessionService({ directory });
    await service.createSession({
      appName: "app",
      userId: "user",
      sessionId: "session",
      metadata: { source: "test" }
    });
    const capture = createCapture();

    const code = await runCli(["sessions", "list", "--dir", directory], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toEqual([
      expect.objectContaining({
        appName: "app",
        userId: "user",
        sessionId: "session",
        metadata: { source: "test" }
      })
    ]);
  });

  it("shows a file-backed session", async () => {
    const directory = await tempDir("zhivex-cli-sessions-");
    const service = createFileSessionService({ directory });
    await service.createSession({
      appName: "app",
      userId: "user",
      sessionId: "session"
    });
    const capture = createCapture();

    const code = await runCli([
      "sessions",
      "show",
      "--dir",
      directory,
      "--app",
      "app",
      "--user",
      "user",
      "--session",
      "session"
    ], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      appName: "app",
      userId: "user",
      sessionId: "session"
    });
  });

  it("shows persisted workflow state from a session", async () => {
    const directory = await tempDir("zhivex-cli-sessions-");
    const service = createFileSessionService({ directory });
    await service.createSession({
      appName: "app",
      userId: "user",
      sessionId: "session",
      metadata: {
        workflowRuns: {
          "candidate-review": {
            runId: "wfr_1",
            userId: "user",
            sessionId: "session",
            status: "completed",
            outputs: { answer: "ok" },
            steps: [],
            currentStepIndex: 1,
            createdAt: 1,
            updatedAt: 2
          }
        }
      }
    });
    const capture = createCapture();

    const code = await runCli([
      "sessions",
      "workflow-state",
      "show",
      "--dir",
      directory,
      "--app",
      "app",
      "--user",
      "user",
      "--session",
      "session",
      "--workflow",
      "candidate-review"
    ], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      runId: "wfr_1",
      outputs: { answer: "ok" }
    });
  });

  it("lists file-backed artifacts with filters", async () => {
    const directory = await tempDir("zhivex-cli-artifacts-");
    const service = createFileArtifactService({ directory });
    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "review",
      workflowRunId: "wfr_1",
      workflowStepId: "review",
      name: "review.json",
      contentType: "application/json",
      data: { ok: true }
    });
    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "agent",
      agentRunId: "run_1",
      name: "agent.txt",
      contentType: "text/plain",
      data: "agent"
    });
    const capture = createCapture();

    const code = await runCli([
      "artifacts",
      "list",
      "--dir",
      directory,
      "--app",
      "app",
      "--user",
      "user",
      "--session",
      "session",
      "--workflow-run",
      "wfr_1",
      "--workflow-step",
      "review"
    ], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toEqual([
      expect.objectContaining({
        id: "review",
        workflowRunId: "wfr_1",
        workflowStepId: "review"
      })
    ]);
  });

  it("shows a file-backed artifact", async () => {
    const directory = await tempDir("zhivex-cli-artifacts-");
    const service = createFileArtifactService({ directory });
    await service.saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "artifact",
      name: "artifact.txt",
      contentType: "text/plain",
      data: "hello"
    });
    const capture = createCapture();

    const code = await runCli([
      "artifacts",
      "show",
      "--dir",
      directory,
      "--app",
      "app",
      "--user",
      "user",
      "--session",
      "session",
      "--id",
      "artifact"
    ], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      id: "artifact",
      data: "hello"
    });
  });

  it("verifies and inspects file-backed artifacts", async () => {
    const directory = await tempDir("zhivex-cli-artifacts-");
    const service = createFileArtifactService({ directory });
    const artifact = await service.saveBinaryArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "binary",
      name: "binary.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array([1, 2, 3])
    });
    const verify = createCapture();

    const verifyCode = await runCli([
      "artifacts",
      "verify",
      "--dir",
      directory,
      "--app",
      "app",
      "--user",
      "user",
      "--session",
      "session",
      "--id",
      "binary"
    ], verify.io);

    expect(verifyCode).toBe(0);
    expect(JSON.parse(verify.stdout[0]!)).toMatchObject({
      ok: true,
      artifact: { id: artifact.id },
      issues: []
    });

    const orphanPath = path.join(directory, "blobs", "orphan.bin");
    await fs.writeFile(orphanPath, new Uint8Array([9]));
    const inspect = createCapture();
    const inspectCode = await runCli(["artifacts", "inspect", "--dir", directory], inspect.io);
    expect(inspectCode).toBe(0);
    expect(JSON.parse(inspect.stdout[0]!)).toMatchObject({
      issues: [expect.objectContaining({ type: "orphan-blob" })]
    });

    const cleanup = createCapture();
    const cleanupCode = await runCli(["artifacts", "cleanup", "--dir", directory, "--dry-run"], cleanup.io);
    expect(cleanupCode).toBe(0);
    expect(JSON.parse(cleanup.stdout[0]!)).toMatchObject({
      dryRun: true,
      deletedBlobPaths: [orphanPath]
    });
    await expect(fs.stat(orphanPath)).resolves.toBeDefined();
  });

  it("replays workflow state files", async () => {
    const directory = await tempDir("zhivex-cli-workflow-");
    const statePath = path.join(directory, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        runId: "wfr_1",
        userId: "user",
        sessionId: "session",
        status: "completed",
        outputs: { answer: "ok" },
        steps: [
          {
            id: "answer",
            kind: "task",
            status: "completed",
            outputText: "ok"
          }
        ],
        currentStepIndex: 1,
        createdAt: 1,
        updatedAt: 2
      }),
      "utf8"
    );
    const capture = createCapture();

    const code = await runCli(["workflow", "replay", "--state", statePath], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      status: "completed",
      outputs: { answer: "ok" },
      timeline: [
        { type: "workflow-start" },
        { type: "step-start" },
        { type: "step-finish" },
        { type: "workflow-finish" }
      ]
    });
  });

  it("saves workflow replay output as a file-backed artifact", async () => {
    const directory = await tempDir("zhivex-cli-workflow-");
    const artifactsDirectory = await tempDir("zhivex-cli-artifacts-");
    const statePath = path.join(directory, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        runId: "wfr_1",
        userId: "user",
        sessionId: "session",
        status: "completed",
        outputs: { answer: "ok" },
        steps: [],
        currentStepIndex: 1,
        createdAt: 1,
        updatedAt: 2
      }),
      "utf8"
    );
    const capture = createCapture();

    const code = await runCli([
      "workflow",
      "replay",
      "--state",
      statePath,
      "--save-artifact",
      "--artifacts-dir",
      artifactsDirectory,
      "--app",
      "app",
      "--name",
      "replay.json"
    ], capture.io);

    expect(code).toBe(0);
    const artifact = JSON.parse(capture.stdout[0]!);
    expect(artifact).toMatchObject({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowRunId: "wfr_1",
      name: "replay.json",
      metadata: { kind: "workflow-replay" }
    });
    await expect(
      createFileArtifactService({ directory: artifactsDirectory }).loadArtifact({
        appName: "app",
        userId: "user",
        sessionId: "session",
        id: artifact.id
      })
    ).resolves.toMatchObject({ id: artifact.id });
  });

  it("creates workflow reports from evaluation result files", async () => {
    const directory = await tempDir("zhivex-cli-workflow-");
    const evaluationPath = path.join(directory, "evaluation.json");
    await fs.writeFile(
      evaluationPath,
      JSON.stringify({
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
                runId: "wfr_1",
                userId: "user",
                sessionId: "session",
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
      }),
      "utf8"
    );
    const capture = createCapture();

    const code = await runCli(["workflow", "report", "--evaluation", evaluationPath], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      ok: false,
      total: 1,
      passed: 0,
      failed: 1,
      passRate: 0,
      failures: [{ name: "case", failures: ["Expected output."] }]
    });
  });

  it("saves workflow evaluation reports as file-backed artifacts", async () => {
    const directory = await tempDir("zhivex-cli-workflow-");
    const artifactsDirectory = await tempDir("zhivex-cli-artifacts-");
    const evaluationPath = path.join(directory, "evaluation.json");
    await fs.writeFile(
      evaluationPath,
      JSON.stringify({
        ok: true,
        cases: [
          {
            name: "case",
            ok: true,
            failures: [],
            output: {
              status: "completed",
              outputs: { answer: "ok" },
              steps: [],
              state: {
                runId: "wfr_1",
                userId: "user",
                sessionId: "session",
                status: "completed",
                outputs: { answer: "ok" },
                steps: [],
                currentStepIndex: 1,
                createdAt: 1,
                updatedAt: 2
              }
            }
          }
        ]
      }),
      "utf8"
    );
    const capture = createCapture();

    const code = await runCli([
      "workflow",
      "report",
      "--evaluation",
      evaluationPath,
      "--save-artifact",
      "--artifacts-dir",
      artifactsDirectory,
      "--app",
      "app",
      "--user",
      "user",
      "--session",
      "session",
      "--workflow-run",
      "wfr_1"
    ], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowRunId: "wfr_1",
      metadata: { kind: "workflow-evaluation-report" }
    });
  });

  it("compares workflow evaluation reports", async () => {
    const directory = await tempDir("zhivex-cli-workflow-");
    const basePath = path.join(directory, "base.json");
    const targetPath = path.join(directory, "target.json");
    const base = {
      ok: true,
      total: 1,
      passed: 1,
      failed: 0,
      passRate: 1,
      statusCounts: {},
      stepCount: 0,
      stepStatusCounts: {},
      timelineEventCounts: {},
      failures: [],
      cases: [
        {
          name: "case",
          ok: true,
          status: "completed",
          failures: [],
          outputPreview: "{}",
          outputKeys: [],
          stepCount: 0,
          stepStatusCounts: {},
          timelineEventCounts: {}
        }
      ]
    };
    const target = {
      ...base,
      ok: false,
      passed: 0,
      failed: 1,
      passRate: 0,
      failures: [{ name: "case", failures: ["Expected output."] }],
      cases: [
        {
          ...base.cases[0],
          ok: false,
          status: "failed",
          failures: ["Expected output."]
        }
      ]
    };
    await fs.writeFile(basePath, JSON.stringify(base), "utf8");
    await fs.writeFile(targetPath, JSON.stringify(target), "utf8");
    const capture = createCapture();

    const code = await runCli(["workflow", "compare", "--base", basePath, "--target", targetPath], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      ok: false,
      summary: {
        changed: 1,
        newFailures: 1
      }
    });
  });

  it("runs workflow modules locally and writes state and output files", async () => {
    const directory = await tempDir("zhivex-cli-exec-");
    const modulePath = path.join(directory, "workflow.mjs");
    const inputPath = path.join(directory, "input.json");
    const statePath = path.join(directory, "state.json");
    const outputPath = path.join(directory, "output.json");
    await fs.writeFile(modulePath, `
const runner = {
  async run(input) {
    return {
      session: {
        appName: "cli-test",
        userId: input.userId,
        sessionId: input.sessionId,
        createdAt: 1,
        updatedAt: 1,
        events: []
      },
      output: {
        status: "completed",
        outputText: "module output",
        steps: [{ response: { text: "module output" } }],
        state: { runId: "run_1", pendingApprovals: [] }
      }
    };
  }
};
export default {
  id: "module-workflow",
  steps: [{ id: "step", runner, prompt: "Run", outputKey: "answer" }]
};
`, "utf8");
    await fs.writeFile(inputPath, JSON.stringify({ userId: "user", sessionId: "session" }), "utf8");
    const capture = createCapture();

    const code = await runCli([
      "workflow",
      "run",
      "--module",
      modulePath,
      "--input",
      inputPath,
      "--state-out",
      statePath,
      "--output-out",
      outputPath
    ], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      status: "completed",
      outputs: { answer: "module output" }
    });
    await expect(readJson(statePath)).resolves.toMatchObject({ outputs: { answer: "module output" } });
    await expect(readJson(outputPath)).resolves.toMatchObject({ status: "completed" });
  });

  it("evaluates workflow modules locally and writes reports", async () => {
    const directory = await tempDir("zhivex-cli-eval-");
    const modulePath = path.join(directory, "workflow.mjs");
    const fixturePath = path.join(directory, "fixture.json");
    const reportPath = path.join(directory, "report.json");
    await fs.writeFile(modulePath, `
const runner = {
  async run(input) {
    return {
      session: { appName: "cli-test", userId: input.userId, sessionId: input.sessionId, createdAt: 1, updatedAt: 1, events: [] },
      output: {
        status: "completed",
        outputText: "eval output",
        steps: [{ response: { text: "eval output" } }],
        state: { runId: "run_1", pendingApprovals: [] }
      }
    };
  }
};
export const workflow = {
  id: "eval-workflow",
  steps: [{ id: "step", runner, prompt: "Run", outputKey: "answer" }]
};
`, "utf8");
    await fs.writeFile(fixturePath, JSON.stringify({
      name: "fixture",
      dataset: [
        {
          name: "case",
          input: { userId: "user", sessionId: "session" },
          expectations: { outputs: { answer: "eval output" } }
        }
      ]
    }), "utf8");
    const capture = createCapture();

    const code = await runCli([
      "workflow",
      "eval",
      "--module",
      modulePath,
      "--workflow-export",
      "workflow",
      "--fixture",
      fixturePath,
      "--report-out",
      reportPath
    ], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({ ok: true, passRate: 1 });
    await expect(readJson(reportPath)).resolves.toMatchObject({ total: 1, passed: 1 });
  });

  it("lists and shows file-backed workflow states", async () => {
    const directory = await tempDir("zhivex-cli-workflow-states-");
    const service = createFileWorkflowStateService({ directory });
    await service.saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state: {
        runId: "wfr_1",
        userId: "user",
        sessionId: "session",
        status: "completed",
        outputs: { answer: "ok" },
        steps: [],
        currentStepIndex: 1,
        createdAt: 1,
        updatedAt: 2
      }
    });
    const listed = createCapture();
    const listCode = await runCli([
      "workflow-states",
      "list",
      "--dir",
      directory,
      "--app",
      "app",
      "--user",
      "user",
      "--session",
      "session"
    ], listed.io);
    expect(listCode).toBe(0);
    expect(JSON.parse(listed.stdout[0]!)).toEqual([expect.objectContaining({ workflowKey: "workflow" })]);

    const shown = createCapture();
    const showCode = await runCli([
      "workflow-states",
      "show",
      "--dir",
      directory,
      "--app",
      "app",
      "--user",
      "user",
      "--session",
      "session",
      "--workflow",
      "workflow"
    ], shown.io);
    expect(showCode).toBe(0);
    expect(JSON.parse(shown.stdout[0]!)).toMatchObject({ state: { outputs: { answer: "ok" } } });
  });

  it("prunes local file-backed stores in dry-run mode", async () => {
    const sessionDir = await tempDir("zhivex-cli-prune-sessions-");
    await createFileSessionService({ directory: sessionDir }).createSession({
      appName: "app",
      userId: "user",
      sessionId: "session"
    });
    const sessions = createCapture();
    await expect(runCli(["sessions", "prune", "--dir", sessionDir, "--keep-last", "0"], sessions.io)).resolves.toBe(0);
    expect(JSON.parse(sessions.stdout[0]!)).toMatchObject({ dryRun: true, deletedSessionKeys: ["app:user:session"] });

    const artifactDir = await tempDir("zhivex-cli-prune-artifacts-");
    await createFileArtifactService({ directory: artifactDir }).saveArtifact({
      appName: "app",
      userId: "user",
      sessionId: "session",
      id: "artifact",
      name: "artifact.json",
      contentType: "application/json",
      data: { ok: true }
    });
    const artifacts = createCapture();
    await expect(runCli(["artifacts", "prune", "--dir", artifactDir, "--keep-last", "0"], artifacts.io)).resolves.toBe(0);
    expect(JSON.parse(artifacts.stdout[0]!)).toMatchObject({ dryRun: true, deletedArtifactKeys: ["app:user:session:artifact"] });

    const workflowDir = await tempDir("zhivex-cli-prune-workflow-states-");
    await createFileWorkflowStateService({ directory: workflowDir }).saveWorkflowState({
      appName: "app",
      userId: "user",
      sessionId: "session",
      workflowKey: "workflow",
      state: {
        runId: "wfr_1",
        userId: "user",
        sessionId: "session",
        status: "completed",
        outputs: {},
        steps: [],
        currentStepIndex: 1,
        createdAt: 1,
        updatedAt: 2
      }
    });
    const workflows = createCapture();
    await expect(runCli(["workflow-states", "prune", "--dir", workflowDir, "--keep-last", "0"], workflows.io)).resolves.toBe(0);
    expect(JSON.parse(workflows.stdout[0]!)).toMatchObject({ dryRun: true, deletedWorkflowStateKeys: ["app:user:session:workflow"] });
  });

  it("returns exit code 1 for invalid commands and missing flags", async () => {
    const invalid = createCapture();
    await expect(runCli(["nope"], invalid.io)).resolves.toBe(1);
    expect(invalid.stderr[0]).toBe("Unknown command.");

    const missingFlag = createCapture();
    await expect(runCli(["sessions", "show", "--dir", "/tmp"], missingFlag.io)).resolves.toBe(1);
    expect(missingFlag.stderr[0]).toBe("Missing required flag --app.");

    const missingArtifactDir = createCapture();
    await expect(runCli([
      "workflow",
      "replay",
      "--state",
      "/tmp/missing.json",
      "--save-artifact"
    ], missingArtifactDir.io)).resolves.toBe(1);

    const missingExport = createCapture();
    const directory = await tempDir("zhivex-cli-bad-module-");
    const modulePath = path.join(directory, "workflow.mjs");
    const inputPath = path.join(directory, "input.json");
    await fs.writeFile(modulePath, "export const other = {};", "utf8");
    await fs.writeFile(inputPath, JSON.stringify({ userId: "user" }), "utf8");
    await expect(runCli([
      "workflow",
      "run",
      "--module",
      modulePath,
      "--export",
      "missing",
      "--input",
      inputPath
    ], missingExport.io)).resolves.toBe(1);
    expect(missingExport.stderr[0]).toBe('Module export "missing" not found.');
  });
});
