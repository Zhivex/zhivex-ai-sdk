import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateText, tool, type LanguageModel } from "../src/index.js";
import { unknownToolExecution } from "../src/tool-execution-outcome.js";

const fixture = (names: string[]): LanguageModel => ({
  provider: "fixture", modelId: "fixture", capabilities: { tools: true, parallelToolCalls: true },
  generate: vi.fn(async () => ({ messages: [{ role: "assistant", parts: names.map((name, index) => ({ type: "tool-call", toolCall: { id: `call-${index}`, name, input: {} } })) }], finishReason: "tool-calls" }))
} as unknown as LanguageModel);

describe("unknown tool execution outcomes", () => {
  it.each([false, true])("does not recover, continue the model, or launch queued work (parallel=%s)", async parallel => {
    const model = fixture(["mutate", "later"]);
    const error = unknownToolExecution(new Error("lost receipt"));
    const onError = vi.fn(() => ({ ok: true }));
    const later = vi.fn(() => ({}));
    await expect(generateText({ model, prompt: "go", maxSteps: 3, toolExecution: { parallel, maxConcurrency: 1 }, tools: {
      mutate: tool({ name: "mutate", schema: z.object({}), onError, execute: () => { throw error; } }),
      later: tool({ name: "later", schema: z.object({}), execute: later })
    } })).rejects.toBe(error);
    expect(model.generate).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });

  it("serializes computer batches and stops on a generic executor deadline", async () => {
    const model = fixture(["computer", "later"]);
    const later = vi.fn(() => ({}));
    await expect(generateText({ model, prompt: "go", maxSteps: 3, toolExecution: { parallel: true, timeoutMs: 10 }, tools: {
      computer: tool({ name: "computer", schema: z.object({}), metadata: { "openai.responses_tool_type": "computer" }, execute: () => new Promise(() => {}) }),
      later: tool({ name: "later", schema: z.object({}), execute: later })
    } })).rejects.toMatchObject({ outcome: "unknown", effectsPossible: true, retryable: false });
    expect(model.generate).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
  });

  it("never converts a computer validation failure into a recoverable result", async () => {
    const onError = vi.fn(() => ({ ok: true }));
    const failure = new Error("Safety approval denied");
    await expect(generateText({ model: fixture(["computer"]), prompt: "go", maxSteps: 1, tools: {
      computer: tool({ name: "computer", schema: z.object({}), metadata: { "openai.responses_tool_type": "computer" }, onError, execute: () => { throw failure; } })
    } })).rejects.toBe(failure);
    expect(onError).not.toHaveBeenCalled();
  });


  it("rejects unregistered native computer calls even in unknown-tool recovery mode", async () => {
    const model = fixture([]);
    model.generate = vi.fn(async () => ({ message: { role: "assistant", parts: [{ type: "tool-call", toolCall: {
      id: "computer-call", name: "computer", input: { actions: [{ type: "click", x: 1, y: 2 }] }, providerMetadata: { responsesToolType: "computer" }
    } }] }, finishReason: "tool-calls" }));
    await expect(generateText({ model, prompt: "go", maxSteps: 1, toolExecution: { unknownToolMode: "tool-result" } })).rejects.toMatchObject({ code: "TOOL_NOT_REGISTERED" });
    expect(model.generate).toHaveBeenCalledOnce();
  });

});
