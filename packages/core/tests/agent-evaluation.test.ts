import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAgent,
  createAgentEvaluationFixture,
  createAgentEvaluationReport,
  createAgentRunSnapshot,
  createMockLanguageModel,
  createMockTool,
  createTextMessage,
  judgeAgentEvaluation,
  replayAgentRun,
  runAgent,
  runAgentEvaluation,
  runAgentEvaluationFixture,
  tool,
  type AgentRunState
} from "../src/index.js";

const baseState = (overrides: Partial<AgentRunState> = {}): AgentRunState => ({
  schemaVersion: 1,
  runId: "run_1",
  agentId: "agent_1",
  provider: "test",
  modelId: "model",
  status: "completed",
  messages: [createTextMessage("assistant", "Sunny in Madrid")],
  steps: [
    {
      index: 1,
      status: "completed",
      startedAt: 1,
      finishedAt: 2,
      request: {
        messages: [createTextMessage("user", "Weather?")]
      },
      response: {
        messages: [
          {
            role: "assistant",
            parts: [
              {
                type: "tool-call",
                toolCall: {
                  id: "call_1",
                  name: "weather",
                  input: { city: "Madrid" }
                }
              }
            ]
          }
        ],
        finishReason: "tool-calls"
      },
      toolResults: [
        {
          toolCallId: "call_1",
          toolName: "weather",
          output: { forecast: "sunny" },
          isError: false
        }
      ]
    },
    {
      index: 2,
      status: "completed",
      startedAt: 3,
      finishedAt: 4,
      request: {
        messages: [createTextMessage("tool", "sunny")]
      },
      response: {
        messages: [createTextMessage("assistant", "Sunny in Madrid")],
        text: "Sunny in Madrid",
        finishReason: "stop"
      },
      toolResults: []
    }
  ],
  toolResults: [
    {
      toolCallId: "call_1",
      toolName: "weather",
      output: { forecast: "sunny" },
      isError: false
    }
  ],
  currentStep: 2,
  maxSteps: 4,
  outputText: "Sunny in Madrid",
  finishReason: "stop",
  pendingApprovals: [],
  startedAt: 1,
  updatedAt: 4,
  ...overrides
});

describe("agent replay and evaluation helpers", () => {
  it("creates portable snapshots for completed runs", () => {
    const snapshot = createAgentRunSnapshot(baseState());

    expect(snapshot).toMatchObject({
      runId: "run_1",
      agentId: "agent_1",
      status: "completed",
      provider: "test",
      modelId: "model",
      steps: 2,
      outputText: "Sunny in Madrid"
    });
    expect(snapshot.toolCalls).toEqual([
      {
        id: "call_1",
        name: "weather",
        input: { city: "Madrid" }
      }
    ]);
  });

  it("dry replays failed, suspended, and cancelled runs without executing effects", () => {
    const suspended = baseState({
      status: "suspended",
      pendingApprovals: [
        {
          provider: "openai",
          id: "approval_1",
          name: "remote_search",
          arguments: "{}",
          rawData: { type: "mcp_approval_request" }
        }
      ]
    });
    const failed = baseState({
      status: "failed",
      error: { message: "Guardrail blocked output." }
    });
    const cancelled = baseState({
      status: "cancelled",
      cancellationReason: "User cancelled."
    });

    expect(replayAgentRun(suspended).timeline.some((event) => event.type === "approval-request")).toBe(true);
    expect(replayAgentRun(failed).timeline.at(-1)).toMatchObject({
      type: "run-finish",
      status: "failed",
      error: { message: "Guardrail blocked output." }
    });
    expect(replayAgentRun(cancelled).timeline.at(-1)).toMatchObject({
      type: "run-finish",
      status: "cancelled",
      cancellationReason: "User cancelled."
    });
  });

  it("creates sequential mock language models and fails when exhausted", async () => {
    const model = createMockLanguageModel({
      responses: [
        {
          messages: [createTextMessage("assistant", "first")],
          text: "first",
          finishReason: "stop"
        }
      ],
      streamEvents: [[{ type: "text-delta", textDelta: "stream" }, { type: "finish", finishReason: "stop" }]]
    });

    await expect(model.generate({ messages: [] })).resolves.toMatchObject({ text: "first" });
    await expect(model.generate({ messages: [] })).rejects.toThrow("no remaining generate responses");

    const stream = await model.stream?.({ messages: [] });
    const events = [];
    for await (const event of stream!) {
      events.push(event.type);
    }
    expect(events).toEqual(["text-delta", "finish"]);
  });

  it("creates deterministic mock tools", async () => {
    const mock = createMockTool(
      {
        name: "lookup",
        schema: z.object({ city: z.string() })
      },
      {
        outputs: [{ forecast: "sunny" }],
        errors: ["temporary failure"]
      }
    );

    await expect(mock.execute({ city: "Madrid" })).rejects.toThrow("temporary failure");
    await expect(mock.execute({ city: "Madrid" })).resolves.toEqual({ forecast: "sunny" });
    await expect(mock.execute({ city: "Madrid" })).rejects.toThrow("no remaining outputs");
  });

  it("runs agent evaluation datasets with deterministic expectations", async () => {
    const model = createMockLanguageModel({
      responses: [
        {
          messages: [
            {
              role: "assistant",
              parts: [
                {
                  type: "tool-call",
                  toolCall: {
                    id: "call_1",
                    name: "weather",
                    input: { city: "Madrid" }
                  }
                }
              ]
            }
          ],
          finishReason: "tool-calls"
        },
        {
          messages: [createTextMessage("assistant", "Sunny in Madrid")],
          text: "Sunny in Madrid",
          finishReason: "stop"
        },
        {
          messages: [createTextMessage("assistant", "Wrong city")],
          text: "Wrong city",
          finishReason: "stop"
        }
      ]
    });
    const agent = createAgent({
      model,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      },
      maxSteps: 2
    });

    const result = await runAgentEvaluation(
      [
        {
          name: "weather",
          input: { prompt: "Weather in Madrid?" },
          expectations: {
            status: "completed",
            outputContains: "Madrid",
            toolCalls: ["weather"],
            finishReason: "stop"
          }
        },
        {
          name: "failing-output",
          input: { prompt: "Weather in Barcelona?" },
          expectations: {
            outputContains: "Barcelona"
          }
        }
      ],
      { agent }
    );

    expect(result.ok).toBe(false);
    expect(result.cases[0]?.ok).toBe(true);
    expect(result.cases[1]?.failures[0]).toContain("Barcelona");
  });

  it("evaluates child run expectations for multi-agent workflows", async () => {
    const child = createAgent({
      id: "researcher",
      model: createMockLanguageModel({
        responses: [
          {
            messages: [createTextMessage("assistant", "child research output")],
            text: "child research output",
            finishReason: "stop"
          }
        ]
      })
    });
    const parent = createAgent({
      model: createMockLanguageModel({
        responses: [
          {
            messages: [
              {
                role: "assistant",
                parts: [
                  {
                    type: "tool-call",
                    toolCall: {
                      id: "call_1",
                      name: "research",
                      input: { prompt: "research" }
                    }
                  }
                ]
              }
            ],
            finishReason: "tool-calls"
          },
          {
            messages: [createTextMessage("assistant", "parent done")],
            text: "parent done",
            finishReason: "stop"
          }
        ]
      }),
      subagents: [{ name: "research", agent: child }],
      maxSteps: 2
    });

    const result = await runAgentEvaluation(
      [
        {
          name: "multi-agent-pass",
          input: { prompt: "run" },
          expectations: {
            childRunCount: 1,
            childAgents: ["researcher"],
            childStatuses: ["completed"],
            childOutputContains: ["research output"],
            childToolNames: ["research"]
          }
        }
      ],
      { agent: parent }
    );

    expect(result.ok).toBe(true);
  });

  it("reports child run metrics in evaluation reports", () => {
    const result = {
      ok: true,
      cases: [
        {
          name: "case",
          ok: true,
          failures: [],
          output: {
            status: "completed",
            outputText: "ok",
            messages: [],
            steps: [],
            toolResults: [],
            state: baseState({
              childRuns: [
                {
                  runId: "child",
                  agentId: "researcher",
                  parentRunId: "run_1",
                  toolName: "research",
                  status: "completed",
                  outputText: "child ok",
                  steps: 1,
                  toolCalls: 0,
                  toolErrors: 0
                }
              ]
            })
          }
        }
      ]
    } as Awaited<ReturnType<typeof runAgentEvaluation>>;

    const report = createAgentEvaluationReport(result);

    expect(report.childRunCount).toBe(1);
    expect(report.childAgentCounts).toEqual({ researcher: 1 });
    expect(report.childStatusCounts).toEqual({ completed: 1 });
    expect(report.cases[0]).toMatchObject({
      childRunCount: 1,
      childAgents: ["researcher"],
      childStatuses: ["completed"]
    });
  });

  it("judges evaluation results with deterministic and model judges", async () => {
    const agent = createAgent({
      model: createMockLanguageModel({
        responses: [
          {
            messages: [createTextMessage("assistant", "done")],
            text: "done",
            finishReason: "stop"
          }
        ]
      })
    });
    const evaluation = await runAgentEvaluation(
      [
        {
          name: "done",
          input: { prompt: "Finish" },
          expectations: { outputEquals: "done" }
        }
      ],
      { agent }
    );

    await expect(
      judgeAgentEvaluation(evaluation, (result) => ({
        score: result.ok ? 1 : 0,
        feedback: "deterministic"
      }))
    ).resolves.toEqual({ score: 1, feedback: "deterministic" });

    const modelJudge = createMockLanguageModel({
      responses: [
        {
          messages: [createTextMessage("assistant", '{"score":0.8,"feedback":"good"}')],
          text: '{"score":0.8,"feedback":"good"}',
          finishReason: "stop"
        }
      ]
    });

    await expect(judgeAgentEvaluation(evaluation, { model: modelJudge })).resolves.toEqual({
      score: 0.8,
      feedback: "good"
    });
  });

  it("supports evaluation agent factories", async () => {
    const result = await runAgentEvaluation(
      [
        {
          name: "factory",
          input: { prompt: "Run" },
          expectations: { status: "completed" }
        }
      ],
      {
        agent: () =>
          createAgent({
            model: createMockLanguageModel({
              responses: [
                {
                  messages: [createTextMessage("assistant", "factory ok")],
                  text: "factory ok",
                  finishReason: "stop"
                }
              ]
            })
          })
      }
    );

    expect(result.ok).toBe(true);
  });

  it("creates and runs evaluation fixtures with serializable reports", async () => {
    const fixture = createAgentEvaluationFixture({
      name: "regression",
      createdAt: 1,
      expectedOk: false,
      metadata: { suite: "smoke" },
      dataset: [
        {
          name: "pass",
          input: { prompt: "Pass" },
          expectations: { outputEquals: "done", status: "completed" },
          metadata: { area: "happy-path" }
        },
        {
          name: "fail",
          input: { prompt: "Fail" },
          expectations: { outputContains: "missing" }
        }
      ]
    });
    const agent = createAgent({
      model: createMockLanguageModel({
        responses: [
          {
            messages: [createTextMessage("assistant", "done")],
            text: "done",
            finishReason: "stop"
          },
          {
            messages: [createTextMessage("assistant", "wrong")],
            text: "wrong",
            finishReason: "stop"
          }
        ]
      })
    });

    const result = await runAgentEvaluationFixture(fixture, { agent });
    const report = createAgentEvaluationReport(result, {
      judge: { score: 0.5, feedback: "mixed" },
      metadata: { build: "local" },
      outputPreviewLength: 3
    });

    expect(fixture).toMatchObject({
      name: "regression",
      expectedOk: false,
      metadata: { suite: "smoke" },
      createdAt: 1
    });
    expect(result.ok).toBe(false);
    expect(report).toMatchObject({
      ok: false,
      total: 2,
      passed: 1,
      failed: 1,
      passRate: 0.5,
      statusCounts: { completed: 2 },
      toolCallCounts: {},
      judge: { score: 0.5, feedback: "mixed" },
      metadata: { build: "local" }
    });
    expect(report.cases[0]).toMatchObject({
      name: "pass",
      ok: true,
      status: "completed",
      outputPreview: "don..."
    });
    expect(report.failures).toEqual([
      {
        name: "fail",
        failures: ['Expected output to contain "missing".']
      }
    ]);
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("reports tool call counts in evaluation reports", async () => {
    const model = createMockLanguageModel({
      responses: [
        {
          messages: [
            {
              role: "assistant",
              parts: [
                {
                  type: "tool-call",
                  toolCall: {
                    id: "call_1",
                    name: "weather",
                    input: { city: "Madrid" }
                  }
                }
              ]
            }
          ],
          finishReason: "tool-calls"
        },
        {
          messages: [createTextMessage("assistant", "Sunny")],
          text: "Sunny",
          finishReason: "stop"
        }
      ]
    });
    const agent = createAgent({
      model,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      },
      maxSteps: 2
    });

    const result = await runAgentEvaluationFixture(
      createAgentEvaluationFixture({
        dataset: [
          {
            name: "weather",
            input: { prompt: "Weather?" },
            expectations: { toolCalls: ["weather"] }
          }
        ],
        createdAt: 1
      }),
      { agent }
    );
    const report = createAgentEvaluationReport(result);

    expect(report.toolCallCounts).toEqual({ weather: 1 });
    expect(report.cases[0]?.toolCalls).toEqual(["weather"]);
    expect(report.cases[0]?.toolCallCount).toBe(1);
  });
});
