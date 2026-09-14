import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMockLanguageModel } from "../../core/src/testing.js";
import { type TokenUsage } from "@zhivex-ai/core";
import { createGateway } from "../src/index.js";

const full: TokenUsage = { inputTokens: 100, cachedInputTokens: 80, cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 5, totalTokens: 120, speed: "fast" };
const fixtures = [full, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, speed: "standard" } as TokenUsage, { cachedInputTokens: 8, reasoningTokens: 2 } as TokenUsage, undefined];

describe("gateway complete usage contract", () => {
  for (const operation of ["generate", "generateObject", "streamText", "streamObject"] as const) {
    it.each(fixtures)(`${operation} preserves reported fields and only estimates missing base counters: %j`, async usage => {
      const text = '{"answer":"ok"}';
      const model = createMockLanguageModel({ responses: [{ text, messages: [{ role: "assistant", parts: [{ type: "text", text }] }], usage, finishReason: "stop" }] });
      model.stream = async () => (async function* () {
        yield { type: "text-delta" as const, textDelta: text };
        yield { type: "finish" as const, finishReason: "stop" as const, usage };
      })();
      const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model } } });
      const request = { primary: { provider: "gemini" as const, modelId: "test" }, messages: [{ role: "user" as const, content: "hello" }], schema: z.object({ answer: z.string() }) };
      const output = operation === "generate" ? await gateway.generate(request)
        : operation === "generateObject" ? await gateway.generateObject(request)
        : operation === "streamText" ? await gateway.streamText(request).collect()
        : await gateway.streamObject(request).collect();
      expect(output.usage).toMatchObject(usage ?? {});
      expect(output.usage.estimated).toBe(usage?.inputTokens === undefined || usage?.outputTokens === undefined || usage?.totalTokens === undefined);
      for (const key of ["cachedInputTokens", "cacheWriteTokens", "reasoningTokens", "speed"] as const) expect(output.usage[key]).toBe(usage?.[key]);
      if (usage?.totalTokens !== undefined) expect(output.usage.totalTokens).toBe(usage.totalTokens);
    });
  }
});

it("preserves multi-step agent usage without adding reasoning to total twice", async () => {
  const model = createMockLanguageModel({ responses: [
    { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "read-1", name: "read", input: {} } }] }], usage: full, finishReason: "tool-calls" },
    { messages: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }], text: "done", usage: full, finishReason: "stop" }
  ] });
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model } } });
  const result = await gateway.runAgent({ primary: { provider: "gemini", modelId: "test" }, prompt: "read", maxSteps: 2, tools: { read: { name: "read", schema: z.object({}), execute: () => "ok" } } });
  expect(result.usage).toEqual({ inputTokens: 200, cachedInputTokens: 160, cacheWriteTokens: 20, outputTokens: 40, reasoningTokens: 10, totalTokens: 240, speed: "fast" });
});
