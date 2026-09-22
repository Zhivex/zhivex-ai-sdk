import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";
import { createAnthropic } from "@zhivex-ai/anthropic";

// Explicit opt-in keeps routine integration runs bounded. Use official direct APIs.
const enabled = process.env.ZHIVEX_SEPTEMBER_MODELS_LIVE === "1";
for (const id of ["gpt-6-sol", "gpt-6-luna", "claude-opus-5-5"]) {
  const anthropic = id.startsWith("claude");
  const credential = anthropic ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  describe.skipIf(!enabled || !credential)(`${id} direct API`, () => {
    const model = () => anthropic
      ? createAnthropic({ apiKey: credential, baseURL: "https://api.anthropic.com/v1" })(id)
      : createOpenAI({ apiKey: credential, baseURL: "https://api.openai.com/v1" })(id);
    const options = { maxTokens: 1024, reasoning: { effort: "low" as const }, maxRetries: 0, timeoutMs: 45_000 };
    it("generates text with usage", async () => {
      const result = await generateText({ model: model(), prompt: "Reply only: MODEL_OK", ...options });
      expect(result.text).toContain("MODEL_OK");
      expect(result.usage?.totalTokens).toBeGreaterThan(0);
    });
    it("streams text", async () => {
      const result = await streamText({ model: model(), prompt: "Reply only: STREAM_OK", ...options }).collect();
      expect(result.text).toContain("STREAM_OK");
    });
    it("generates native structured output", async () => {
      const result = await generateObject({ model: model(), prompt: "Return the number 5 as value.", schema: z.object({ value: z.number() }), mode: "native", ...options });
      expect(result.object).toEqual({ value: 5 });
      expect(result.objectMode).toBe("native");
    });
    it("executes a tool and continues with preserved history", async () => {
      const execute = vi.fn(({ a, b }: { a: number; b: number }) => ({ total: a + b }));
      const result = await generateText({ model: model(), prompt: "Call sum with a=2 and b=3, then report the result. You must use the tool.", ...options, maxSteps: 3, toolChoice: "auto",
        tools: { sum: tool({ name: "sum", description: "Add two integers", schema: z.object({ a: z.number().int(), b: z.number().int() }), execute }) } });
      expect(execute).toHaveBeenCalled();
      expect(result.text).toContain("5");
    });
  });
}
