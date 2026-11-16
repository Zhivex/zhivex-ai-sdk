import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateObject, generateText, streamText, tool, type ModelMessage } from "@zhivex-ai/core";
import { createQwen, QWEN_TOKEN_PLAN_BASE_URL, qwenWebSearchTool } from "../src/index.js";
const messages: ModelMessage[] = [{ role: "user", parts: [{ type: "text", text: "Hello" }] }];
const chat = (message: Record<string, unknown> = { content: "OK" }) => Response.json({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
const responses = (output: unknown[] = [{ type: "message", content: [{ type: "output_text", text: "OK" }] }]) => Response.json({ id: "r1", status: "completed", output });
const sse = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const setup = (id = "qwen4-max", baseURL?: string) => {
  const fetch = vi.fn().mockImplementation(async (url: string) => url.endsWith("/responses") ? responses() : chat());
  return { fetch, model: createQwen({ apiKey: "test", baseURL, fetch: fetch as typeof globalThis.fetch })(id), body: () => JSON.parse(fetch.mock.calls.at(-1)![1].body) };
};

describe("Qwen4 contracts", () => {
  it.each(["qwen4-max", "qwen4-max-preview"])("declares %s capabilities", id => {
    expect(setup(id).model.capabilities).toMatchObject({ vision: true, files: true, reasoning: true, tools: true, parallelToolCalls: true, structuredOutput: true, audioInput: false, inputMediaTypes: ["image/*", "video/*"], reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] });
  });
  it.each(["chat", "responses"] as const)("restricts preview to Token Plan on %s", async apiMode => {
    for (const base of [undefined, "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1?x=1", "https://token-plan.maas.qwencloudapi.com.evil.test/compatible-mode/v1"]) {
      const { model, fetch } = setup("qwen4-max-preview", base);
      await expect(model.generate({ messages, providerOptions: { apiMode } })).rejects.toThrow(/Token Plan/);
      await expect(model.stream({ messages, providerOptions: { apiMode } })).rejects.toThrow(/Token Plan/);
      expect(fetch).not.toHaveBeenCalled();
    }
    const { model, body } = setup("qwen4-max-preview", QWEN_TOKEN_PLAN_BASE_URL);
    await model.generate({ messages, reasoning: { effort: "none" }, providerOptions: { apiMode } });
    expect(body().model).toBe("qwen4-max-preview");
  });
  it.each([["minimal", "low"], ["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "xhigh"], ["max", "xhigh"]] as const)("maps final Chat effort %s to %s", async (effort, native) => {
    const { model, body } = setup();
    await model.generate({ messages, reasoning: { effort }, maxTokens: 1000, providerOptions: { apiMode: "chat" } });
    expect(body()).toMatchObject({ reasoning_effort: native, preserve_thinking: true, max_completion_tokens: 1000 });
    expect(body().max_tokens).toBeUndefined();
  });
  it("keeps preview high mapped to xhigh", async () => {
    const { model, body } = setup("qwen4-max-preview", QWEN_TOKEN_PLAN_BASE_URL);
    await model.generate({ messages, reasoning: { effort: "high" }, providerOptions: { apiMode: "chat" } });
    expect(body().reasoning_effort).toBe("xhigh");
  });
  it("lets upstream apply defaults and budget-only effort mapping", async () => {
    const { model, body } = setup();
    await model.generate({ messages, providerOptions: { apiMode: "chat" } });
    expect(body().reasoning_effort).toBeUndefined();
    expect(body().thinking_budget).toBeUndefined();
    await model.generate({ messages, reasoning: { budgetTokens: 5000 }, providerOptions: { apiMode: "auto" } });
    expect(body()).toMatchObject({ thinking_budget: 5000, preserve_thinking: true });
    expect(body().reasoning_effort).toBeUndefined();
  });
  it.each(["chat", "responses"] as const)("maps summaries and keeps history on %s", async apiMode => {
    const { model, fetch, body } = setup();
    fetch.mockResolvedValueOnce(apiMode === "chat" ? chat({ content: "391", reasoning_content: "Summary", encrypted_content: "cipher==" }) : responses([{ type: "reasoning", id: "think1", summary: [{ type: "summary_text", text: "Summary" }], encrypted_content: "cipher==" }, { type: "message", content: [{ type: "output_text", text: "391" }] }]));
    const options = { apiMode, thinking_display: "summarized" as const, store: false };
    const r = await model.generate({ messages, reasoning: { effort: "high" }, providerOptions: options });
    if (apiMode === "chat") expect(body()).toMatchObject({ thinking_display: "summarized", enable_thinking: true, reasoning_effort: "high" });
    else {
      expect(body().reasoning).toEqual({ effort: "high", summary: "auto" });
      expect(body().thinking_display).toBeUndefined();
    }
    await model.generate({ messages: [...messages, ...r.messages, ...messages], providerOptions: options });
    if (apiMode === "chat") expect(body().messages[1]).toMatchObject({ role: "assistant", reasoning_content: "Summary", encrypted_content: "cipher==" });
    else {
      expect(body().previous_response_id).toBeUndefined();
      expect(body().input.filter((i: any) => i.type === "reasoning")).toEqual([{ type: "reasoning", id: "think1", summary: [{ type: "summary_text", text: "Summary" }], encrypted_content: "cipher==" }]);
    }
  });
  it("retains standalone Chat ciphertext frames and cumulative usage", async () => {
    const { model, fetch, body } = setup();
    fetch.mockResolvedValueOnce(sse([
      { choices: [{ delta: { reasoning_content: "Summary" }, finish_reason: "null" }] },
      { choices: [{ delta: { encrypted_content: "cipher==" }, finish_reason: "null" }] },
      { choices: [{ delta: { content: "391" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
    ]));
    const r = await streamText({ model, messages, providerOptions: { apiMode: "chat", thinking_display: "summarized" } }).collect();
    expect(r.text).toBe("391");
    expect(r.usage?.totalTokens).toBe(13);
    await model.generate({ messages: [...messages, ...r.messages, ...messages], providerOptions: { apiMode: "chat", thinking_display: "summarized" } });
    expect(body().messages.find((m: any) => m.role === "assistant")).toMatchObject({ reasoning_content: "Summary", encrypted_content: "cipher==" });
  });
  it.each([true, false])("retains exactly one completed Responses reasoning snapshot (item-done=%s)", async done => {
    const { model, fetch, body } = setup();
    const item = { type: "reasoning", id: "think1", summary: [{ type: "summary_text", text: "Summary" }], encrypted_content: "cipher==" };
    fetch.mockResolvedValueOnce(sse([
      { type: "response.reasoning_summary_text.delta", delta: "Summary", item_id: "think1", output_index: 0 },
      ...(done ? [{ type: "response.output_item.done", item: { ...item, encrypted_content: "" }, output_index: 0 }] : []),
      { type: "response.output_text.delta", delta: "391" },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [item] } }
    ]));
    const r = await streamText({ model, messages, providerOptions: { apiMode: "responses", thinking_display: "summarized", store: false } }).collect();
    expect(r.text).toBe("391");
    expect(r.messages.flatMap(m => m.parts).filter(p => p.type === "provider-data" && (p.data as any).type === "reasoning")).toHaveLength(1);
    await model.generate({ messages: [...messages, ...r.messages, ...messages], providerOptions: { apiMode: "responses", thinking_display: "summarized", store: false } });
    expect(body().input.filter((i: any) => i.type === "reasoning")).toEqual([item]);
    expect(body().input.some((i: any) => ["reasoning_summary", "reasoning_content"].includes(i.type))).toBe(false);
  });
  it("supports native schema on Chat", async () => {
    const { model, fetch, body } = setup();
    fetch.mockResolvedValueOnce(chat({ content: '{"count":4}' }));
    const r = await generateObject({ model, prompt: "Count 4", schema: z.object({ count: z.number() }), mode: "native", reasoning: { effort: "none" }, providerOptions: { apiMode: "chat" } });
    expect(r.object).toEqual({ count: 4 });
    expect(body().response_format).toMatchObject({ type: "json_schema", json_schema: { schema: { properties: { count: { type: "number" } } } } });
  });
  for (const modelId of ["qwen4-max", "qwen4-max-preview"]) {
    it.each([undefined, "auto", "responses"] as const)(`rejects ${modelId} native schemas with hosted tools before fetching (mode=%s)`, async apiMode => {
      const { model, fetch } = setup(modelId, modelId.endsWith("preview") ? QWEN_TOKEN_PLAN_BASE_URL : undefined);
      const input = { messages, maxTokens: 512, tools: { search: qwenWebSearchTool() },
        structuredOutput: { mode: "native" as const, schema: z.object({ count: z.number() }) }, providerOptions: { apiMode } };
      await expect(model.generate(input)).rejects.toThrow(/native structured output requires Chat/);
      await expect(model.stream(input)).rejects.toThrow(/native structured output requires Chat/);
      expect(fetch).not.toHaveBeenCalled();
    });
  }
  it.each([{ apiMode: "responses" as const }, { max_output_tokens: 512 }])("rejects native Responses schemas without hosted tools (%j)", async providerOptions => {
    const { model, fetch } = setup();
    const input = { messages, structuredOutput: { mode: "native" as const, schema: z.object({ count: z.number() }) }, providerOptions };
    await expect(model.generate(input)).rejects.toThrow(/native structured output requires Chat/);
    await expect(model.stream(input)).rejects.toThrow(/native structured output requires Chat/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("prefers Chat for an auto native schema without Responses-only features", async () => {
    const { model, fetch } = setup();
    await model.generate({ messages, structuredOutput: { mode: "native", schema: z.object({ count: z.number() }) } });
    expect(fetch.mock.calls.at(-1)![0]).toMatch(/\/chat\/completions$/);
  });
  it("allows prompted schemas with hosted tools on Responses", async () => {
    const { model, fetch, body } = setup();
    fetch.mockResolvedValueOnce(responses([{ type: "message", content: [{ type: "output_text", text: '{"count":4}' }] }]));
    const r = await generateObject({ model, prompt: "Count 4", schema: z.object({ count: z.number() }), mode: "prompted", tools: { search: qwenWebSearchTool() } });
    expect(r.object).toEqual({ count: 4 });
    expect(fetch.mock.calls.at(-1)![0]).toMatch(/\/responses$/);
    expect(body().text).toBeUndefined();
    expect(JSON.stringify(body().input)).toContain("count");
  });
  it.each([
    { apiMode: "chat" as const },
    { thinking_budget: 512 },
    { tool_stream: true }
  ])("still rejects hosted schema requests with Chat-only options (%j)", async providerOptions => {
    const { model, fetch } = setup();
    await expect(model.stream({ messages, tools: { search: qwenWebSearchTool() },
      structuredOutput: { mode: "native", schema: z.object({ count: z.number() }) }, providerOptions })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["chat", "responses"] as const)("maps ordered multimodal parts and cache breakpoints on %s", async apiMode => {
    const { model, body } = setup();
    await model.generate({ messages: [{ role: "user", parts: [
      { type: "text", text: "Reference", providerMetadata: { prompt_cache_breakpoint: { mode: "explicit" } } },
      { type: "image", image: "https://example.com/a.png", providerMetadata: { max_pixels: 1000000 } },
      { type: "file", data: "AAA", mediaType: "video/mp4" }
    ] }], providerOptions: { apiMode, prompt_cache_options: { ttl: "1h" } } });
    const parts = (apiMode === "chat" ? body().messages : body().input)[0].content;
    expect(parts[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    expect(parts[1].max_pixels).toBe(1000000);
    expect(parts[2].video_url).toEqual(apiMode === "chat" ? { url: "data:video/mp4;base64,AAA" } : "data:video/mp4;base64,AAA");
    expect(body().prompt_cache_options).toEqual({ ttl: "1h" });
  });
  it("keeps text-only cache markers in a content array", async () => {
    const { model, body } = setup();
    await model.generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Reference", providerMetadata: { cache_control: { type: "ephemeral", ttl: "1h" } } }] }], providerOptions: { apiMode: "chat" } });
    expect(body().messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
  it("preserves reasoning and parallel callable tool results through the SDK loop", async () => {
    const { model, fetch, body } = setup();
    fetch.mockResolvedValueOnce(chat({ reasoning_content: "Summary", encrypted_content: "cipher==", tool_calls: ["a", "b"].map(id => ({ id, type: "function", function: { name: "lookup", arguments: JSON.stringify({ id }) } })) }));
    fetch.mockResolvedValueOnce(chat({ content: "OK" }));
    const execute = vi.fn(async ({ id }: { id: string }) => ({ id }));
    await generateText({ model, messages, tools: { lookup: tool({ name: "lookup", schema: z.object({ id: z.string() }), execute }) }, maxSteps: 2, providerOptions: { apiMode: "chat", thinking_display: "summarized", parallel_tool_calls: true } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(body().messages.find((m: any) => m.role === "assistant").encrypted_content).toBe("cipher==");
    expect(body().messages.filter((m: any) => m.role === "tool")).toHaveLength(2);
  });
  it("routes hosted tools through Responses", async () => {
    const { model, body } = setup();
    await model.generate({ messages, tools: { search: qwenWebSearchTool() }, maxTokens: 512 });
    expect(body().tools[0].type).toBe("web_search");
    expect(body().max_output_tokens).toBe(512);
  });
  it.each([
    { reasoning: { effort: "none" as const }, providerOptions: { thinking_display: "summarized" as const } },
    { reasoning: { effort: "high" as const, budgetTokens: 32 } },
    { reasoning: { budgetTokens: 0 } },
    { maxTokens: 262145 },
    { reasoning: { effort: "none" as const }, maxTokens: 131073 },
    { providerOptions: { preserve_thinking: false } },
    { providerOptions: { n: 2 } },
    { providerOptions: { thinking_display: "wrong" } },
    { providerOptions: { reasoning: { effort: "low" }, reasoning_effort: "low" } },
    { providerOptions: { prompt_cache_options: { ttl: "forever" } } },
    { messages: [{ role: "user", parts: [{ type: "audio", data: "AAA", mediaType: "audio/wav" }] }] },
    { messages: [{ role: "user", parts: [{ type: "file", data: "AAA", mediaType: "application/pdf" }] }] }
  ])("rejects invalid request before fetch (%j)", async override => {
    const { model, fetch } = setup();
    const input = { messages, ...override } as Parameters<typeof model.generate>[0];
    await expect(model.generate(input)).rejects.toThrow();
    await expect(model.stream(input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["chat", "responses"] as const)("reports explicit cache writes on %s", async apiMode => {
    const { model, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json(apiMode === "chat" ? {
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 976 } }
    } : { status: "completed", output_text: "OK", usage: { input_tokens: 2000, output_tokens: 1, input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 976 } } }));
    expect((await model.generate({ messages, providerOptions: { apiMode } })).usage).toMatchObject({ cachedInputTokens: 1024, cacheWriteTokens: 976 });
  });
  it("routes raw JSON-object mode to Chat instead of discarding it", async () => {
    const { model, body } = setup();
    await model.generate({ messages, providerOptions: { response_format: { type: "json_object" } } });
    expect(body().response_format).toEqual({ type: "json_object" });
  });
  it("rejects conflicting ciphertext within one message", async () => {
    const { model, fetch } = setup();
    await expect(model.generate({ messages: [{ role: "assistant", parts: [
      { type: "provider-data", provider: "qwen", data: { type: "encrypted_content", encryptedContent: "a" } },
      { type: "provider-data", provider: "qwen", data: { type: "encrypted_content", encryptedContent: "b" } }
    ] }] })).rejects.toThrow(/unchanged/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not infer final-model features for the preview", async () => {
    const { model, fetch } = setup("qwen4-max-preview", QWEN_TOKEN_PLAN_BASE_URL);
    await expect(model.generate({ messages, providerOptions: { thinking_display: "summarized" } })).rejects.toThrow(/preview/);
    await expect(model.generate({ messages, providerOptions: { prompt_cache_options: {} } })).rejects.toThrow(/qwen4-max/);
    await expect(model.generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Cache", providerMetadata: { prompt_cache_breakpoint: { mode: "explicit" } } }] }] })).rejects.toThrow(/final/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("surfaces provider HTTP errors", async () => {
    const { model, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json({ error: { code: "rate_limit" } }, { status: 429 }));
    await expect(model.generate({ messages, maxRetries: 0 })).rejects.toThrow(/429/);
  });
});
