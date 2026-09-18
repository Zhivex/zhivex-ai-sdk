import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateText, generateObject, tool, type ModelGenerateInput, type ModelMessage } from "@zhivex-ai/core";
import { createQwen, qwenWebSearchTool, qwenFileSearchTool } from "../src/index.js";
const ids = ["deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731", "glm-5.2", "glm-5.3", "ZHIPU/GLM-5.3", "kimi-k3", "MiniMax-M2.5"];
const messages: ModelMessage[] = [{ role: "user", parts: [{ type: "text", text: "Hello" }] }];
const fixture = (id: string) => {
  const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => new Response(JSON.stringify({
    id: "r1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    choices: [{ message: { content: "ok", reasoning_content: "reason" }, finish_reason: "stop" }]
  })));
  const model = createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })(id);
  return { model, fetch, body: () => JSON.parse(String(fetch.mock.calls.at(-1)![1].body)) };
};
describe("QwenCloud third-party contracts", () => {
  it.each(ids)("%s defaults to its supported protocol and preserves the exact model ID", async id => {
    const { model, fetch, body } = fixture(id);
    expect(model.capabilities.reasoning).toBe(true);
    expect(model.capabilities.agentCapabilities).toMatchObject({ hostedFileSearch: false, remoteMcp: false });
    await model.generate({ messages });
    expect(String(fetch.mock.calls[0]![0]).endsWith(id === "MiniMax-M2.5" || id === "ZHIPU/GLM-5.3" ? "/chat/completions" : "/responses")).toBe(true);
    expect(body().model).toBe(id);
    expect(body().preserve_thinking).toBeUndefined();
  });
  it.each([
    ["deepseek-v4-pro", "low", "high", "high"],
    ["deepseek-v4-flash", "xhigh", "max", "max"],
    ["deepseek-v4-pro-0813", "xhigh", "high", "max"],
    ["deepseek-v4-flash-0731", "medium", "high", "high"],
    ["deepseek-v4.1-flash", "xhigh", "high", "high"],
    ["deepseek-v4.1-flash", "minimal", "low", "low"],
    ["glm-5.2", "low", "high", "high"],
    ["glm-5.3", "xhigh", "max", "max"],
    ["kimi-k3", "minimal", "low", "low"]
  ] as const)("%s maps %s separately for Chat and Responses", async (id, effort, chat, responses) => {
    const { model, body } = fixture(id);
    await model.generate({ messages, reasoning: { effort }, providerOptions: { apiMode: "chat" } });
    expect(body()).toMatchObject({ enable_thinking: true, reasoning_effort: chat });
    await model.generate({ messages, reasoning: { effort }, providerOptions: { apiMode: "responses" } });
    expect(body().reasoning).toEqual({ effort: responses });
    expect(body().reasoning_effort).toBeUndefined();
    expect(body().enable_thinking).toBeUndefined();
  });
  it.each(["deepseek-v4.1-flash", "glm-5.2", "kimi-k3"])("%s disables thinking in both protocols", async id => {
    const { model, body } = fixture(id);
    await model.generate({ messages, reasoning: { effort: "none" }, providerOptions: { apiMode: "chat" } });
    expect(body().enable_thinking).toBe(false);
    expect(body().reasoning_effort).toBeUndefined();
    await model.generate({ messages, providerOptions: { enable_thinking: false, apiMode: "responses" } });
    expect(body().reasoning).toEqual({ effort: "none" });
  });
  it.each(ids)("%s preserves streamed reasoning, text, tool calls, and usage", async id => {
    const chunks = [
      { choices: [{ delta: { reasoning_content: "Plan" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: '{"x":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ delta: { content: "ok" }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    ];
    const fetch = vi.fn(async () => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"));
    const model = createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })(id);
    const events = [];
    for await (const event of await model.stream({ messages, providerOptions: { apiMode: "chat" } })) events.push(event);
    expect(events.some(e => e.type === "provider-data")).toBe(true);
    expect(events.some(e => e.type === "tool-call")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "finish", usage: { totalTokens: 15 } });
  });
  it.each(["deepseek-v4.1-flash", "kimi-k3"])("%s maps images in both protocols", async id => {
    const { model, body } = fixture(id);
    expect(model.capabilities.vision).toBe(true);
    const image: ModelMessage[] = [{ role: "user", parts: [{ type: "image", image: "https://example.com/a.png" }] }];
    await model.generate({ messages: image, providerOptions: { apiMode: "chat" } });
    expect(body().messages[0].content[0].type).toBe("image_url");
    await model.generate({ messages: image, providerOptions: { apiMode: "responses" } });
    expect(body().input[0].content[0].type).toBe("input_image");
  });
  it.each(ids)("%s preserves Chat tool continuation and reasoning history", async id => {
    const execute = vi.fn(() => ({ value: 42 }));
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit): Promise<Response> => new Response(JSON.stringify({ choices: [{
      message: fetch.mock.calls.length === 1 ? { content: "", reasoning_content: "Need lookup", tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }] } : { content: "42" },
      finish_reason: fetch.mock.calls.length === 1 ? "tool_calls" : "stop"
    }] })));
    const result = await generateText({ model: createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })(id),
      messages, tools: { lookup: tool({ name: "lookup", description: "lookup", schema: z.object({}), execute }) }, maxSteps: 3, providerOptions: { apiMode: "chat" } });
    expect(result.text).toBe("42"); expect(execute).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[1]![1].body));
    expect(body.messages.find((m: any) => m.role === "assistant")).toMatchObject({ reasoning_content: "Need lookup", tool_calls: [{ id: "c1" }] });
    expect(body.messages.find((m: any) => m.role === "tool").tool_call_id).toBe("c1");
  });
  it("maps DeepSeek total token limits and GLM thinking budget without Qwen-only fields", async () => {
    const ds = fixture("deepseek-v4.1-flash"); await ds.model.generate({ messages, maxTokens: 128 });
    expect(ds.body().max_completion_tokens).toBe(128); expect(ds.body().max_tokens).toBeUndefined();
    const glm = fixture("glm-5.2"); await glm.model.generate({ messages, maxTokens: 128, reasoning: { budgetTokens: 512 } });
    expect(glm.body()).toMatchObject({ max_tokens: 128, thinking_budget: 512, clear_thinking: false });
  });
  it("routes supported hosted tools to Responses", async () => {
    const f = fixture("kimi-k3"); await f.model.generate({ messages, tools: { search: qwenWebSearchTool() } });
    expect(f.body().tools).toEqual([{ type: "web_search" }]);
  });
  it.each([
    ["glm-5.3", { reasoning: { effort: "none" } }],
    ["ZHIPU/GLM-5.3", { providerOptions: { apiMode: "responses" } }],
    ["MiniMax-M2.5", { reasoning: { effort: "high" } }],
    ["MiniMax-M2.5", { tools: { search: qwenWebSearchTool() } }],
    ["kimi-k3", { reasoning: { budgetTokens: 100 } }],
    ["deepseek-v4.1-flash", { providerOptions: { preserve_thinking: true } }],
    ["glm-5.2", { reasoning: { effort: "high" }, providerOptions: { enable_thinking: false } }],
    ["glm-5.2", { reasoning: { effort: "high" }, providerOptions: { reasoning_effort: "high" } }],
    ["glm-5.2", { tools: { files: qwenFileSearchTool({}) } }],
    ["glm-5.2", { messages: [{ role: "user", parts: [{ type: "image", image: "https://example.com/a.png" }] }] }],
    ["kimi-k3", { providerOptions: { response_format: { type: "json_schema" } } }]
  ] as const)("%s rejects incompatible requests before fetch (generate and stream)", async (id, options) => {
    const f = fixture(id); const input = { messages, ...options } as ModelGenerateInput;
    await expect(f.model.generate(input)).rejects.toThrow();
    await expect(f.model.stream(input)).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("uses JSON Object with schema prompt and requires non-thinking GLM 5.2", async () => {
    const f = fixture("glm-5.2");
    const structuredOutput = { mode: "native" as const, schema: z.object({ ok: z.boolean() }) };
    await expect(f.model.generate({ messages, structuredOutput })).rejects.toThrow("thinking disabled");
    await f.model.generate({ messages, structuredOutput, reasoning: { effort: "none" } });
    expect(f.body().response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(f.body().messages)).toContain("JSON");
  });
  it("allows prompted object output on MiniMax without advertising native JSON", async () => {
    const f = fixture("MiniMax-M2.5"); f.fetch.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] })));
    expect(f.model.capabilities.structuredOutput).toBe(false);
    const result = await generateObject({ model: f.model, prompt: "Return ok true", schema: z.object({ ok: z.boolean() }), mode: "prompted" });
    expect(result.object).toEqual({ ok: true }); expect(f.body().response_format).toBeUndefined();
  });
});

describe("third-party Responses and errors", () => {
  const responseIds = ids.filter(id => id !== "MiniMax-M2.5" && id !== "ZHIPU/GLM-5.3");
  it.each(responseIds)("%s streams Responses text, reasoning, calls and usage", async id => {
    const chunks = [
      { type: "response.reasoning_text.delta", delta: "Plan" },
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "c1", name: "lookup", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc1", delta: '{}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "c1", name: "lookup", arguments: '{}' } },
      { type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }
    ];
    const fetch = vi.fn(async () => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("")));
    const model = createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })(id);
    const events = [];
    for await (const event of await model.stream({ messages })) events.push(event);
    expect(events.some(e => e.type === "text-delta")).toBe(true);
    expect(events.some(e => e.type === "tool-call")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "finish", usage: { totalTokens: 15 } });
  });
  it.each(responseIds.filter(id => id !== "glm-5.2"))("%s continues Responses function results with the response ID", async id => {
    const execute = vi.fn(() => "42");
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit): Promise<Response> => new Response(JSON.stringify({
      id: "r1", status: "completed", output: fetch.mock.calls.length === 1 ?
        [{ type: "function_call", id: "fc1", call_id: "c1", name: "lookup", arguments: "{}" }] :
        [{ type: "message", content: [{ type: "output_text", text: "42" }] }]
    })));
    const result = await generateText({ model: createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })(id), messages,
      tools: { lookup: tool({ name: "lookup", description: "lookup", schema: z.object({}), execute }) }, maxSteps: 3 });
    expect(result.text).toBe("42"); expect(execute).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[1]![1].body));
    expect(body.previous_response_id).toBe("r1");
    expect(body.input).toContainEqual({ type: "function_call_output", call_id: "c1", output: '"42"' });
  });
  it.each(ids)("%s surfaces HTTP errors in both execution paths", async id => {
    const fetch = vi.fn(async () => new Response('{"error":{"message":"model unavailable"}}', { status: 403 }));
    const model = createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })(id);
    await expect(model.generate({ messages, maxRetries: 0 })).rejects.toThrow("403");
    await expect(model.stream({ messages, maxRetries: 0 })).rejects.toThrow("403");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("retains explicit enabled thinking after stripping Chat-only options in Responses", async () => {
    const f = fixture("glm-5.2");
    await f.model.generate({ messages, providerOptions: { enable_thinking: true } });
    expect(f.body().reasoning).toEqual({ effort: "high" });
  });
});

it("routes GLM 5.2 callable tools to Chat and rejects forced Responses before fetch", async () => {
  const f = fixture("glm-5.2");
  const tools = { lookup: tool({ name: "lookup", description: "lookup", schema: z.object({}), execute: () => "42" }) };
  await f.model.generate({ messages, tools });
  expect(String(f.fetch.mock.calls[0]![0])).toContain("/chat/completions");
  f.fetch.mockClear();
  for (const method of ["generate", "stream"] as const) {
    await expect(f.model[method]({ messages, tools, providerOptions: { apiMode: "responses" } })).rejects.toThrow("function continuation is unavailable");
  }
  expect(f.fetch).not.toHaveBeenCalled();
});
