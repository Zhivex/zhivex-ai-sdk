import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "@zhivex-ai/core";
import { createOpenAI } from "../src/index.js";

const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];
const tools = { sum: tool({ name: "sum", schema: z.object({}), execute: () => 5 }) };

describe.each(["gpt-6-sol", "gpt-6-luna"])("%s request compatibility", (id) => {
  it("rejects unsupported efforts, sampling, and Chat tools with reasoning before I/O", async () => {
    const fetcher = vi.fn();
    const model = createOpenAI({ apiKey: "test", fetch: fetcher })(id);
    const invalid = [
      { reasoning: { effort: "minimal" as const } },
      { temperature: 0 },
      { providerOptions: { top_p: 0.9 } },
      { providerOptions: { top_logprobs: 1 } },
      { providerOptions: { include: ["message.output_text.logprobs"] } },
      { providerOptions: { apiMode: "chat" as const, logprobs: true } },
      { tools, providerOptions: { apiMode: "chat" as const } },
      { tools, providerOptions: { apiMode: "chat" as const, reasoning_effort: "high" } },
    ];
    for (const options of invalid) {
      await expect(model.generate({ messages, ...options })).rejects.toThrow();
      await expect(model.stream({ messages, ...options })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows Chat function calls and sampling with explicit effort none", async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const model = createOpenAI({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    await model.generate({ messages, tools, reasoning: { effort: "none" }, temperature: 0,
      providerOptions: { apiMode: "chat", top_p: 0.9 } });
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: id, reasoning_effort: "none", temperature: 0, top_p: 0.9,
      tools: [{ type: "function", function: { name: "sum" } }] });
  });

  it("maps native structured output and max effort through Responses", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }] }));
    const model = createOpenAI({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    await model.generate({ messages, reasoning: { effort: "max" }, structuredOutput: { mode: "native", name: "result", schema: z.object({ ok: z.boolean() }) } });
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(String(init.body))).toMatchObject({ reasoning: { effort: "max" }, text: { format: { type: "json_schema", name: "result" } } });
  });
});

it("does not infer GPT-6 Sol/Luna capabilities for unrelated model IDs", () => {
  const provider = createOpenAI({ apiKey: "test" });
  for (const id of ["gpt-6-sol-preview", "gpt-6-luna-other", "gpt-6-solar", "gpt-6-terra"]) {
    expect(provider(id).capabilities.explicitPromptCaching).toBe(false);
  }
});
