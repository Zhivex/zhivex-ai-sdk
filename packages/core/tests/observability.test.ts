import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAgent,
  createAgentTraceArtifact,
  createAgentTraceCollector,
  createOtelAgentObserver,
  createOtelObserver,
  createOtelTelemetryMiddleware,
  createProductionTraceCollector,
  createProductionTraceOptions,
  createTextMessage,
  defaultModelCatalog,
  estimateAgentRunCost,
  estimateTokenCost,
  generateText,
  summarizeAgentTrace,
  tool,
  wrapLanguageModel,
  type AgentRunState,
  type AgentTelemetryEvent,
  type LanguageModel,
  type OTelSpanLike,
  type OTelTracerLike
} from "../src/index.js";

class FakeSpan implements OTelSpanLike {
  readonly attributes: Record<string, unknown> = {};
  readonly events: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
  readonly exceptions: Error[] = [];
  status: unknown;
  ended = false;

  setAttribute(key: string, value: unknown) {
    this.attributes[key] = value;
  }

  addEvent(name: string, attributes?: Record<string, unknown>) {
    this.events.push({ name, attributes });
  }

  recordException(error: Error) {
    this.exceptions.push(error);
  }

  setStatus(status: unknown) {
    this.status = status;
  }

  end() {
    this.ended = true;
  }
}

class FakeTracer implements OTelTracerLike {
  readonly spans: Array<{ name: string; span: FakeSpan; attributes?: Record<string, unknown> }> = [];

  startSpan(name: string, options?: { attributes?: Record<string, unknown> }) {
    const span = new FakeSpan();
    for (const [key, value] of Object.entries(options?.attributes ?? {})) {
      span.setAttribute(key, value);
    }
    this.spans.push({ name, span, attributes: options?.attributes });
    return span;
  }
}

const createLanguageModel = (overrides?: Partial<LanguageModel>): LanguageModel => ({
  provider: "test",
  modelId: "model",
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
      messages: [createTextMessage("assistant", "hello world")],
      text: "hello world",
      finishReason: "stop"
    };
  },
  ...overrides
});

const baseRunState = (overrides: Partial<AgentRunState> = {}): AgentRunState => ({
  schemaVersion: 1,
  runId: "run_1",
  agentId: "assistant",
  provider: "openai",
  modelId: "gpt-4o-mini",
  status: "completed",
  messages: [createTextMessage("assistant", "Sunny in Madrid")],
  steps: [
    {
      index: 1,
      status: "completed",
      startedAt: 10,
      finishedAt: 25,
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
        finishReason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
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
      startedAt: 30,
      finishedAt: 50,
      request: {
        messages: [createTextMessage("tool", "sunny")]
      },
      response: {
        messages: [createTextMessage("assistant", "Sunny in Madrid")],
        text: "Sunny in Madrid",
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }
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
  usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
  pendingApprovals: [],
  startedAt: 10,
  updatedAt: 50,
  ...overrides
});

describe("otel observability", () => {
  it("creates dry trace artifacts from agent run state", () => {
    const trace = createAgentTraceArtifact(baseRunState(), {
      includeToolInputs: false
    });

    expect(trace).toMatchObject({
      runId: "run_1",
      agentId: "assistant",
      provider: "openai",
      modelId: "gpt-4o-mini",
      status: "completed",
      durationMs: 40,
      outputPreview: "Sunny in Madrid"
    });
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0]?.toolCalls).toEqual([{ id: "call_1", name: "weather" }]);
    expect(trace.steps[0]?.messages).toBeUndefined();
    expect(trace.events.some((event) => event.type === "tool-call")).toBe(true);
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
  });

  it("controls trace payload inclusion for messages and tool inputs", () => {
    const trace = createAgentTraceArtifact(baseRunState(), {
      includeMessages: true,
      includeToolInputs: true,
      outputPreviewLength: 5
    });

    expect(trace.outputPreview).toBe("Sunny...");
    expect(trace.steps[0]?.messages?.[0]?.role).toBe("assistant");
    expect(trace.steps[0]?.toolCalls).toEqual([
      {
        id: "call_1",
        name: "weather",
        input: { city: "Madrid" }
      }
    ]);
  });

  it("represents failed suspended and cancelled trace artifacts", () => {
    const failed = createAgentTraceArtifact(baseRunState({
      status: "failed",
      error: { message: "Guardrail blocked output." }
    }));
    const suspended = createAgentTraceArtifact(baseRunState({
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
    }));
    const cancelled = createAgentTraceArtifact(baseRunState({
      status: "cancelled",
      cancellationReason: "User cancelled."
    }));

    expect(failed.error?.message).toBe("Guardrail blocked output.");
    expect(suspended.approvals).toHaveLength(1);
    expect(cancelled.cancellationReason).toBe("User cancelled.");
  });

  it("estimates token costs and summarizes trace latency", () => {
    const trace = createAgentTraceArtifact(baseRunState());

    expect(estimateTokenCost(trace.usage, {
      inputCostPer1kTokens: 1,
      outputCostPer1kTokens: 2,
      currency: "USD"
    })).toEqual({
      inputCost: 0.03,
      outputCost: 0.03,
      totalCost: 0.06,
      currency: "USD",
      usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 }
    });
    expect(estimateAgentRunCost(baseRunState(), defaultModelCatalog).totalCost).toBeCloseTo(0.000027);

    const summary = summarizeAgentTrace(trace, {
      pricing: { costPer1kTokens: 1 }
    });

    expect(summary).toMatchObject({
      runId: "run_1",
      status: "completed",
      latency: { durationMs: 40 },
      steps: 2,
      toolCalls: 1,
      toolErrors: 0,
      approvals: 0
    });
    expect(summary.cost?.totalCost).toBe(0.045);
    expect(estimateTokenCost(undefined)).toEqual({ usage: undefined });
  });

  it("collects live agent telemetry into trace artifacts", async () => {
    const collector = createAgentTraceCollector({
      includeToolInputs: true
    });
    const state = baseRunState();
    const events: AgentTelemetryEvent[] = [
      {
        type: "run-start",
        runId: "run_1",
        agentId: "assistant",
        provider: "openai",
        modelId: "gpt-4o-mini",
        maxSteps: 4
      },
      {
        type: "step-start",
        runId: "run_1",
        agentId: "assistant",
        stepIndex: 1
      },
      {
        type: "run-finish",
        runId: "run_1",
        agentId: "assistant",
        status: "completed",
        state
      },
      {
        type: "run-start",
        runId: "run_2",
        provider: "test",
        modelId: "model",
        maxSteps: 1
      },
      {
        type: "run-finish",
        runId: "run_2",
        status: "failed",
        state: baseRunState({
          runId: "run_2",
          agentId: undefined,
          provider: "test",
          modelId: "model",
          status: "failed",
          error: { message: "failed" }
        })
      }
    ];

    for (const event of events) {
      await collector.observer(event);
    }

    expect(collector.getEvents("run_1").map((event) => event.type)).toEqual(["run-start", "step-start", "run-finish"]);
    const runOneTrace = collector.getTrace("run_1");
    expect(runOneTrace).toMatchObject({
      runId: "run_1",
      status: "completed"
    });
    expect(runOneTrace?.steps[0]?.toolCalls).toEqual([
      { id: "call_1", name: "weather", input: { city: "Madrid" } }
    ]);
    expect(collector.getTrace()?.runId).toBe("run_2");

    collector.reset("run_2");
    expect(collector.getTrace("run_2")).toBeUndefined();
    expect(collector.getTrace("run_1")?.runId).toBe("run_1");
    collector.reset();
    expect(collector.getEvents()).toEqual([]);
  });

  it("creates production trace options and collectors with overridable defaults", async () => {
    expect(createProductionTraceOptions()).toEqual({
      includeMessages: false,
      includeToolInputs: false,
      outputPreviewLength: 500
    });
    expect(createProductionTraceOptions({ includeToolInputs: true, outputPreviewLength: 120 })).toEqual({
      includeMessages: false,
      includeToolInputs: true,
      outputPreviewLength: 120
    });

    const collector = createProductionTraceCollector({ includeToolInputs: true });
    await collector.observer({
      type: "run-finish",
      runId: "run_1",
      agentId: "assistant",
      status: "completed",
      state: baseRunState()
    });

    expect(collector.getTrace("run_1")?.steps[0]?.toolCalls).toEqual([
      { id: "call_1", name: "weather", input: { city: "Madrid" } }
    ]);
    expect(collector.getTrace("run_1")?.steps[0]?.messages).toBeUndefined();
  });

  it("creates low-level span handles from a tracer", async () => {
    const tracer = new FakeTracer();
    const observer = await createOtelObserver({
      tracer
    });

    const handle = observer.startSpan("demo", {
      "zhivex.agent_id": "assistant"
    });
    await handle.end({
      attributes: {
        "zhivex.status": "completed"
      }
    });

    expect(tracer.spans[0]?.name).toBe("demo");
    expect(tracer.spans[0]?.span.attributes["zhivex.agent_id"]).toBe("assistant");
    expect(tracer.spans[0]?.span.attributes["zhivex.status"]).toBe("completed");
    expect(tracer.spans[0]?.span.ended).toBe(true);
  });

  it("maps agent telemetry into OTEL spans and events", async () => {
    const tracer = new FakeTracer();
    const observer = await createOtelAgentObserver({
      tracer
    });

    const events: AgentTelemetryEvent[] = [
      {
        type: "run-start",
        runId: "run_1",
        agentId: "assistant",
        provider: "openai",
        modelId: "gpt-5",
        maxSteps: 4
      },
      {
        type: "memory-loaded",
        runId: "run_1",
        agentId: "assistant",
        messageCount: 2
      },
      {
        type: "step-start",
        runId: "run_1",
        agentId: "assistant",
        stepIndex: 1
      },
      {
        type: "step-finish",
        runId: "run_1",
        agentId: "assistant",
        step: {
          index: 1,
          status: "completed",
          request: { messages: [] },
          response: { messages: [], text: "hello" },
          toolResults: []
        }
      },
      {
        type: "tool-approval",
        runId: "run_1",
        agentId: "assistant",
        toolCall: {
          id: "call_1",
          name: "shell",
          input: { cmd: "pwd" }
        },
        approved: false,
        reason: "Denied"
      },
      {
        type: "run-finish",
        runId: "run_1",
        agentId: "assistant",
        status: "completed",
        state: {
          runId: "run_1",
          agentId: "assistant",
          provider: "openai",
          modelId: "gpt-5",
          status: "completed",
          messages: [],
          steps: [],
          toolResults: [],
          currentStep: 1,
          maxSteps: 4,
          outputText: "hello",
          pendingApprovals: []
        }
      }
    ];

    for (const event of events) {
      await observer(event);
    }

    expect(tracer.spans.map((entry) => entry.name)).toEqual(["zhivex.agent.run", "zhivex.agent.step"]);
    expect(tracer.spans[0]?.span.events.some((entry) => entry.name === "memory-loaded")).toBe(true);
    expect(tracer.spans[0]?.span.events.some((entry) => entry.name === "tool-approval")).toBe(true);
    expect(tracer.spans[0]?.span.ended).toBe(true);
    expect(tracer.spans[1]?.span.ended).toBe(true);
  });

  it("creates OTEL middleware for model and tool spans", async () => {
    let callCount = 0;
    const tracer = new FakeTracer();
    const middleware = await createOtelTelemetryMiddleware({
      tracer
    });

    const model = wrapLanguageModel(
      createLanguageModel({
        async generate() {
          callCount += 1;
          if (callCount === 1) {
            return {
              messages: [
                {
                  role: "assistant",
                  parts: [
                    {
                      type: "tool-call",
                      toolCall: {
                        id: "tool_1",
                        name: "weather",
                        input: { city: "Madrid" }
                      }
                    }
                  ]
                }
              ],
              finishReason: "tool-calls"
            };
          }

          return {
            messages: [createTextMessage("assistant", "sunny")],
            text: "sunny",
            finishReason: "stop"
          };
        }
      }),
      [middleware]
    );

    const result = await generateText({
      model,
      prompt: "Weather?",
      maxSteps: 2,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      }
    });

    expect(result.text).toBe("sunny");
    expect(tracer.spans.some((entry) => entry.name === "zhivex.model.generate")).toBe(true);
    expect(tracer.spans.some((entry) => entry.name === "zhivex.model.tool")).toBe(true);
    expect(tracer.spans.every((entry) => entry.span.ended)).toBe(true);
  });
});
