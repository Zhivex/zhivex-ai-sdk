import { describe, expect, it } from "vitest";

import {
  createAgent,
  createInMemorySessionService,
  createRunner,
  createTextMessage,
  createWorkflow,
  createWorkflowEvaluationFixture,
  createWorkflowEvaluationReport,
  judgeWorkflowEvaluation,
  runWorkflowEvaluation,
  runWorkflowEvaluationFixture,
  type LanguageModel,
  type StreamEvent
} from "../src/index.js";

const createLanguageModel = (text: string): LanguageModel => ({
  provider: "test",
  modelId: "workflow-eval-model",
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
      messages: [createTextMessage("assistant", text)],
      text,
      finishReason: "stop"
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: text };
      yield { type: "finish", finishReason: "stop" };
    })();
  }
});

const createTestRunner = (model: LanguageModel) =>
  createRunner({
    appName: "workflow-evaluation-test",
    agent: createAgent({ model, maxSteps: 3 }),
    sessionService: createInMemorySessionService()
  });

describe("workflow evaluations", () => {
  it("runs workflow evaluation datasets with deterministic expectations", async () => {
    const runner = createTestRunner(createLanguageModel("approved answer"));
    const workflow = createWorkflow({
      steps: [{ id: "answer", runner, prompt: "Answer", outputKey: "answer" }]
    });

    const result = await runWorkflowEvaluation(
      [
        {
          name: "answer-case",
          input: { userId: "user_1", sessionId: "session_1" },
          expectations: {
            status: "completed",
            outputs: { answer: "approved answer" },
            outputContains: { answer: "approved" },
            stepStatuses: { answer: "completed" },
            stepOutputContains: { answer: "answer" },
            timelineContains: ["workflow-start", "step-finish", "workflow-finish"]
          }
        }
      ],
      { workflow }
    );

    expect(result.ok).toBe(true);
    expect(result.cases[0]?.failures).toEqual([]);
  });

  it("reports failing workflow expectations with clear messages", async () => {
    const runner = createTestRunner(createLanguageModel("actual answer"));
    const workflow = createWorkflow({
      steps: [{ id: "answer", runner, prompt: "Answer", outputKey: "answer" }]
    });

    const result = await runWorkflowEvaluation(
      [
        {
          name: "failing-case",
          input: { userId: "user_1", sessionId: "session_1" },
          expectations: {
            status: "failed",
            outputs: { answer: "expected answer" },
            outputContains: ["missing text"],
            stepStatuses: { missing: "completed" }
          }
        }
      ],
      { workflow }
    );

    expect(result.ok).toBe(false);
    expect(result.cases[0]?.failures).toEqual([
      'Expected status "failed", received "completed".',
      'Expected output "answer" to equal "expected answer".',
      'Expected serialized outputs to contain "missing text".',
      'Expected step "missing".'
    ]);
  });

  it("runs serializable workflow evaluation fixtures", async () => {
    const runner = createTestRunner(createLanguageModel("fixture ok"));
    const workflow = createWorkflow({
      steps: [{ id: "fixture-step", runner, prompt: "Fixture", outputKey: "fixture" }]
    });
    const fixture = createWorkflowEvaluationFixture({
      name: "workflow-fixture",
      expectedOk: true,
      dataset: [
        {
          name: "fixture-case",
          input: { userId: "user_1", sessionId: "session_1" },
          expectations: { outputContains: { fixture: "ok" } }
        }
      ]
    });

    const result = await runWorkflowEvaluationFixture(fixture, { workflow });

    expect(result.ok).toBe(true);
    expect(fixture.createdAt).toEqual(expect.any(Number));
  });

  it("creates workflow evaluation reports with counts and failures", async () => {
    const result = {
      ok: false,
      cases: [
        {
          name: "passing",
          ok: true,
          failures: [],
          output: {
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
            state: {
              runId: "wfr_1",
              userId: "user_1",
              sessionId: "session_1",
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
              updatedAt: 4
            }
          },
          metadata: { group: "ok" }
        },
        {
          name: "failing",
          ok: false,
          failures: ["Expected output."],
          output: {
            status: "failed",
            outputs: {},
            steps: [
              {
                id: "broken",
                kind: "task",
                status: "failed",
                error: { message: "broken" }
              }
            ],
            state: {
              runId: "wfr_2",
              userId: "user_1",
              sessionId: "session_2",
              status: "failed",
              outputs: {},
              steps: [
                {
                  id: "broken",
                  kind: "task",
                  status: "failed",
                  error: { message: "broken" }
                }
              ],
              currentStepIndex: 0,
              createdAt: 2,
              updatedAt: 5
            }
          }
        }
      ]
    } as Awaited<ReturnType<typeof runWorkflowEvaluation>>;

    const report = createWorkflowEvaluationReport(result, {
      judge: { score: 0.5, feedback: "mixed" }
    });

    expect(report).toMatchObject({
      ok: false,
      total: 2,
      passed: 1,
      failed: 1,
      passRate: 0.5,
      statusCounts: { completed: 1, failed: 1 },
      stepCount: 2,
      stepStatusCounts: { completed: 1, failed: 1 },
      timelineEventCounts: {
        "workflow-start": 2,
        "step-start": 2,
        "step-finish": 2,
        "workflow-finish": 2
      },
      failures: [{ name: "failing", failures: ["Expected output."] }],
      judge: { score: 0.5, feedback: "mixed" }
    });
    expect(report.cases[0]).toMatchObject({
      name: "passing",
      outputKeys: ["answer"],
      durationMs: 3
    });
  });

  it("judges workflow evaluation results with deterministic and model judges", async () => {
    const runner = createTestRunner(createLanguageModel("done"));
    const workflow = createWorkflow({
      steps: [{ id: "done", runner, prompt: "Done", outputKey: "done" }]
    });
    const evaluation = await runWorkflowEvaluation(
      [
        {
          name: "done-case",
          input: { userId: "user_1", sessionId: "session_1" },
          expectations: { outputs: { done: "done" } }
        }
      ],
      { workflow }
    );

    await expect(
      judgeWorkflowEvaluation(evaluation, (result) => ({
        score: result.ok ? 1 : 0,
        feedback: "deterministic"
      }))
    ).resolves.toEqual({ score: 1, feedback: "deterministic" });

    const modelJudge = createLanguageModel("{\"score\":0.75,\"feedback\":\"model ok\"}");

    await expect(judgeWorkflowEvaluation(evaluation, { model: modelJudge })).resolves.toEqual({
      score: 0.75,
      feedback: "model ok"
    });
  });

  it("exports workflow evaluation APIs from the public index", async () => {
    const api = await import("../src/index.js");

    expect(api.createWorkflowEvaluationFixture).toBeTypeOf("function");
    expect(api.createWorkflowEvaluationReport).toBeTypeOf("function");
    expect(api.judgeWorkflowEvaluation).toBeTypeOf("function");
    expect(api.runWorkflowEvaluation).toBeTypeOf("function");
    expect(api.runWorkflowEvaluationFixture).toBeTypeOf("function");
  });
});
