import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAgent,
  createFileSessionService,
  createInMemorySessionService,
  createInMemoryWorkflowStateService,
  createRunner,
  createTextMessage,
  createWorkflow,
  loadWorkflowState,
  migrateWorkflowRunState,
  normalizeWorkflowRunState,
  replayWorkflowRun,
  runWorkflow,
  saveWorkflowState,
  ValidationError,
  WORKFLOW_RUN_STATE_SCHEMA_VERSION,
  type LanguageModel,
  type StreamEvent
} from "../src/index.js";

const createLanguageModel = (overrides?: Partial<LanguageModel>): LanguageModel => ({
  provider: "test",
  modelId: "workflow-model",
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
  async generate() {
    return {
      messages: [createTextMessage("assistant", "workflow output")],
      text: "workflow output",
      finishReason: "stop"
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "workflow" };
      yield { type: "finish", finishReason: "stop" };
    })();
  },
  ...overrides
});

const createTestRunner = (model: LanguageModel) =>
  createRunner({
    appName: "workflow-test",
    agent: createAgent({ model, maxSteps: 3 }),
    sessionService: createInMemorySessionService()
  });

const createTestRunnerWithSessionService = (
  model: LanguageModel,
  sessionService: ReturnType<typeof createInMemorySessionService>
) =>
  createRunner({
    appName: "workflow-test",
    agent: createAgent({ model, maxSteps: 3 }),
    sessionService
  });

describe("declarative workflows", () => {
  it("runs sequential steps and passes outputs by outputKey", async () => {
    const seenPrompts: string[] = [];
    const runner = createTestRunner(
      createLanguageModel({
        async generate(input) {
          const prompt = input.messages.at(-1)?.parts[0];
          seenPrompts.push(prompt?.type === "text" ? prompt.text : "");
          const text = seenPrompts.length === 1 ? "intake complete" : "review complete";
          return {
            messages: [createTextMessage("assistant", text)],
            text,
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      id: "candidate-review",
      steps: [
        {
          id: "intake",
          runner,
          prompt: "Summarize the candidate",
          outputKey: "intake"
        },
        {
          id: "review",
          runner,
          prompt: ({ outputs }) => `Review this intake: ${outputs.intake}`,
          outputKey: "review"
        }
      ]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(result.status).toBe("completed");
    expect(result.state.schemaVersion).toBe(WORKFLOW_RUN_STATE_SCHEMA_VERSION);
    expect(result.outputs).toEqual({
      intake: "intake complete",
      review: "review complete"
    });
    expect(result.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    expect(seenPrompts[1]).toBe("Review this intake: intake complete");
  });

  it("stops on approval waits and resumes the pending step", async () => {
    let callCount = 0;
    let sawApprovalResponse = false;
    const runner = createTestRunner(
      createLanguageModel({
        async generate(input) {
          callCount += 1;
          if (callCount === 1) {
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
                        id: "mcpr_1",
                        arguments: "{}",
                        name: "fetch_docs"
                      }
                    }
                  ]
                }
              ],
              text: "Need approval",
              finishReason: "stop"
            };
          }

          sawApprovalResponse = input.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "provider-data" &&
                part.provider === "openai" &&
                (part.data as { type?: string }).type === "mcp_approval_response"
            )
          );
          return {
            messages: [createTextMessage("assistant", "approved workflow")],
            text: "approved workflow",
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      steps: [{ id: "approval-step", runner, prompt: "Use MCP", outputKey: "result" }]
    });

    const waiting = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.steps[0]).toMatchObject({
      id: "approval-step",
      status: "waiting_approval"
    });

    const unchanged = await runWorkflow(workflow, {
      userId: "user_1",
      state: waiting.state
    });
    expect(unchanged.status).toBe("waiting_approval");
    expect(callCount).toBe(1);

    const resumed = await runWorkflow(workflow, {
      userId: "user_1",
      state: waiting.state,
      approvals: [{ provider: "openai", approvalRequestId: "mcpr_1", approve: true }]
    });

    expect(sawApprovalResponse).toBe(true);
    expect(resumed.status).toBe("completed");
    expect(resumed.outputs.result).toBe("approved workflow");
  });

  it("stops on step errors and marks the workflow failed", async () => {
    const runner = createTestRunner(
      createLanguageModel({
        async generate() {
          throw new Error("step failed");
        }
      })
    );
    const workflow = createWorkflow({
      steps: [{ id: "broken", runner, prompt: "Break" }]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({
      id: "broken",
      status: "failed",
      error: { message: "step failed" }
    });
  });

  it("replays workflow state without re-running models", async () => {
    let calls = 0;
    const runner = createTestRunner(
      createLanguageModel({
        async generate() {
          calls += 1;
          return {
            messages: [createTextMessage("assistant", "done")],
            text: "done",
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      id: "replayable",
      steps: [{ id: "only", runner, prompt: "Run", outputKey: "done" }]
    });
    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    const replay = replayWorkflowRun(result.state);

    expect(calls).toBe(1);
    expect(replay.status).toBe("completed");
    expect(replay.outputs.done).toBe("done");
    expect(replay.timeline.map((event) => event.type)).toEqual([
      "workflow-start",
      "step-start",
      "step-finish",
      "workflow-finish"
    ]);
  });

  it("runs parallel child steps in order and feeds outputs to the next sequential step", async () => {
    const market = createTestRunner(
      createLanguageModel({
        async generate() {
          return {
            messages: [createTextMessage("assistant", "market ok")],
            text: "market ok",
            finishReason: "stop"
          };
        }
      })
    );
    const legal = createTestRunner(
      createLanguageModel({
        async generate() {
          return {
            messages: [createTextMessage("assistant", "legal ok")],
            text: "legal ok",
            finishReason: "stop"
          };
        }
      })
    );
    const seenPrompts: string[] = [];
    const synthesis = createTestRunner(
      createLanguageModel({
        async generate(input) {
          const prompt = input.messages.at(-1)?.parts[0];
          seenPrompts.push(prompt?.type === "text" ? prompt.text : "");
          return {
            messages: [createTextMessage("assistant", "synthesis ok")],
            text: "synthesis ok",
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      steps: [
        {
          id: "research",
          kind: "parallel",
          steps: [
            { id: "market", runner: market, prompt: "Analyze market", outputKey: "market" },
            { id: "legal", runner: legal, prompt: "Analyze legal", outputKey: "legal" }
          ]
        },
        {
          id: "synthesis",
          runner: synthesis,
          prompt: ({ outputs }) => `Synthesize ${outputs.market} and ${outputs.legal}`,
          outputKey: "synthesis"
        }
      ]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(result.status).toBe("completed");
    expect(result.steps[0]?.children?.map((step) => step.id)).toEqual(["market", "legal"]);
    expect(result.outputs).toMatchObject({
      market: "market ok",
      legal: "legal ok",
      synthesis: "synthesis ok"
    });
    expect(seenPrompts[0]).toBe("Synthesize market ok and legal ok");
  });

  it("keeps all parallel child results when failFast is false", async () => {
    const ok = createTestRunner(createLanguageModel());
    const failing = createTestRunner(
      createLanguageModel({
        async generate() {
          throw new Error("parallel failed");
        }
      })
    );
    const workflow = createWorkflow({
      steps: [
        {
          id: "research",
          kind: "parallel",
          failFast: false,
          steps: [
            { id: "ok", runner: ok, prompt: "OK", outputKey: "ok" },
            { id: "fail", runner: failing, prompt: "Fail" }
          ]
        }
      ]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0]?.children?.map((step) => step.status)).toEqual(["completed", "failed"]);
    expect(result.outputs.ok).toBe("workflow output");
  });

  it("marks a parallel group failed when failFast is true", async () => {
    const failing = createTestRunner(
      createLanguageModel({
        async generate() {
          throw new Error("first failure");
        }
      })
    );
    const ok = createTestRunner(createLanguageModel());
    const workflow = createWorkflow({
      steps: [
        {
          id: "research",
          kind: "parallel",
          failFast: true,
          steps: [
            { id: "fail", runner: failing, prompt: "Fail" },
            { id: "ok", runner: ok, prompt: "OK" }
          ]
        }
      ]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({
      id: "research",
      status: "failed",
      error: { message: "first failure" }
    });
  });

  it("waits and resumes approval inside a parallel group", async () => {
    let approvalCalls = 0;
    let sawApprovalResponse = false;
    const approvalRunner = createTestRunner(
      createLanguageModel({
        async generate(input) {
          approvalCalls += 1;
          if (approvalCalls === 1) {
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
                        id: "mcpr_1",
                        arguments: "{}",
                        name: "fetch_docs"
                      }
                    }
                  ]
                }
              ],
              text: "Need approval",
              finishReason: "stop"
            };
          }

          sawApprovalResponse = input.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "provider-data" &&
                part.provider === "openai" &&
                (part.data as { type?: string }).type === "mcp_approval_response"
            )
          );
          return {
            messages: [createTextMessage("assistant", "approved child")],
            text: "approved child",
            finishReason: "stop"
          };
        }
      })
    );
    const stableRunner = createTestRunner(
      createLanguageModel({
        async generate() {
          return {
            messages: [createTextMessage("assistant", "stable child")],
            text: "stable child",
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      steps: [
        {
          id: "research",
          kind: "parallel",
          steps: [
            { id: "needs-approval", runner: approvalRunner, prompt: "Use MCP", outputKey: "approved" },
            { id: "stable", runner: stableRunner, prompt: "Stable", outputKey: "stable" }
          ]
        }
      ]
    });

    const waiting = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.outputs.stable).toBe("stable child");
    expect(waiting.steps[0]?.children?.map((step) => step.status)).toEqual(["waiting_approval", "completed"]);

    const resumed = await runWorkflow(workflow, {
      userId: "user_1",
      state: waiting.state,
      approvals: [{ provider: "openai", approvalRequestId: "mcpr_1", approve: true }]
    });

    expect(sawApprovalResponse).toBe(true);
    expect(resumed.status).toBe("completed");
    expect(resumed.outputs).toMatchObject({
      approved: "approved child",
      stable: "stable child"
    });
  });

  it("replays parallel workflow events without re-running models", async () => {
    let calls = 0;
    const runner = createTestRunner(
      createLanguageModel({
        async generate() {
          calls += 1;
          return {
            messages: [createTextMessage("assistant", `result ${calls}`)],
            text: `result ${calls}`,
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      steps: [
        {
          id: "parallel",
          kind: "parallel",
          steps: [
            { id: "one", runner, prompt: "One", outputKey: "one" },
            { id: "two", runner, prompt: "Two", outputKey: "two" }
          ]
        }
      ]
    });
    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    const replay = replayWorkflowRun(result.state);

    expect(calls).toBe(2);
    expect(replay.timeline.map((event) => event.type)).toEqual([
      "workflow-start",
      "parallel-start",
      "parallel-step-finish",
      "parallel-step-finish",
      "parallel-finish",
      "workflow-finish"
    ]);
  });

  it("runs loop steps until the condition is satisfied", async () => {
    let calls = 0;
    const runner = createTestRunner(
      createLanguageModel({
        async generate() {
          calls += 1;
          return {
            messages: [createTextMessage("assistant", `draft ${calls}`)],
            text: `draft ${calls}`,
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      steps: [
        {
          id: "rewrite-loop",
          kind: "loop",
          maxIterations: 5,
          step: {
            id: "rewrite",
            runner,
            prompt: ({ outputs }) => `Rewrite ${outputs.draft ?? "initial"}`,
            outputKey: "draft"
          },
          until: ({ outputs }) => outputs.draft === "draft 3"
        }
      ]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(result.status).toBe("completed");
    expect(calls).toBe(3);
    expect(result.outputs.draft).toBe("draft 3");
    expect(result.steps[0]).toMatchObject({
      id: "rewrite-loop",
      kind: "loop",
      status: "completed"
    });
    expect(result.steps[0]?.children?.map((step) => step.outputText)).toEqual(["draft 1", "draft 2", "draft 3"]);
  });

  it("completes loop steps when maxIterations is reached", async () => {
    let calls = 0;
    const runner = createTestRunner(
      createLanguageModel({
        async generate() {
          calls += 1;
          return {
            messages: [createTextMessage("assistant", `attempt ${calls}`)],
            text: `attempt ${calls}`,
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      steps: [
        {
          id: "limited-loop",
          kind: "loop",
          maxIterations: 2,
          step: { id: "attempt", runner, prompt: "Try again", outputKey: "attempt" },
          until: () => false
        },
        {
          id: "final",
          runner,
          prompt: ({ outputs }) => `Final ${outputs.attempt}`,
          outputKey: "final"
        }
      ]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(result.status).toBe("completed");
    expect(result.steps[0]?.children).toHaveLength(2);
    expect(result.outputs.attempt).toBe("attempt 2");
    expect(result.outputs.final).toBe("attempt 3");
  });

  it("waits and resumes approval inside a loop step", async () => {
    let calls = 0;
    let sawApprovalResponse = false;
    const runner = createTestRunner(
      createLanguageModel({
        async generate(input) {
          calls += 1;
          if (calls === 1) {
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
                        id: "mcpr_loop",
                        arguments: "{}",
                        name: "fetch_docs"
                      }
                    }
                  ]
                }
              ],
              text: "Need loop approval",
              finishReason: "stop"
            };
          }

          sawApprovalResponse = input.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "provider-data" &&
                part.provider === "openai" &&
                (part.data as { type?: string }).type === "mcp_approval_response"
            )
          );
          return {
            messages: [createTextMessage("assistant", "loop approved")],
            text: "loop approved",
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      steps: [
        {
          id: "approval-loop",
          kind: "loop",
          maxIterations: 2,
          step: { id: "approval-iteration", runner, prompt: "Use MCP", outputKey: "approved" },
          until: ({ outputs }) => outputs.approved === "loop approved"
        }
      ]
    });

    const waiting = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.steps[0]?.children?.[0]).toMatchObject({
      id: "approval-iteration",
      status: "waiting_approval"
    });

    const resumed = await runWorkflow(workflow, {
      userId: "user_1",
      state: waiting.state,
      approvals: [{ provider: "openai", approvalRequestId: "mcpr_loop", approve: true }]
    });

    expect(sawApprovalResponse).toBe(true);
    expect(resumed.status).toBe("completed");
    expect(resumed.outputs.approved).toBe("loop approved");
    expect(resumed.steps[0]?.children).toHaveLength(1);
  });

  it("stops loops on errors and marks the workflow failed", async () => {
    const runner = createTestRunner(
      createLanguageModel({
        async generate() {
          throw new Error("loop failed");
        }
      })
    );
    const workflow = createWorkflow({
      steps: [
        {
          id: "failing-loop",
          kind: "loop",
          maxIterations: 3,
          step: { id: "failing-iteration", runner, prompt: "Fail" }
        }
      ]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({
      id: "failing-loop",
      status: "failed",
      error: { message: "loop failed" }
    });
    expect(result.steps[0]?.children?.[0]).toMatchObject({
      id: "failing-iteration",
      status: "failed"
    });
  });

  it("replays loop workflow events without re-running models", async () => {
    let calls = 0;
    const runner = createTestRunner(
      createLanguageModel({
        async generate() {
          calls += 1;
          return {
            messages: [createTextMessage("assistant", `loop ${calls}`)],
            text: `loop ${calls}`,
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      steps: [
        {
          id: "loop",
          kind: "loop",
          maxIterations: 2,
          step: { id: "loop-child", runner, prompt: "Loop", outputKey: "loop" }
        }
      ]
    });
    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    const replay = replayWorkflowRun(result.state);

    expect(calls).toBe(2);
    expect(replay.timeline.map((event) => event.type)).toEqual([
      "workflow-start",
      "loop-start",
      "loop-iteration-finish",
      "loop-iteration-finish",
      "loop-finish",
      "workflow-finish"
    ]);
  });

  it("persists workflow state into session metadata", async () => {
    const sessionService = createInMemorySessionService();
    const runner = createTestRunnerWithSessionService(
      createLanguageModel({
        async generate() {
          return {
            messages: [createTextMessage("assistant", "persisted output")],
            text: "persisted output",
            finishReason: "stop"
          };
        }
      }),
      sessionService
    );
    const workflow = createWorkflow({
      id: "persisted-workflow",
      persistence: {
        appName: "workflow-test",
        sessionService
      },
      steps: [{ id: "persist", runner, prompt: "Persist", outputKey: "persisted" }]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });
    const persisted = await loadWorkflowState(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(result.session?.metadata?.workflowRuns).toBeDefined();
    expect(persisted).toMatchObject({
      runId: result.state.runId,
      status: "completed",
      outputs: { persisted: "persisted output" }
    });
    expect(persisted?.session).toBeDefined();
    expect((persisted as { session?: unknown }).session).toBeDefined();
    expect(JSON.stringify(result.session?.metadata?.workflowRuns)).not.toContain('"session"');
  });

  it("normalizes legacy workflow run state from session metadata and rejects future versions", async () => {
    const sessionService = createInMemorySessionService();
    const runner = createTestRunnerWithSessionService(createLanguageModel(), sessionService);
    const workflow = createWorkflow({
      id: "legacy-state",
      persistence: {
        appName: "workflow-test",
        sessionService
      },
      steps: [{ id: "step", runner, prompt: "Run" }]
    });
    await sessionService.createSession({
      appName: "workflow-test",
      userId: "user",
      sessionId: "session",
      metadata: {
        workflowRuns: {
          "legacy-state": {
            runId: "wfr_legacy",
            userId: "user",
            sessionId: "session",
            status: "completed",
            outputs: {},
            steps: [],
            currentStepIndex: 1,
            createdAt: 1,
            updatedAt: 2
          }
        }
      }
    });

    await expect(loadWorkflowState(workflow, {
      userId: "user",
      sessionId: "session"
    })).resolves.toMatchObject({
      schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION,
      runId: "wfr_legacy"
    });

    expect(() => normalizeWorkflowRunState({
      runId: "wfr_future",
      userId: "user",
      sessionId: "session",
      status: "completed",
      outputs: {},
      steps: [],
      currentStepIndex: 1,
      createdAt: 1,
      updatedAt: 2,
      schemaVersion: 999
    })).toThrow(ValidationError);
    expect(migrateWorkflowRunState({
      runId: "wfr_legacy",
      userId: "user",
      sessionId: "session",
      status: "completed",
      outputs: {},
      steps: [],
      currentStepIndex: 1,
      createdAt: 1,
      updatedAt: 2
    })).toMatchObject({ schemaVersion: WORKFLOW_RUN_STATE_SCHEMA_VERSION });
  });

  it("loads persisted workflow state from a reloaded file session service", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-workflow-state-"));
    const sessionService = createFileSessionService({ directory });
    const runner = createRunner({
      appName: "workflow-test",
      agent: createAgent({
        model: createLanguageModel({
          async generate() {
            return {
              messages: [createTextMessage("assistant", "file persisted")],
              text: "file persisted",
              finishReason: "stop"
            };
          }
        }),
        maxSteps: 3
      }),
      sessionService
    });
    const workflow = createWorkflow({
      id: "file-workflow",
      persistence: {
        appName: "workflow-test",
        sessionService
      },
      steps: [{ id: "persist", runner, prompt: "Persist", outputKey: "persisted" }]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });
    const reloadedSessionService = createFileSessionService({ directory });
    const reloadedWorkflow = createWorkflow({
      id: "file-workflow",
      persistence: {
        appName: "workflow-test",
        sessionService: reloadedSessionService
      },
      steps: [{ id: "persist", runner, prompt: "Persist", outputKey: "persisted" }]
    });

    const persisted = await loadWorkflowState(reloadedWorkflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(persisted).toMatchObject({
      runId: result.state.runId,
      outputs: { persisted: "file persisted" },
      status: "completed"
    });
  });

  it("resumes approval from persisted workflow state without passing state", async () => {
    const sessionService = createInMemorySessionService();
    let calls = 0;
    let sawApprovalResponse = false;
    const runner = createTestRunnerWithSessionService(
      createLanguageModel({
        async generate(input) {
          calls += 1;
          if (calls === 1) {
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
                        id: "mcpr_persisted",
                        arguments: "{}",
                        name: "fetch_docs"
                      }
                    }
                  ]
                }
              ],
              text: "Need persisted approval",
              finishReason: "stop"
            };
          }

          sawApprovalResponse = input.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.type === "provider-data" &&
                part.provider === "openai" &&
                (part.data as { type?: string }).type === "mcp_approval_response"
            )
          );
          return {
            messages: [createTextMessage("assistant", "persisted approved")],
            text: "persisted approved",
            finishReason: "stop"
          };
        }
      }),
      sessionService
    );
    const workflow = createWorkflow({
      id: "approval-persistence",
      persistence: {
        appName: "workflow-test",
        sessionService
      },
      steps: [{ id: "approval-step", runner, prompt: "Use MCP", outputKey: "result" }]
    });

    const waiting = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });

    expect(waiting.status).toBe("waiting_approval");

    const unchanged = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1",
      resumeFromPersistedState: true
    });
    expect(unchanged.status).toBe("waiting_approval");
    expect(calls).toBe(1);

    const resumed = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1",
      resumeFromPersistedState: true,
      approvals: [{ provider: "openai", approvalRequestId: "mcpr_persisted", approve: true }]
    });

    expect(sawApprovalResponse).toBe(true);
    expect(resumed.status).toBe("completed");
    expect(resumed.outputs.result).toBe("persisted approved");
  });

  it("allows manual workflow state saves", async () => {
    const sessionService = createInMemorySessionService();
    const runner = createTestRunnerWithSessionService(createLanguageModel(), sessionService);
    const workflow = createWorkflow({
      id: "manual-save",
      persistence: {
        appName: "workflow-test",
        sessionService
      },
      steps: [{ id: "step", runner, prompt: "Manual" }]
    });
    const result = await runWorkflow(workflow, {
      userId: "user_1",
      sessionId: "session_1"
    });
    const editedState = {
      ...result.state,
      outputs: { edited: "yes" }
    };

    await saveWorkflowState(workflow, editedState);

    await expect(
      loadWorkflowState(workflow, {
        userId: "user_1",
        sessionId: "session_1"
      })
    ).resolves.toMatchObject({
      outputs: { edited: "yes" }
    });
  });

  it("persists workflow state through WorkflowStateService when configured", async () => {
    const sessionService = createInMemorySessionService();
    const workflowStateService = createInMemoryWorkflowStateService();
    const runner = createTestRunnerWithSessionService(createLanguageModel(), sessionService);
    const workflow = createWorkflow({
      id: "state-service-workflow",
      persistence: {
        appName: "workflow-test",
        sessionService,
        workflowStateService
      },
      steps: [{ id: "step", runner, prompt: "Run", outputKey: "answer" }]
    });

    const result = await runWorkflow(workflow, {
      userId: "user",
      sessionId: "session"
    });

    expect(result.status).toBe("completed");
    const persisted = await loadWorkflowState(workflow, {
      userId: "user",
      sessionId: "session"
    });
    expect(persisted?.outputs.answer).toBe("workflow output");
    expect(result.session?.metadata?.workflowRuns).toBeUndefined();
    expect(result.session?.metadata?.workflowStateRefs).toMatchObject({
      "state-service-workflow": {
        runId: result.state.runId,
        status: "completed"
      }
    });
  });

  it("rejects invalid workflow definitions", () => {
    const runner = createTestRunner(createLanguageModel());
    expect(() => createWorkflow({ steps: [] })).toThrow("at least one step");
    expect(() =>
      createWorkflow({
        steps: [
          { id: "same", runner, prompt: "One" },
          { id: "same", runner, prompt: "Two" }
        ]
      })
    ).toThrow("duplicated");
    expect(() =>
      createWorkflow({
        steps: [
          {
            id: "parallel",
            kind: "parallel",
            steps: []
          }
        ]
      })
    ).toThrow("at least one child");
    expect(() =>
      createWorkflow({
        steps: [
          {
            id: "outer",
            kind: "parallel",
            steps: [
              {
                id: "inner",
                kind: "parallel",
                steps: [{ id: "child", runner, prompt: "Nope" }]
              } as never
            ]
          }
        ]
      })
    ).toThrow("Nested parallel");
    expect(() =>
      createWorkflow({
        steps: [
          {
            id: "loop",
            kind: "loop",
            maxIterations: 0,
            step: { id: "loop-child", runner, prompt: "Nope" }
          }
        ]
      })
    ).toThrow("positive integer maxIterations");
    expect(() =>
      createWorkflow({
        steps: [
          {
            id: "same",
            kind: "loop",
            maxIterations: 1,
            step: { id: "same", runner, prompt: "Nope" }
          }
        ]
      })
    ).toThrow("duplicated");
    expect(() =>
      createWorkflow({
        steps: [
          {
            id: "outer-loop",
            kind: "loop",
            maxIterations: 1,
            step: {
              id: "inner-loop",
              kind: "loop",
              maxIterations: 1,
              step: { id: "child", runner, prompt: "Nope" }
            } as never
          }
        ]
      })
    ).toThrow("Nested loop");
  });
});
