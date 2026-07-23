import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  cancelAgentRun,
  createAgent,
  createInMemoryAgentRunStore,
  createTextMessage,
  runAgent,
  tool,
  ValidationError,
  type AgentRunStore,
  type LanguageModel,
  type StreamEvent
} from "../src/index.js";

const model = (generate: LanguageModel["generate"]): LanguageModel => ({
  provider: "test",
  modelId: "production-agent",
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
  generate,
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "finish", finishReason: "stop" };
    })();
  }
});

describe("production agent runtime", () => {
  it("keeps telemetry and memory failures out of the durable execution path by default", async () => {
    const operationalErrors: string[] = [];
    const agent = createAgent({
      model: model(async () => ({
        messages: [createTextMessage("assistant", "completed")],
        text: "completed",
        finishReason: "stop"
      })),
      memory: {
        load() {
          throw new Error("memory unavailable");
        },
        save() {
          throw new Error("memory write unavailable");
        }
      },
      onTelemetryEvent() {
        throw new Error("observer unavailable");
      },
      hookFailurePolicy: {
        onError(event) {
          operationalErrors.push(`${event.source}:${event.operation}`);
        }
      }
    });

    const result = await runAgent(agent, { prompt: "continue" });

    expect(result.status).toBe("completed");
    expect(result.outputText).toBe("completed");
    expect(operationalErrors).toContain("memory:load");
    expect(operationalErrors).toContain("memory:save");
    expect(operationalErrors.some((entry) => entry.startsWith("telemetry:"))).toBe(true);
  });

  it("recovers a checkpoint without repeating a completed side effect", async () => {
    const baseStore = createInMemoryAgentRunStore();
    let failCompletionResponse = true;
    const store: AgentRunStore = {
      ...baseStore,
      async completeToolExecution(entry, options) {
        const completed = await baseStore.completeToolExecution!(entry, options);
        if (failCompletionResponse) {
          failCompletionResponse = false;
          throw new Error("worker crashed after durable tool completion");
        }
        return completed;
      }
    };
    let modelCalls = 0;
    let sideEffects = 0;
    let receivedIdempotencyKey: string | undefined;
    const agent = createAgent({
      store,
      maxSteps: 2,
      toolExecution: { stopOnError: true },
      model: model(async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            messages: [{
              role: "assistant",
              parts: [{
                type: "tool-call",
                toolCall: { id: "provider-call-1", name: "write_once", input: { value: "x" } }
              }]
            }],
            finishReason: "tool-calls"
          };
        }
        return {
          messages: [createTextMessage("assistant", "recovered")],
          text: "recovered",
          finishReason: "stop"
        };
      }),
      tools: {
        write_once: tool({
          name: "write_once",
          schema: z.object({ value: z.string() }),
          execute(_input, context) {
            sideEffects += 1;
            receivedIdempotencyKey = context?.idempotencyKey;
            return { written: true };
          }
        })
      }
    });

    await expect(runAgent(agent, { runId: "recoverable-run", prompt: "write" })).rejects.toThrow(
      "worker crashed after durable tool completion"
    );
    const failed = await store.load("recoverable-run");
    expect(failed?.status).toBe("failed");
    expect(failed?.currentStep).toBe(1);

    const recovered = await runAgent(agent, { state: failed!, maxSteps: 2 });

    expect(recovered.status).toBe("completed");
    expect(recovered.outputText).toBe("recovered");
    expect(modelCalls).toBe(2);
    expect(sideEffects).toBe(1);
    expect(receivedIdempotencyKey).toMatch(/^recoverable-run:tool_[a-f0-9]{64}$/);
  });

  it("actively aborts an in-flight provider request after durable cancellation", async () => {
    const store = createInMemoryAgentRunStore();
    const agent = createAgent({
      store,
      policy: { leaseTtlMs: 1_000, heartbeatMs: 100, cancellationPollMs: 10 },
      model: model((input) => new Promise((_, reject) => {
        input.abortSignal?.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
      }))
    });

    const running = runAgent(agent, { runId: "cancel-active", prompt: "wait" });
    for (let attempt = 0; attempt < 20 && !(await store.load("cancel-active")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await cancelAgentRun(store, "cancel-active", { reason: "operator request" });

    const result = await running;
    expect(result.status).toBe("cancel_requested");
    expect(result.state.cancellationReason).toBe("operator request");
  });

  it("journals identical tool inputs independently when provider call IDs differ", async () => {
    const store = createInMemoryAgentRunStore();
    let modelCalls = 0;
    let sideEffects = 0;
    const agent = createAgent({
      store,
      maxSteps: 2,
      model: model(async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            messages: [{
              role: "assistant",
              parts: ["call-a", "call-b"].map((id) => ({
                type: "tool-call" as const,
                toolCall: { id, name: "append", input: { value: "same" } }
              }))
            }],
            finishReason: "tool-calls"
          };
        }
        return { messages: [createTextMessage("assistant", "done")], text: "done", finishReason: "stop" };
      }),
      tools: {
        append: tool({
          name: "append",
          schema: z.object({ value: z.string() }),
          execute: () => ({ sequence: ++sideEffects })
        })
      }
    });

    const result = await runAgent(agent, { runId: "distinct-tool-calls", prompt: "append twice" });
    const journal = await store.listToolCalls?.("distinct-tool-calls");

    expect(result.status).toBe("completed");
    expect(sideEffects).toBe(2);
    expect(journal).toHaveLength(2);
    expect(new Set(journal?.map((entry) => entry.toolCallId))).toHaveProperty("size", 2);
  });

  it("rejects oversized durable state before writing it", async () => {
    const agent = createAgent({
      policy: { maxStateBytes: 128 },
      model: model(async () => ({ messages: [], finishReason: "stop" }))
    });

    await expect(runAgent(agent, { prompt: "x".repeat(1_000) })).rejects.toBeInstanceOf(ValidationError);
  });
});
