import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAgent,
  createOtelAgentObserver,
  createOtelObserver,
  createOtelTelemetryMiddleware,
  createTextMessage,
  generateText,
  tool,
  wrapLanguageModel,
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

describe("otel observability", () => {
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
