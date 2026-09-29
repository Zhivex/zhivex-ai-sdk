import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { createAnthropic } from "../src/index.js";

// Dedicated opt-in: bounded direct-API calls; never silently certify a skipped run.
const enabled = process.env.ZHIVEX_SONNET55_LIVE === "1";
const credential = process.env.ANTHROPIC_API_KEY;
const model = () => createAnthropic({ apiKey: credential, baseURL: "https://api.anthropic.com/v1" })("claude-sonnet-5-5");
const options = { maxTokens: 1024, maxRetries: 0, timeoutMs: 45_000 };

describe.skipIf(!enabled || !credential)("Sonnet 5.5 direct API", () => {
  it("generates without up-front thinking and reports usage", async () => {
    const result = await generateText({ model: model(), prompt: "Reply only: MODEL_OK", reasoning: { effort: "none" }, ...options });
    expect(result.text).toContain("MODEL_OK");
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
  });

  it("streams text with adaptive thinking", async () => {
    const result = await streamText({ model: model(), prompt: "Reply only: STREAM_OK", reasoning: { effort: "low" }, ...options }).collect();
    expect(result.text).toContain("STREAM_OK");
  });

  it("generates native structured output", async () => {
    const result = await generateObject({ model: model(), prompt: "Return the number 5 as value.", schema: z.object({ value: z.number() }), mode: "native", reasoning: { effort: "none" }, ...options });
    expect(result.object).toEqual({ value: 5 });
    expect(result.objectMode).toBe("native");
  });

  it("executes a tool with between_tools and continues with preserved history", async () => {
    const execute = vi.fn(({ a, b }: { a: number; b: number }) => ({ total: a + b }));
    const result = await generateText({ model: model(), prompt: "Call sum with a=2 and b=3, then report the result. You must use the tool.", reasoning: { effort: "none" }, ...options, maxSteps: 3, toolChoice: "auto",
      tools: { sum: tool({ name: "sum", description: "Add two integers", schema: z.object({ a: z.number().int(), b: z.number().int() }), execute }) } });
    expect(execute).toHaveBeenCalled();
    expect(execute.mock.calls[0][0]).toEqual({ a: 2, b: 3 });
    expect(result.text).toContain("5");
  });

  it("accepts progress/binding betas and replays the assistant response", async () => {
    const selected = model();
    const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "Reply only: FIRST_OK" }] }];
    const providerOptions = { thinking: { type: "adaptive" as const, display: "updates" as const, block_binding: { prefix_mismatch_behavior: "error" as const } } };
    const first = await selected.generate({ messages, providerOptions, reasoning: { effort: "low" }, ...options });
    const second = await selected.generate({ messages: [...messages, ...first.messages, { role: "user", parts: [{ type: "text", text: "Reply only: SECOND_OK" }] }], providerOptions, reasoning: { effort: "low" }, ...options });
    expect(second.text).toContain("SECOND_OK");
  });
});
