import { AsyncLocalStorage } from "node:async_hooks";

import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  type Context,
  type ContextManager
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData
} from "@opentelemetry/sdk-metrics";
import { describe, expect, it, vi } from "vitest";
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
  createTelemetryMiddleware,
  createTextMessage,
  defaultModelCatalog,
  estimateAgentRunCost,
  estimateTokenCost,
  generateText,
  runAgent,
  streamAgent,
  summarizeAgentTrace,
  tool,
  wrapLanguageModel,
  type AgentRunState,
  type AgentTelemetryEvent,
  type AgentTelemetryObserver,
  type LanguageModel,
  type LanguageModelTelemetryEvent,
  type OTelMeterLike,
  type OTelSpanLike,
  type OTelTracerLike
} from "../src/index.js";
import {
  OTEL_GENAI_CONTRACT_VERSION,
  OTEL_GENAI_SEMCONV_REVISION
} from "../src/observability.js";

class FakeSpan implements OTelSpanLike {
  readonly attributes: Record<string, unknown> = {};
  readonly events: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
  readonly exceptions: Error[] = [];
  status: unknown;
  ended = false;
  endCount = 0;

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
    this.endCount += 1;
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

const createMetricSdk = () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000
  });
  const provider = new MeterProvider({ readers: [reader] });
  return { exporter, provider };
};

const findMetric = (exporter: InMemoryMetricExporter, name: string): MetricData | undefined =>
  exporter.getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === name);

const histogramPoint = (metric: MetricData | undefined, index = 0) => {
  const point = metric?.dataPoints[index];
  return point as typeof point & {
    value: { count: number; sum?: number; buckets?: { boundaries: number[] } };
  };
};

type HistogramPoint = ReturnType<typeof histogramPoint> & {
  attributes: Record<string, unknown>;
};

const histogramPoints = (metric: MetricData | undefined): HistogramPoint[] =>
  (metric?.dataPoints ?? []) as HistogramPoint[];

const findHistogramPoint = (
  metric: MetricData | undefined,
  attributes: Record<string, unknown>
): HistogramPoint | undefined => histogramPoints(metric).find((point) =>
  Object.entries(attributes).every(([key, value]) => point.attributes[key] === value)
);

const spanDurationSeconds = (duration: readonly [number, number]) =>
  duration[0] + duration[1] / 1_000_000_000;

class AsyncLocalTestContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(activeContext, () => fn.call(thisArg, ...args));
  }

  bind<T>(_activeContext: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

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
        agentName: "Assistant",
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
      includeToolOutputs: false,
      includeApprovalArguments: false,
      includeOutputText: false,
      outputPreviewLength: 500,
      redaction: { includeEmails: true }
    });
    expect(createProductionTraceOptions({ includeToolInputs: true, outputPreviewLength: 120 })).toEqual({
      includeMessages: false,
      includeToolInputs: true,
      includeToolOutputs: false,
      includeApprovalArguments: false,
      includeOutputText: false,
      outputPreviewLength: 120,
      redaction: { includeEmails: true }
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

  it("bounds trace collector runs, events, and retention", async () => {
    let now = 1_000;
    const collector = createAgentTraceCollector({
      maxRuns: 2,
      maxEventsPerRun: 2,
      retentionMs: 100,
      now: () => now
    });
    const start = (runId: string): AgentTelemetryEvent => ({
      type: "run-start",
      runId,
      provider: "test",
      modelId: "model",
      maxSteps: 1
    });

    await collector.observer(start("run_1"));
    await collector.observer(start("run_1"));
    await collector.observer(start("run_1"));
    expect(collector.getEvents("run_1")).toHaveLength(2);
    await collector.observer(start("run_2"));
    await collector.observer(start("run_3"));
    expect(collector.getEvents("run_1")).toEqual([]);

    now += 101;
    expect(collector.getEvents()).toEqual([]);
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
        agentName: "Assistant",
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

    expect(tracer.spans.map((entry) => entry.name)).toEqual(["invoke_agent Assistant", "agent_step"]);
    expect(tracer.spans[0]?.span.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "Assistant",
      "gen_ai.request.model": "gpt-5",
      "zhivex.agent_id": "assistant",
      "zhivex.run_id": "run_1"
    });
    expect(tracer.spans[0]?.span.attributes["gen_ai.agent.id"]).toBeUndefined();
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
            finishReason: "stop",
            usage: {
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25
            }
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
    const modelSpans = tracer.spans.filter((entry) => entry.name === "chat model");
    const toolSpan = tracer.spans.find((entry) => entry.name === "execute_tool weather");
    expect(modelSpans).toHaveLength(2);
    expect(toolSpan?.span.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "weather",
      "gen_ai.tool.call.id": "tool_1",
      "gen_ai.tool.type": "function"
    });
    expect(modelSpans[1]?.span.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "test",
      "gen_ai.request.model": "model",
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.usage.input_tokens": 20,
      "gen_ai.usage.output_tokens": 5
    });
    expect(tracer.spans.every((entry) => entry.span.ended)).toBe(true);
  });

  it("fails open when OTEL span creation throws for generate and stream", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    const middleware = await createOtelTelemetryMiddleware({
      tracer: {
        startSpan() {
          throw new Error("tracer start failed");
        }
      }
    });
    const model = wrapLanguageModel(createLanguageModel({
      async generate() {
        generateCalls += 1;
        return {
          messages: [createTextMessage("assistant", "generated")],
          text: "generated",
          finishReason: "stop"
        };
      },
      async stream() {
        streamCalls += 1;
        return (async function* () {
          yield { type: "text-delta" as const, textDelta: "streamed" };
          yield { type: "finish" as const, finishReason: "stop" as const };
        })();
      }
    }), [middleware]);

    expect((await model.generate({ messages: [] })).text).toBe("generated");
    const outputEvents = [];
    for await (const event of await model.stream!({ messages: [] })) outputEvents.push(event);

    expect(outputEvents).toEqual([
      { type: "text-delta", textDelta: "streamed" },
      { type: "finish", finishReason: "stop" }
    ]);
    expect(generateCalls).toBe(1);
    expect(streamCalls).toBe(1);
  });

  it("keeps successful model results when span completion and metric export throw", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    let spanEnds = 0;
    let metricRecords = 0;
    const tracer: OTelTracerLike = {
      startSpan() {
        return {
          setAttribute() {
            throw new Error("span attribute failed");
          },
          end() {
            spanEnds += 1;
            throw new Error("span end failed");
          }
        };
      }
    };
    const meter: OTelMeterLike = {
      createHistogram() {
        return {
          record() {
            metricRecords += 1;
            throw new Error("metric export failed");
          }
        };
      }
    };
    const middleware = await createOtelTelemetryMiddleware({ tracer, meter });
    const model = wrapLanguageModel(createLanguageModel({
      async generate() {
        generateCalls += 1;
        return {
          messages: [createTextMessage("assistant", "generated")],
          text: "generated",
          finishReason: "stop",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
        };
      },
      async stream() {
        streamCalls += 1;
        return (async function* () {
          yield { type: "text-delta" as const, textDelta: "streamed" };
          yield {
            type: "finish" as const,
            finishReason: "stop" as const,
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
          };
        })();
      }
    }), [middleware]);

    expect((await model.generate({ messages: [] })).text).toBe("generated");
    const outputEvents = [];
    for await (const event of await model.stream!({ messages: [] })) outputEvents.push(event);

    expect(outputEvents.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
    expect(generateCalls).toBe(1);
    expect(streamCalls).toBe(1);
    expect(spanEnds).toBe(2);
    expect(metricRecords).toBeGreaterThanOrEqual(6);
  });

  it("preserves business errors when every OTEL terminal operation also fails", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    const tracer: OTelTracerLike = {
      startSpan() {
        return {
          setAttribute() {
            throw new Error("span attribute failed");
          },
          recordException() {
            throw new Error("span exception failed");
          },
          end() {
            throw new Error("span end failed");
          }
        };
      }
    };
    const meter: OTelMeterLike = {
      createHistogram() {
        return { record: () => { throw new Error("metric export failed"); } };
      }
    };
    const middleware = await createOtelTelemetryMiddleware({ tracer, meter });
    const model = wrapLanguageModel(createLanguageModel({
      async generate() {
        generateCalls += 1;
        throw new Error("business generate failed");
      },
      async stream() {
        streamCalls += 1;
        return (async function* () {
          throw new Error("business stream failed");
          yield { type: "finish" as const };
        })();
      }
    }), [middleware]);

    await expect(model.generate({ messages: [] })).rejects.toThrow("business generate failed");
    const stream = await model.stream!({ messages: [] });
    await expect((async () => {
      for await (const _event of stream) {
        // drain
      }
    })()).rejects.toThrow("business stream failed");
    expect(generateCalls).toBe(1);
    expect(streamCalls).toBe(1);
  });

  it("exports a real parent-child agent trace and closes interrupted steps on cancellation", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)]
    });

    try {
      const observer = await createOtelAgentObserver({
        tracer: provider.getTracer("zhivex-agent-test")
      });

      await Promise.all([
        observer({
          type: "run-start",
          runId: "run_cancelled",
          agentId: "assistant",
          agentName: "Assistant",
          provider: "vertex",
          modelId: "gemini-3-flash",
          maxSteps: 4
        }),
        observer({
          type: "step-start",
          runId: "run_cancelled",
          agentId: "assistant",
          stepIndex: 1
        }),
        observer({
          type: "step-start",
          runId: "run_cancelled",
          agentId: "assistant",
          stepIndex: 2
        })
      ]);
      await observer({
        type: "run-finish",
        runId: "run_cancelled",
        agentId: "assistant",
        status: "cancelled",
        state: baseRunState({
          runId: "run_cancelled",
          status: "cancelled",
          cancellationReason: "User cancelled."
        })
      });
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const run = spans.find((span) => span.name === "invoke_agent Assistant");
      const steps = spans.filter((span) => span.name === "agent_step");

      expect(spans).toHaveLength(3);
      expect(run?.kind).toBe(SpanKind.INTERNAL);
      expect(run?.status.code).toBe(SpanStatusCode.UNSET);
      expect(run?.attributes).toMatchObject({
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "Assistant",
        "gen_ai.request.model": "gemini-3-flash",
        "zhivex.status": "cancelled"
      });
      expect(steps).toHaveLength(2);
      expect(steps.every((span) => span.ended)).toBe(true);
      expect(steps.every((span) => span.parentSpanContext?.spanId === run?.spanContext().spanId)).toBe(true);
      expect(steps.every((span) => span.attributes["zhivex.step_status"] === "interrupted")).toBe(true);
    } finally {
      await provider.shutdown();
    }
  });

  it("ends real error spans exactly once with OTEL status and exception data", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)]
    });

    try {
      const observer = await createOtelObserver({
        tracer: provider.getTracer("zhivex-error-test")
      });
      const handle = observer.startSpan("failing-operation");
      const error = Object.assign(new Error("cancelled by caller"), { name: "AbortError" });

      await Promise.all([
        handle.end({ error }),
        handle.end({ attributes: { "zhivex.status": "duplicate-end" } })
      ]);
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      expect(handle.ended).toBe(true);
      expect(spans).toHaveLength(1);
      expect(spans[0]?.status).toEqual({
        code: SpanStatusCode.ERROR,
        message: "cancelled by caller"
      });
      expect(spans[0]?.attributes["error.type"]).toBe("AbortError");
      expect(spans[0]?.events.filter((event) => event.name === "exception")).toHaveLength(1);
    } finally {
      await provider.shutdown();
    }
  });

  it("does not collide concurrent model spans with the same input and timestamp", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)]
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    try {
      let callCount = 0;
      const releases = new Map<number, () => void>();
      const middleware = await createOtelTelemetryMiddleware({
        tracer: provider.getTracer("zhivex-concurrency-test")
      });
      const model = wrapLanguageModel(createLanguageModel({
        async generate() {
          callCount += 1;
          const call = callCount;
          await new Promise<void>((resolve) => releases.set(call, resolve));
          return {
            messages: [createTextMessage("assistant", `result ${call}`)],
            text: `result ${call}`,
            finishReason: call === 1 ? "stop" : "length",
            usage: { inputTokens: 10, outputTokens: call, totalTokens: 10 + call }
          };
        }
      }), [middleware]);
      const input = { messages: [createTextMessage("user", "Hello")] };

      const first = model.generate(input);
      const second = model.generate(input);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(releases.size).toBe(2);
      releases.get(2)!();
      await second;
      releases.get(1)!();
      await first;
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      expect(spans.every((span) => span.name === "chat model")).toBe(true);
      expect(spans.every((span) => span.kind === SpanKind.CLIENT && span.ended)).toBe(true);
      expect(spans.find((span) => span.attributes["zhivex.generate_id"] === 1)?.attributes).toMatchObject({
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.output_tokens": 1
      });
      expect(spans.find((span) => span.attributes["zhivex.generate_id"] === 2)?.attributes).toMatchObject({
        "gen_ai.response.finish_reasons": ["length"],
        "gen_ai.usage.output_tokens": 2
      });
    } finally {
      now.mockRestore();
      await provider.shutdown();
    }
  });

  it("closes a real stream span when the consumer stops iteration early", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)]
    });

    try {
      const middleware = await createOtelTelemetryMiddleware({
        tracer: provider.getTracer("zhivex-stream-cancellation-test")
      });
      const model = wrapLanguageModel(
        createLanguageModel({
          async stream() {
            return (async function* () {
              yield { type: "text-delta" as const, textDelta: "first" };
              yield { type: "text-delta" as const, textDelta: "second" };
              yield { type: "finish" as const, finishReason: "stop" as const };
            })();
          }
        }),
        [middleware]
      );
      const stream = await model.stream!({
        messages: [createTextMessage("user", "Hello")]
      });

      for await (const _event of stream) {
        break;
      }
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe("chat model");
      expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(spans[0]?.attributes["error.type"]).toBe("AbortError");
      expect(spans[0]?.ended).toBe(true);
    } finally {
      await provider.shutdown();
    }
  });

  it("keeps stream lifecycle lazy and classifies finish, provider error, and cancellation terminals", async () => {
    const events: LanguageModelTelemetryEvent[] = [];
    const telemetry = createTelemetryMiddleware({
      onEvent: (event) => events.push(event)
    });
    const eventsForStream = (streamId: number) => events.filter(
      (event) => "streamId" in event && event.streamId === streamId
    );
    const input = { messages: [createTextMessage("user", "Hello")] };
    let providerCalls = 0;

    const neverIteratedModel = wrapLanguageModel(createLanguageModel({
      async stream() {
        providerCalls += 1;
        return (async function* () {
          yield { type: "text-delta" as const, textDelta: "unused" };
        })();
      }
    }), [telemetry]);
    await neverIteratedModel.stream!(input);
    expect(providerCalls).toBe(0);
    expect(events).toEqual([]);

    const finishModel = wrapLanguageModel(createLanguageModel({
      async stream() {
        providerCalls += 1;
        return (async function* () {
          yield { type: "finish" as const, finishReason: "stop" as const };
        })();
      }
    }), [telemetry]);
    const finishStream = await finishModel.stream!(input);
    for await (const event of finishStream) {
      expect(event.type).toBe("finish");
      break;
    }
    expect(eventsForStream(2).map((event) => event.type)).toEqual([
      "stream-start",
      "stream-finish"
    ]);

    const providerError = Object.assign(new Error("provider stream failed"), { name: "ProviderError" });
    const errorModel = wrapLanguageModel(createLanguageModel({
      async stream() {
        providerCalls += 1;
        return (async function* () {
          yield { type: "error" as const, error: providerError };
        })();
      }
    }), [telemetry]);
    const errorStream = await errorModel.stream!(input);
    const observedErrors = [];
    for await (const event of errorStream) observedErrors.push(event);
    expect(observedErrors).toEqual([{ type: "error", error: providerError }]);
    expect(eventsForStream(3).map((event) => event.type)).toEqual([
      "stream-start",
      "stream-error"
    ]);

    const cancelledModel = wrapLanguageModel(createLanguageModel({
      async stream() {
        providerCalls += 1;
        return (async function* () {
          yield { type: "text-delta" as const, textDelta: "private chunk" };
          yield { type: "text-delta" as const, textDelta: "unobserved" };
        })();
      }
    }), [telemetry]);
    const cancelledStream = await cancelledModel.stream!(input);
    for await (const _event of cancelledStream) break;
    const cancelledEvents = eventsForStream(4);
    const chunk = cancelledEvents.find((event) => event.type === "stream-chunk");
    expect(cancelledEvents.map((event) => event.type)).toEqual([
      "stream-start",
      "stream-chunk",
      "stream-error"
    ]);
    expect(chunk).not.toHaveProperty("textDelta");
    expect(chunk).not.toHaveProperty("output");
    expect(chunk).not.toHaveProperty("event");
    expect(cancelledEvents.at(-1)).toMatchObject({
      type: "stream-error",
      outputChunkCount: 1,
      error: { name: "AbortError" }
    });
    expect(providerCalls).toBe(3);
  });

  it("starts stream timing on first iteration instead of counting consumer idle time", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const events: LanguageModelTelemetryEvent[] = [];
    let providerCalls = 0;

    try {
      const model = wrapLanguageModel(createLanguageModel({
        async stream() {
          providerCalls += 1;
          return (async function* () {
            yield { type: "finish" as const, finishReason: "stop" as const };
          })();
        }
      }), [createTelemetryMiddleware({ onEvent: (event) => events.push(event) })]);
      const stream = await model.stream!({ messages: [] });
      now = 5_000;
      for await (const _event of stream) break;

      expect(providerCalls).toBe(1);
      expect(events[0]).toMatchObject({ type: "stream-start", startedAt: 5_000 });
      expect(events[1]).toMatchObject({ type: "stream-finish", latencyMs: 0 });
    } finally {
      clock.mockRestore();
    }
  });

  it("fails open when an agent context wrapper breaks without executing business work twice", async () => {
    const createContextObserver = (mode: "before" | "after" | "pass" | "skip"): AgentTelemetryObserver => {
      const observer = (() => undefined) as AgentTelemetryObserver;
      observer.withRunContext = async <T>(_runId: string, callback: () => T | Promise<T>): Promise<T> => {
        if (mode === "before") throw new Error("context wrapper failed before callback");
        if (mode === "skip") return undefined as T;
        const result = await callback();
        if (mode === "after") throw new Error("context wrapper failed after callback");
        return result;
      };
      return observer;
    };

    for (const mode of ["before", "after", "skip"] as const) {
      let executions = 0;
      const agent = createAgent({
        model: createLanguageModel({
          async generate() {
            executions += 1;
            return {
              messages: [createTextMessage("assistant", "completed")],
              text: "completed",
              finishReason: "stop"
            };
          }
        }),
        onTelemetryEvent: createContextObserver(mode)
      });
      const result = await runAgent(agent, { prompt: "continue" });
      expect(result.status).toBe("completed");
      expect(executions).toBe(1);
    }

    let failedExecutions = 0;
    const failedAgent = createAgent({
      model: createLanguageModel({
        async generate() {
          failedExecutions += 1;
          throw new Error("business generation failed");
        }
      }),
      onTelemetryEvent: createContextObserver("pass")
    });
    await expect(runAgent(failedAgent, { prompt: "continue" })).rejects.toThrow("business generation failed");
    expect(failedExecutions).toBe(1);
  });

  it("exports exact agent invocation metrics and keeps aggregate usage in the Zhivex namespace", async () => {
    const spanExporter = new InMemorySpanExporter();
    const traceProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)]
    });
    const { exporter: metricExporter, provider: metricProvider } = createMetricSdk();

    try {
      const observer = await createOtelAgentObserver({
        tracerProvider: traceProvider,
        meterProvider: metricProvider,
        tracerName: "zhivex-agent-metrics-test",
        meterName: "zhivex-agent-metrics-test"
      });
      await observer({
        type: "run-start",
        runId: "run_metrics",
        agentId: "definition_123",
        agentName: "Weather Assistant",
        provider: "openai",
        modelId: "gpt-5",
        maxSteps: 4,
        startedAt: 10_000
      });
      await observer({
        type: "step-start",
        runId: "run_metrics",
        agentId: "definition_123",
        agentName: "Weather Assistant",
        stepIndex: 1,
        startedAt: 10_100
      });
      await observer({
        type: "step-finish",
        runId: "run_metrics",
        agentId: "definition_123",
        step: { ...baseRunState().steps[0]!, startedAt: 10_100, finishedAt: 10_400 }
      });
      await observer({
        type: "step-start",
        runId: "run_metrics",
        agentId: "definition_123",
        agentName: "Weather Assistant",
        stepIndex: 2,
        startedAt: 10_500
      });
      await observer({
        type: "tool-start",
        runId: "run_metrics",
        agentId: "definition_123",
        agentName: "Weather Assistant",
        stepIndex: 2,
        toolCall: { id: "call_2", name: "weather", input: { city: "Madrid" } },
        startedAt: 10_600
      });
      await observer({
        type: "step-finish",
        runId: "run_metrics",
        agentId: "definition_123",
        step: { ...baseRunState().steps[1]!, startedAt: 10_500, finishedAt: 11_300 }
      });
      await observer({
        type: "run-finish",
        runId: "run_metrics",
        agentId: "definition_123",
        agentName: "Weather Assistant",
        status: "completed",
        state: baseRunState({
          runId: "run_metrics",
          agentId: "definition_123",
          provider: "openai",
          modelId: "gpt-5",
          startedAt: 1,
          updatedAt: 11_500
        }),
        finishedAt: 11_500
      });

      await Promise.all([traceProvider.forceFlush(), metricProvider.forceFlush()]);

      const duration = findMetric(metricExporter, "gen_ai.invoke_agent.duration");
      const inferenceCalls = findMetric(metricExporter, "gen_ai.invoke_agent.inference_calls");
      const toolCalls = findMetric(metricExporter, "gen_ai.invoke_agent.tool_calls");
      expect(duration?.descriptor.unit).toBe("s");
      expect(inferenceCalls?.descriptor.unit).toBe("{inference_call}");
      expect(toolCalls?.descriptor.unit).toBe("{tool_call}");
      expect(histogramPoint(duration).value).toMatchObject({ count: 1, sum: 1.5 });
      expect(histogramPoint(duration).attributes).toMatchObject({
        "gen_ai.agent.name": "Weather Assistant",
        "gen_ai.request.model": "gpt-5"
      });
      expect(histogramPoint(duration).value.buckets?.boundaries).toEqual([
        0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6
      ]);
      expect(histogramPoint(inferenceCalls).value).toMatchObject({ count: 1, sum: 2 });
      expect(histogramPoint(toolCalls).value).toMatchObject({ count: 1, sum: 1 });
      expect(histogramPoint(inferenceCalls).value.buckets?.boundaries).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);

      const run = spanExporter.getFinishedSpans().find((span) => span.name === "invoke_agent Weather Assistant");
      expect(run?.kind).toBe(SpanKind.INTERNAL);
      expect(spanDurationSeconds(run!.duration)).toBeCloseTo(1.5);
      expect(run?.attributes).toMatchObject({
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "Weather Assistant",
        "gen_ai.request.model": "gpt-5",
        "zhivex.agent_id": "definition_123",
        "zhivex.finish_reason": "stop",
        "zhivex.usage_input_tokens": 30,
        "zhivex.usage_output_tokens": 15
      });
      expect(run?.attributes["gen_ai.agent.id"]).toBeUndefined();
      expect(run?.attributes["gen_ai.response.finish_reasons"]).toBeUndefined();
      expect(run?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
      expect(run?.attributes["gen_ai.usage.output_tokens"]).toBeUndefined();
    } finally {
      await Promise.all([traceProvider.shutdown(), metricProvider.shutdown()]);
    }
  });

  it("keeps model and tool spans under the active in-process agent invocation", async () => {
    const contextManager = new AsyncLocalTestContextManager();
    otelContext.disable();
    expect(otelContext.setGlobalContextManager(contextManager.enable())).toBe(true);
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)]
    });

    try {
      const [agentObserver, modelMiddleware] = await Promise.all([
        createOtelAgentObserver({
          tracerProvider: provider,
          tracerName: "zhivex-agent-hierarchy-test"
        }),
        createOtelTelemetryMiddleware({
          tracerProvider: provider,
          tracerName: "zhivex-model-hierarchy-test"
        })
      ]);
      let inferenceCalls = 0;
      const model = wrapLanguageModel(createLanguageModel({
        async generate() {
          inferenceCalls += 1;
          if (inferenceCalls === 1) {
            return {
              messages: [{
                role: "assistant",
                parts: [{
                  type: "tool-call",
                  toolCall: { id: "tool_1", name: "weather", input: { city: "Madrid" } }
                }]
              }],
              finishReason: "tool-calls"
            };
          }
          return {
            messages: [createTextMessage("assistant", "sunny")],
            text: "sunny",
            finishReason: "stop"
          };
        }
      }), [modelMiddleware]);
      const agent = createAgent({
        id: "weather_definition",
        name: "Weather Assistant",
        model,
        maxSteps: 2,
        tools: {
          weather: tool({
            name: "weather",
            schema: z.object({ city: z.string() }),
            execute: ({ city }) => ({ city, forecast: "sunny" })
          })
        },
        onTelemetryEvent: agentObserver
      });

      const result = await runAgent(agent, { prompt: "Weather?" });
      expect(result.status).toBe("completed");
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const run = spans.find((span) => span.name === "invoke_agent Weather Assistant");
      const modelSpans = spans.filter((span) => span.name === "chat model");
      const toolSpan = spans.find((span) => span.name === "execute_tool weather");
      expect(modelSpans).toHaveLength(2);
      expect(toolSpan).toBeDefined();
      expect(modelSpans.every((span) => span.parentSpanContext?.spanId === run?.spanContext().spanId)).toBe(true);
      expect(toolSpan?.parentSpanContext?.spanId).toBe(run?.spanContext().spanId);
    } finally {
      await provider.shutdown();
      otelContext.disable();
    }
  });

  it("records setup failures before run-start for buffered and streaming agents", async () => {
    const spanExporter = new InMemorySpanExporter();
    const traceProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)]
    });
    const { exporter: metricExporter, provider: metricProvider } = createMetricSdk();
    let modelCalls = 0;

    try {
      const observer = await createOtelAgentObserver({
        tracerProvider: traceProvider,
        meterProvider: metricProvider,
        tracerName: "zhivex-agent-setup-failure-test",
        meterName: "zhivex-agent-setup-failure-test"
      });
      const model = createLanguageModel({
        async generate() {
          modelCalls += 1;
          return {
            messages: [createTextMessage("assistant", "should not execute")],
            text: "should not execute"
          };
        }
      });
      const base = {
        id: "setup_definition",
        name: "Setup Agent",
        model,
        onTelemetryEvent: observer
      };

      const invalidContextAgent = createAgent({
        ...base,
        contextSchema: z.object({ tenantId: z.string() })
      });
      await expect(runAgent(invalidContextAgent, {
        runId: "resolve_failure",
        context: { tenantId: 123 } as unknown as { tenantId: string }
      })).rejects.toThrow("Invalid agent context");

      const storeFailureAgent = createAgent({
        ...base,
        store: {
          load() {
            throw new Error("store load failed");
          },
          save() {}
        }
      });
      await expect(runAgent(storeFailureAgent, { runId: "store_failure" })).rejects.toThrow("store load failed");

      let leaseAttempts = 0;
      const leaseFailureAgent = createAgent({
        ...base,
        store: {
          load() {
            return undefined;
          },
          save() {},
          acquireLease() {
            leaseAttempts += 1;
            throw new Error("lease acquire failed");
          },
          renewLease() {
            return undefined;
          },
          releaseLease() {
            return true;
          }
        }
      });
      await expect(runAgent(leaseFailureAgent, { runId: "lease_failure" })).rejects.toThrow("lease acquire failed");

      const preflightFailureAgent = createAgent({
        ...base,
        policy: { maxStateBytes: 1 }
      });
      await expect(runAgent(preflightFailureAgent, { runId: "preflight_failure" })).rejects.toThrow(
        "exceeds maxStateBytes=1"
      );

      const streamed = streamAgent(invalidContextAgent, {
        runId: "stream_resolve_failure",
        context: { tenantId: 123 } as unknown as { tenantId: string }
      });
      await expect(streamed.collect()).rejects.toThrow("Invalid agent context");

      await Promise.all([traceProvider.forceFlush(), metricProvider.forceFlush()]);
      expect(modelCalls).toBe(0);
      expect(leaseAttempts).toBe(1);

      const spans = spanExporter.getFinishedSpans().filter((span) => span.name === "invoke_agent Setup Agent");
      expect(spans).toHaveLength(5);
      expect(spans.map((span) => span.attributes["zhivex.run_id"]).sort()).toEqual([
        "lease_failure",
        "preflight_failure",
        "resolve_failure",
        "store_failure",
        "stream_resolve_failure"
      ]);
      expect(spans.every((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true);
      expect(spans.every((span) => span.attributes["zhivex.status"] === "failed")).toBe(true);
      expect(spans.every((span) => typeof span.attributes["error.type"] === "string")).toBe(true);
      expect(spans.every((span) => spanDurationSeconds(span.duration) >= 0)).toBe(true);

      const durationPoints = histogramPoints(findMetric(metricExporter, "gen_ai.invoke_agent.duration"));
      expect(durationPoints.reduce((total, point) => total + point.value.count, 0)).toBe(5);
      expect(durationPoints.every((point) => typeof point.attributes["error.type"] === "string")).toBe(true);
      expect(durationPoints.every((point) => (point.value.sum ?? 0) >= 0)).toBe(true);
    } finally {
      await Promise.all([traceProvider.shutdown(), metricProvider.shutdown()]);
    }
  });

  it("allowlists bounded scalar guardrail metadata before adding OTEL event attributes", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)]
    });

    try {
      const observer = await createOtelAgentObserver({ tracerProvider: provider });
      await observer({
        type: "run-start",
        runId: "guardrail_metadata",
        agentId: "guarded",
        agentName: "Guarded Agent",
        provider: "openai",
        modelId: "gpt-5",
        maxSteps: 1,
        startedAt: 1_000
      });
      await observer({
        type: "guardrail-triggered",
        runId: "guardrail_metadata",
        agentId: "guarded",
        stage: "input",
        reason: "blocked",
        metadata: {
          budgetLimit: "x".repeat(200),
          limit: 10,
          actual: 11,
          includeChildRuns: true,
          operation: "model",
          "gen_ai.request.model": "attacker-controlled-model",
          prompt: "SECRET_PROMPT",
          messages: ["SECRET_MESSAGE"],
          arguments: "SECRET_ARGUMENTS",
          result: "SECRET_RESULT",
          nested: { huge: "z".repeat(10_000) }
        }
      });
      await observer({
        type: "run-finish",
        runId: "guardrail_metadata",
        agentId: "guarded",
        agentName: "Guarded Agent",
        status: "failed",
        state: baseRunState({
          runId: "guardrail_metadata",
          agentId: "guarded",
          status: "failed",
          error: { message: "blocked" },
          updatedAt: 1_100
        }),
        finishedAt: 1_100
      });
      await provider.forceFlush();

      const span = exporter.getFinishedSpans().find((candidate) => candidate.name === "invoke_agent Guarded Agent");
      const guardrailEvent = span?.events.find((event) => event.name === "guardrail-triggered");
      expect(guardrailEvent?.attributes).toMatchObject({
        "zhivex.stage": "input",
        "zhivex.reason": "blocked",
        "zhivex.guardrail.metadata.limit": 10,
        "zhivex.guardrail.metadata.actual": 11,
        "zhivex.guardrail.metadata.include_child_runs": true,
        "zhivex.guardrail.metadata.operation": "model"
      });
      expect(String(guardrailEvent?.attributes?.["zhivex.guardrail.metadata.budget_limit"])).toHaveLength(129);
      const serialized = JSON.stringify(guardrailEvent?.attributes);
      expect(serialized).not.toContain("gen_ai.request.model");
      expect(serialized).not.toContain("SECRET_PROMPT");
      expect(serialized).not.toContain("SECRET_MESSAGE");
      expect(serialized).not.toContain("SECRET_ARGUMENTS");
      expect(serialized).not.toContain("SECRET_RESULT");
      expect(serialized).not.toContain("nested");
    } finally {
      await provider.shutdown();
    }
  });

  it("exports all client and tool GenAI metrics with the audited semantic contract", async () => {
    const spanExporter = new InMemorySpanExporter();
    const traceProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)]
    });
    const { exporter: metricExporter, provider: metricProvider } = createMetricSdk();

    try {
      const middleware = await createOtelTelemetryMiddleware({
        tracerProvider: traceProvider,
        meterProvider: metricProvider,
        tracerName: "zhivex-client-metrics-test",
        meterName: "zhivex-client-metrics-test"
      });
      const emit = (middleware as typeof middleware & {
        onTelemetryEvent: (event: LanguageModelTelemetryEvent) => void | Promise<void>;
      }).onTelemetryEvent;
      const model = createLanguageModel({ provider: "xai", modelId: "grok-4" });
      const gemini = createLanguageModel({ provider: "gemini", modelId: "gemini-3" });
      const kimi = createLanguageModel({ provider: "kimi", modelId: "kimi-k2" });
      const input = { messages: [createTextMessage("user", "private prompt") ] };
      const output = {
        messages: [createTextMessage("assistant", "private response")],
        text: "private response",
        finishReason: "stop" as const,
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }
      };

      await emit({ type: "generate-start", generateId: 1, model, input, startedAt: 1_000 });
      await emit({
        type: "generate-finish",
        generateId: 1,
        model,
        input,
        output,
        startedAt: 1_000,
        finishedAt: 1_400,
        latencyMs: 400
      });
      await emit({ type: "stream-start", streamId: 2, model, input, startedAt: 2_000 });
      await emit({
        type: "stream-chunk",
        streamId: 2,
        model,
        input,
        startedAt: 2_000,
        chunkAt: 2_100,
        chunkIndex: 1,
        timeToFirstChunkMs: 100
      });
      await emit({
        type: "stream-chunk",
        streamId: 2,
        model,
        input,
        startedAt: 2_000,
        chunkAt: 2_250,
        chunkIndex: 2,
        timeSincePreviousChunkMs: 150
      });
      await emit({
        type: "stream-finish",
        streamId: 2,
        model,
        input,
        startedAt: 2_000,
        finishedAt: 2_500,
        latencyMs: 500,
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        outputChunkCount: 2
      });
      await emit({
        type: "tool-execution-start",
        model,
        input,
        step: 1,
        toolCall: { id: "call_1", name: "weather", input: { city: "Madrid" } },
        startedAt: 3_000
      });
      await emit({
        type: "tool-execution-finish",
        model,
        input,
        step: 1,
        toolCall: { id: "call_1", name: "weather", input: { city: "Madrid" } },
        toolResult: {
          toolCallId: "call_1",
          toolName: "weather",
          output: { forecast: "sunny" },
          isError: false
        },
        startedAt: 3_000,
        finishedAt: 3_250,
        latencyMs: 250
      });
      await emit({ type: "generate-start", generateId: 3, model: gemini, input, startedAt: 4_000 });
      await emit({
        type: "generate-finish",
        generateId: 3,
        model: gemini,
        input,
        output: { ...output, usage: undefined },
        startedAt: 4_000,
        finishedAt: 4_200,
        latencyMs: 200
      });
      const rateLimitError = Object.assign(new Error("rate limited"), { name: "RateLimitError" });
      await emit({ type: "generate-start", generateId: 4, model: kimi, input, startedAt: 5_000 });
      await emit({
        type: "generate-error",
        generateId: 4,
        model: kimi,
        input,
        error: rateLimitError,
        startedAt: 5_000,
        finishedAt: 5_100,
        latencyMs: 100
      });

      await Promise.all([traceProvider.forceFlush(), metricProvider.forceFlush()]);

      expect(OTEL_GENAI_CONTRACT_VERSION).toBe(1);
      expect(OTEL_GENAI_SEMCONV_REVISION).toBe("a685613a207a580163353b8e48a7ad88967e7b42");

      const durationMetric = findMetric(metricExporter, "gen_ai.client.operation.duration");
      const tokenMetric = findMetric(metricExporter, "gen_ai.client.token.usage");
      const ttfcMetric = findMetric(metricExporter, "gen_ai.client.operation.time_to_first_chunk");
      const chunkMetric = findMetric(metricExporter, "gen_ai.client.operation.time_per_output_chunk");
      const toolMetric = findMetric(metricExporter, "gen_ai.execute_tool.duration");
      const xaiDuration = findHistogramPoint(durationMetric, {
        "gen_ai.provider.name": "x_ai",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "grok-4"
      });

      expect(durationMetric?.descriptor.unit).toBe("s");
      expect(durationMetric?.descriptor.description).toBe("GenAI operation duration.");
      expect(tokenMetric?.descriptor.unit).toBe("{token}");
      expect(ttfcMetric?.descriptor.unit).toBe("s");
      expect(chunkMetric?.descriptor.unit).toBe("s");
      expect(toolMetric?.descriptor.unit).toBe("s");
      expect(xaiDuration?.value).toMatchObject({ count: 2, sum: 0.9 });
      expect(xaiDuration?.value.buckets?.boundaries).toEqual([
        0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92
      ]);
      expect(findHistogramPoint(durationMetric, {
        "gen_ai.provider.name": "gcp.gemini",
        "gen_ai.operation.name": "generate_content",
        "gen_ai.request.model": "gemini-3"
      })?.value).toMatchObject({ count: 1, sum: 0.2 });
      expect(findHistogramPoint(durationMetric, {
        "gen_ai.provider.name": "moonshot_ai",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "kimi-k2",
        "error.type": "RateLimitError"
      })?.value).toMatchObject({ count: 1, sum: 0.1 });
      expect(findHistogramPoint(tokenMetric, { "gen_ai.token.type": "input" })?.value).toMatchObject({
        count: 2,
        sum: 32
      });
      expect(findHistogramPoint(tokenMetric, { "gen_ai.token.type": "output" })?.value).toMatchObject({
        count: 2,
        sum: 8
      });
      expect(histogramPoint(tokenMetric).value.buckets?.boundaries).toEqual([
        1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864
      ]);
      expect(histogramPoint(ttfcMetric).value).toMatchObject({ count: 1, sum: 0.1 });
      expect(histogramPoint(ttfcMetric).value.buckets?.boundaries).toEqual(
        xaiDuration?.value.buckets?.boundaries
      );
      expect(histogramPoint(chunkMetric).value).toMatchObject({ count: 1, sum: 0.15 });
      expect(histogramPoint(chunkMetric).value.buckets?.boundaries).toEqual(
        xaiDuration?.value.buckets?.boundaries
      );
      expect(histogramPoint(toolMetric).value).toMatchObject({ count: 1, sum: 0.25 });
      expect(histogramPoint(toolMetric).value.buckets?.boundaries).toEqual(
        xaiDuration?.value.buckets?.boundaries
      );

      const spans = spanExporter.getFinishedSpans();
      expect(spans.filter((span) => span.name === "chat grok-4")).toHaveLength(2);
      expect(spans.find((span) => span.name === "generate_content gemini-3")?.attributes).toMatchObject({
        "gen_ai.operation.name": "generate_content",
        "gen_ai.provider.name": "gcp.gemini"
      });
      expect(spans.find((span) => span.name === "chat kimi-k2")?.attributes).toMatchObject({
        "gen_ai.provider.name": "moonshot_ai",
        "error.type": "RateLimitError"
      });
      const streamSpan = spans.find((span) => span.attributes["zhivex.stream_id"] === 2);
      expect(streamSpan?.attributes).toMatchObject({
        "gen_ai.request.stream": true,
        "gen_ai.response.time_to_first_chunk": 0.1
      });
      expect(spanDurationSeconds(streamSpan!.duration)).toBeCloseTo(0.5);
      const attributeKeys = new Set(spans.flatMap((span) => Object.keys(span.attributes)));
      expect(attributeKeys).not.toContain("gen_ai.input.messages");
      expect(attributeKeys).not.toContain("gen_ai.output.messages");
      expect(attributeKeys).not.toContain("gen_ai.tool.call.arguments");
      expect(attributeKeys).not.toContain("gen_ai.tool.call.result");
    } finally {
      await Promise.all([traceProvider.shutdown(), metricProvider.shutdown()]);
    }
  });
});
