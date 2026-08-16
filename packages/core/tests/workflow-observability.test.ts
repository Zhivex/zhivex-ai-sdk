import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import {
  createAgent,
  createInMemorySessionService,
  createInMemoryWorkflowStateService,
  createOtelAgentObserver,
  createOtelTelemetryMiddleware,
  createRunner,
  createTextMessage,
  wrapLanguageModel,
  type LanguageModel,
  type StreamEvent
} from "../src/index.js";
import { createOtelWorkflowObserver } from "../src/workflow-observability.js";
import { OTelObserver, type OTelSpanLike } from "../src/observability.js";
import {
  createWorkflow,
  runWorkflow,
  type WorkflowTelemetryEvent,
  type WorkflowTelemetryObserver
} from "../src/workflow.js";

const DURATION_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200];

const createLanguageModel = (overrides?: Partial<LanguageModel>): LanguageModel => ({
  provider: "test",
  modelId: "workflow-observability-model",
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
      messages: [createTextMessage("assistant", "done")],
      text: "done",
      finishReason: "stop"
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "done" };
      yield { type: "finish", finishReason: "stop" };
    })();
  },
  ...overrides
});

const createTestRunner = (model = createLanguageModel()) =>
  createRunner({
    appName: "workflow-observability-test",
    agent: createAgent({ model, maxSteps: 3 }),
    sessionService: createInMemorySessionService()
  });

const createOtelTestHarness = async () => {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)]
  });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  const observer = await createOtelWorkflowObserver({
    tracer: tracerProvider.getTracer("workflow-observability-test"),
    meter: meterProvider.getMeter("workflow-observability-test")
  });

  return {
    observer,
    spanExporter,
    tracerProvider,
    metricExporter,
    meterProvider,
    async flush() {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
    },
    async shutdown() {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    }
  };
};

const getDurationMetric = (exporter: InMemoryMetricExporter) => {
  const metric = [...exporter.getMetrics()]
    .reverse()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((candidate) => candidate.descriptor.name === "gen_ai.invoke_workflow.duration");
  if (!metric || metric.dataPointType !== DataPointType.HISTOGRAM) {
    throw new Error("Workflow duration histogram was not exported.");
  }
  return metric;
};

describe("workflow OpenTelemetry observability", () => {
  it("exports a failed invocation when persisted state resolution fails before workflow-start", async () => {
    const harness = await createOtelTestHarness();
    const stateReadError = new Error("workflow state store unavailable");
    const workflow = createWorkflow({
      id: "pre-start-failure-id",
      name: "pre_start_failure",
      persistence: {
        appName: "workflow-pre-start-test",
        sessionService: createInMemorySessionService(),
        workflowStateService: {
          saveWorkflowState() {
            throw new Error("unexpected save");
          },
          loadWorkflowState() {
            throw stateReadError;
          },
          listWorkflowStates: () => [],
          deleteWorkflowState() {}
        }
      },
      onTelemetryEvent: harness.observer,
      steps: [{ id: "unreached-step", runner: createTestRunner(), prompt: "Never runs" }]
    });

    try {
      await expect(runWorkflow(workflow, {
        userId: "user_pre_start",
        sessionId: "session_pre_start",
        resumeFromPersistedState: true
      })).rejects.toBe(stateReadError);
      await harness.flush();

      const spans = harness.spanExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]?.name).toBe("invoke_workflow pre_start_failure");
      expect(spans[0]?.status).toEqual({
        code: SpanStatusCode.ERROR,
        message: stateReadError.message
      });
      expect(spans[0]?.attributes).toMatchObject({
        "gen_ai.operation.name": "invoke_workflow",
        "gen_ai.workflow.name": "pre_start_failure",
        "gen_ai.conversation.id": "session_pre_start",
        "zhivex.workflow.id": "pre-start-failure-id",
        "zhivex.workflow.status": "failed",
        "error.type": "Error"
      });
      expect(spans[0]?.events.filter((event) => event.name === "exception")).toHaveLength(1);

      const duration = getDurationMetric(harness.metricExporter);
      expect(duration.dataPoints).toHaveLength(1);
      expect(duration.dataPoints[0]?.attributes).toEqual({
        "gen_ai.workflow.name": "pre_start_failure",
        "error.type": "Error"
      });
      expect(duration.dataPoints[0]?.value.count).toBe(1);
      expect(duration.dataPoints[0]?.value.sum).toBeCloseTo(
        (spans[0]?.duration[0] ?? 0) + (spans[0]?.duration[1] ?? 0) / 1_000_000_000,
        8
      );

      let brokenHookCalls = 0;
      await expect(runWorkflow(workflow, {
        userId: "user_pre_start",
        sessionId: "session_pre_start",
        resumeFromPersistedState: true,
        onTelemetryEvent() {
          brokenHookCalls += 1;
          throw new Error("telemetry exporter unavailable");
        }
      })).rejects.toBe(stateReadError);
      expect(brokenHookCalls).toBe(2);
    } finally {
      await harness.shutdown();
    }
  });

  it("measures the invocation from before persisted state resolution", async () => {
    const backingStateService = createInMemoryWorkflowStateService();
    const events: WorkflowTelemetryEvent[] = [];
    const workflow = createWorkflow({
      name: "durable_workflow",
      persistence: {
        appName: "workflow-duration-test",
        sessionService: createInMemorySessionService(),
        workflowStateService: {
          saveWorkflowState: (input) => backingStateService.saveWorkflowState(input),
          async loadWorkflowState(input) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return backingStateService.loadWorkflowState(input);
          },
          listWorkflowStates: (input) => backingStateService.listWorkflowStates(input),
          deleteWorkflowState: (input) => backingStateService.deleteWorkflowState(input)
        }
      },
      onTelemetryEvent(event) {
        events.push(event);
      },
      steps: [{ id: "durable-step", runner: createTestRunner(), prompt: "Resume" }]
    });

    const result = await runWorkflow(workflow, {
      userId: "user_durable",
      sessionId: "session_durable",
      resumeFromPersistedState: true
    });

    expect(result.status).toBe("completed");
    const start = events.find((event) => event.type === "workflow-start");
    const finish = events.find((event) => event.type === "workflow-finish");
    expect(start?.startedAt).toBe(finish?.startedAt);
    expect((finish?.finishedAt ?? 0) - (finish?.startedAt ?? 0)).toBeGreaterThanOrEqual(15);
  });

  it("exports concurrent workflow-to-step traces and the upstream duration histogram contract", async () => {
    const harness = await createOtelTestHarness();
    const runner = createTestRunner();
    const workflow = createWorkflow({
      id: "review-flow",
      name: "candidate_review",
      onTelemetryEvent: harness.observer,
      steps: [{ id: "review", runner, prompt: "Review the candidate" }]
    });

    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          runWorkflow(workflow, {
            userId: `user_${index}`,
            sessionId: `session_${index}`
          })
        )
      );
      await harness.flush();

      expect(results.every((result) => result.status === "completed")).toBe(true);
      const spans = harness.spanExporter.getFinishedSpans();
      const workflows = spans.filter((span) => span.name === "invoke_workflow candidate_review");
      const steps = spans.filter((span) => span.name === "workflow_step review");
      expect(workflows).toHaveLength(8);
      expect(steps).toHaveLength(8);
      expect(workflows.every((span) => span.kind === SpanKind.INTERNAL && span.ended)).toBe(true);
      expect(steps.every((span) => span.kind === SpanKind.INTERNAL && span.ended)).toBe(true);

      for (const workflowSpan of workflows) {
        const runId = workflowSpan.attributes["zhivex.workflow.run_id"];
        const child = steps.find((span) => span.attributes["zhivex.workflow.run_id"] === runId);
        expect(workflowSpan.attributes).toMatchObject({
          "gen_ai.operation.name": "invoke_workflow",
          "gen_ai.workflow.name": "candidate_review",
          "zhivex.workflow.id": "review-flow",
          "zhivex.workflow.status": "completed"
        });
        expect(workflowSpan.attributes["gen_ai.conversation.id"]).toMatch(/^session_/);
        expect(child?.parentSpanContext?.spanId).toBe(workflowSpan.spanContext().spanId);
        expect(child?.attributes).toMatchObject({
          "gen_ai.workflow.name": "candidate_review",
          "zhivex.workflow.step.id": "review",
          "zhivex.workflow.step.index": 0,
          "zhivex.workflow.step.kind": "task",
          "zhivex.workflow.step.status": "completed"
        });
      }

      const duration = getDurationMetric(harness.metricExporter);
      expect(duration.descriptor).toMatchObject({
        name: "gen_ai.invoke_workflow.duration",
        unit: "s"
      });
      expect(duration.dataPoints).toHaveLength(1);
      expect(duration.dataPoints[0]?.attributes).toEqual({
        "gen_ai.workflow.name": "candidate_review"
      });
      expect(duration.dataPoints[0]?.value.buckets.boundaries).toEqual(DURATION_BUCKETS);
      expect(duration.dataPoints[0]?.value.count).toBe(8);
      const spanDurationSeconds = workflows.reduce(
        (sum, span) => sum + span.duration[0] + span.duration[1] / 1_000_000_000,
        0
      );
      expect(duration.dataPoints[0]?.value.sum).toBeCloseTo(spanDurationSeconds, 8);
    } finally {
      await harness.shutdown();
    }
  });

  it("sets error status and exceptions on failed workflow and step spans", async () => {
    const harness = await createOtelTestHarness();
    const runner = createTestRunner(
      createLanguageModel({
        async generate() {
          throw new Error("model unavailable");
        }
      })
    );
    const workflow = createWorkflow({
      id: "broken-flow",
      name: "broken_workflow",
      onTelemetryEvent: harness.observer,
      steps: [{ id: "broken-step", runner, prompt: "Fail" }]
    });

    try {
      const result = await runWorkflow(workflow, {
        userId: "user_error",
        sessionId: "session_error"
      });
      await harness.flush();

      expect(result.status).toBe("failed");
      const spans = harness.spanExporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      expect(spans.every((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true);
      expect(spans.every((span) => span.attributes["error.type"] === "Error")).toBe(true);
      expect(spans.every((span) => span.events.filter((event) => event.name === "exception").length === 1)).toBe(true);

      const duration = getDurationMetric(harness.metricExporter);
      expect(duration.dataPoints).toHaveLength(1);
      expect(duration.dataPoints[0]?.attributes).toEqual({
        "gen_ai.workflow.name": "broken_workflow",
        "error.type": "Error"
      });
      expect(duration.dataPoints[0]?.value.count).toBe(1);
    } finally {
      await harness.shutdown();
    }
  });

  it("keeps workflow, agent, and model spans in one parent-child trace", async () => {
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)]
    });
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const meterProvider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60_000
      })]
    });
    const tracer = tracerProvider.getTracer("workflow-active-context-test");
    let activeSpan: OTelSpanLike | undefined;
    const sharedObserver = new OTelObserver(
      tracer,
      undefined,
      (parent) => {
        const selected = parent ?? activeSpan;
        return selected
          ? trace.setSpan(context.active(), selected as unknown as Parameters<typeof trace.setSpan>[1])
          : context.active();
      },
      (kind) => kind === "client" ? SpanKind.CLIENT : SpanKind.INTERNAL,
      async (span, callback) => {
        const previous = activeSpan;
        activeSpan = span;
        try {
          return await callback();
        } finally {
          activeSpan = previous;
        }
      }
    );

    try {
      const workflowObserver = await createOtelWorkflowObserver({
        observer: sharedObserver,
        meter: meterProvider.getMeter("workflow-active-context-test")
      });
      const agentObserver = await createOtelAgentObserver({ observer: sharedObserver });
      const modelMiddleware = await createOtelTelemetryMiddleware({ observer: sharedObserver });
      const instrumentedModel = wrapLanguageModel(createLanguageModel(), [modelMiddleware]);
      const runner = createRunner({
        appName: "workflow-observability-nested-agent-test",
        agent: createAgent({
          name: "Nested Agent",
          model: instrumentedModel,
          maxSteps: 3,
          onTelemetryEvent: agentObserver
        }),
        sessionService: createInMemorySessionService()
      });
      const workflow = createWorkflow({
        name: "nested_model_workflow",
        onTelemetryEvent: workflowObserver,
        steps: [{ id: "model-step", runner, prompt: "Generate" }]
      });

      const result = await runWorkflow(workflow, {
        userId: "user_nested",
        sessionId: "session_nested"
      });
      await tracerProvider.forceFlush();

      expect(result.status).toBe("completed");
      const spans = spanExporter.getFinishedSpans();
      const workflowSpan = spans.find((span) => span.name === "invoke_workflow nested_model_workflow");
      const stepSpan = spans.find((span) => span.name === "workflow_step model-step");
      const agentSpan = spans.find((span) => span.name === "invoke_agent Nested Agent");
      const modelSpan = spans.find((span) => span.name === "chat workflow-observability-model");
      expect(stepSpan?.parentSpanContext?.spanId).toBe(workflowSpan?.spanContext().spanId);
      expect(agentSpan?.parentSpanContext?.spanId).toBe(stepSpan?.spanContext().spanId);
      expect(modelSpan?.parentSpanContext?.spanId).toBe(agentSpan?.spanContext().spanId);
    } finally {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    }
  });

  it("closes the waiting approval attempt and opens fresh spans when resumed", async () => {
    const harness = await createOtelTestHarness();
    let calls = 0;
    const runner = createTestRunner(
      createLanguageModel({
        async generate() {
          calls += 1;
          if (calls === 1) {
            return {
              messages: [{
                role: "assistant",
                parts: [{
                  type: "provider-data",
                  provider: "openai",
                  data: {
                    type: "mcp_approval_request",
                    id: "approval_1",
                    arguments: "{}",
                    name: "fetch_docs"
                  }
                }]
              }],
              text: "Approval required",
              finishReason: "stop"
            };
          }
          return {
            messages: [createTextMessage("assistant", "approved")],
            text: "approved",
            finishReason: "stop"
          };
        }
      })
    );
    const workflow = createWorkflow({
      name: "approval_workflow",
      onTelemetryEvent: harness.observer,
      steps: [{ id: "approval-step", runner, prompt: "Use MCP" }]
    });

    try {
      const waiting = await runWorkflow(workflow, {
        userId: "user_approval",
        sessionId: "session_approval"
      });
      expect(waiting.status).toBe("waiting_approval");
      await harness.flush();
      expect(harness.spanExporter.getFinishedSpans()).toHaveLength(2);

      const resumed = await runWorkflow(workflow, {
        userId: "user_approval",
        state: waiting.state,
        approvals: [{ provider: "openai", approvalRequestId: "approval_1", approve: true }]
      });
      await harness.flush();

      expect(resumed.status).toBe("completed");
      const spans = harness.spanExporter.getFinishedSpans();
      expect(spans).toHaveLength(4);
      expect(spans.filter((span) => span.name === "invoke_workflow approval_workflow")).toHaveLength(2);
      expect(spans.filter((span) => span.name === "workflow_step approval-step")).toHaveLength(2);
      expect(spans.map((span) => span.attributes["zhivex.workflow.status"] ?? span.attributes["zhivex.workflow.step.status"]))
        .toEqual(expect.arrayContaining(["waiting_approval", "completed"]));

      const duration = getDurationMetric(harness.metricExporter);
      expect(duration.dataPoints[0]?.value.count).toBe(2);
    } finally {
      await harness.shutdown();
    }
  });

  it("reports cancellation while keeping operational hooks fail-open", async () => {
    const harness = await createOtelTestHarness();
    let sawAbortedSignal = false;
    const runner = createTestRunner(
      createLanguageModel({
        async generate(input) {
          sawAbortedSignal = input.abortSignal?.aborted === true;
          throw Object.assign(new Error("cancelled by caller"), { name: "AbortError" });
        }
      })
    );
    const controller = new AbortController();
    controller.abort();
    const workflow = createWorkflow({
      id: "cancelled-flow-id",
      onTelemetryEvent: harness.observer,
      steps: [{ id: "cancelled-step", runner, prompt: "Do work" }]
    });

    try {
      const result = await runWorkflow(workflow, {
        userId: "user_cancelled",
        sessionId: "session_cancelled",
        abortSignal: controller.signal
      });
      await harness.flush();

      expect(result.status).toBe("failed");
      expect(sawAbortedSignal).toBe(true);
      const spans = harness.spanExporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
      expect(spans.find((span) => span.name === "invoke_workflow")).toBeDefined();
      expect(spans.every((span) => span.status.code === SpanStatusCode.UNSET)).toBe(true);
      expect(spans.every((span) => span.attributes["error.type"] === undefined)).toBe(true);
      expect(spans.every((span) => span.events.every((event) => event.name !== "exception"))).toBe(true);
      expect(spans.map((span) => span.attributes["zhivex.workflow.status"] ?? span.attributes["zhivex.workflow.step.status"]))
        .toEqual(["cancelled", "cancelled"]);
      const duration = getDurationMetric(harness.metricExporter);
      expect(duration.dataPoints[0]?.attributes).toEqual({});

      let hookCalls = 0;
      let modelCalls = 0;
      const brokenObserver: WorkflowTelemetryObserver = () => {
        hookCalls += 1;
        throw new Error("exporter is down");
      };
      brokenObserver.withStepContext = async () => {
        throw new Error("context manager is down");
      };
      const successful = await runWorkflow(
        createWorkflow({
          steps: [{
            id: "success",
            runner: createTestRunner(createLanguageModel({
              async generate() {
                modelCalls += 1;
                return {
                  messages: [createTextMessage("assistant", "done")],
                  text: "done",
                  finishReason: "stop"
                };
              }
            })),
            prompt: "Succeed"
          }],
          onTelemetryEvent: brokenObserver
        }),
        { userId: "user_success", sessionId: "session_success" }
      );
      expect(successful.status).toBe("completed");
      expect(hookCalls).toBe(4);
      expect(modelCalls).toBe(1);
    } finally {
      await harness.shutdown();
    }
  });
});
