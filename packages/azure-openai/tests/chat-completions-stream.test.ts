import { runChatCompletionsStreamContract } from "../../core/tests/chat-completions-contract.js";
import { describe, expect, it, vi } from "vitest";
import { createAzureOpenAI } from "../src/index.js";
import type { StreamEvent } from "@zhivex-ai/core/provider";

const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }] };
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""));
const collect = async (stream: AsyncIterable<StreamEvent>) => {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};
const model = (fetcher: typeof fetch) => createAzureOpenAI({ apiKey: "test", endpoint: "https://example.openai.azure.com", fetch: fetcher })("gpt-4o-mini");

describe("Azure shared Chat Completions streaming", () => {
  it("assembles parallel calls by index and preserves usage after a separate finish event", async () => {
    const fetcher = vi.fn().mockResolvedValue(sse(
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "first", function: { name: "lookup", arguments: '{"id":' } }, { index: 1, id: "second", function: { name: "lookup", arguments: '{"id":2}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } } },
      "[DONE]"
    ));
    const events = await collect(await model(fetcher).stream!(input));
    expect(events).toEqual([
      { type: "tool-call", toolCall: { id: "first", name: "lookup", input: { id: 1 } } },
      { type: "tool-call", toolCall: { id: "second", name: "lookup", input: { id: 2 } } },
      expect.objectContaining({ type: "finish", finishReason: "tool-calls", usage: expect.objectContaining({ totalTokens: 15, cachedInputTokens: 3 }) })
    ]);
  });

  it.each(["length", "content_filter"])("does not emit partial tools after %s", async (finish_reason) => {
    const fetcher = vi.fn().mockResolvedValue(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "{" } }] }, finish_reason }] }, "[DONE]"));
    const events = await collect(await model(fetcher).stream!(input));
    expect(events.map((event) => event.type)).toEqual(["finish"]);
  });

  it.each([
    [{ choices: [{ delta: { content: "partial" } }] }, "without a finish reason"],
    [{ error: { message: "provider error" } }, "stream error"],
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "lookup", arguments: "{" } }] }, finish_reason: "tool_calls" }] }, "malformed tool arguments"],
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "same", function: { name: "a", arguments: "{}" } }, { index: 1, id: "same", function: { name: "b", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }, "Duplicate"]
  ])("rejects invalid streams without yielding executable tools", async (event, error) => {
    const emitted: StreamEvent[] = [];
    const fetcher = vi.fn().mockResolvedValue(sse(event, "[DONE]"));
    await expect((async () => {
      for await (const item of await model(fetcher).stream!(input)) emitted.push(item);
    })()).rejects.toThrow(error);
    expect(emitted.some((item) => item.type === "tool-call")).toBe(false);
  });

  it("cancels the response body when the consumer stops early", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')); }, cancel });
    const fetcher = vi.fn().mockResolvedValue(new Response(body));
    for await (const _event of await model(fetcher).stream!(input)) break;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])("surfaces HTTP failures for responses=%s", async (responses) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("denied", { status: 401 }));
    const instance = createAzureOpenAI({ apiKey: "test", endpoint: "https://example.openai.azure.com", fetch: fetcher })(responses ? "gpt-6-astra" : "gpt-4o-mini");
    await expect(collect(await instance.stream!({ ...input, maxRetries: 0 }))).rejects.toMatchObject({ status: 401 });
  });

  it.each([false, true])("does not dispatch an already aborted request for responses=%s", async (responses) => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn();
      const instance = createAzureOpenAI({ apiKey: "test", endpoint: "https://example.openai.azure.com", fetch: fetcher })(responses ? "gpt-6-astra" : "gpt-4o-mini");
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(instance.stream!({ ...input, timeoutMs: 1000, abortSignal: controller.signal })).rejects.toThrow("cancelled");
      expect(fetcher).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])("cleans timeout resources after a rejected fetch for responses=%s", async (responses) => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockRejectedValue(new Error("network failed"));
      const instance = createAzureOpenAI({ apiKey: "test", endpoint: "https://example.openai.azure.com", fetch: fetcher })(responses ? "gpt-6-astra" : "gpt-4o-mini");
      await expect(instance.stream!({ ...input, timeoutMs: 1000, maxRetries: 0 })).rejects.toThrow("network failed");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

runChatCompletionsStreamContract(async (response) => model(vi.fn().mockResolvedValue(response)).stream!(input));
