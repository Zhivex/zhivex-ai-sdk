import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createChatCompletionsModel } from "../src/chat-completions.js";
import { tool } from "../src/messages.js";
import type { ModelCapabilities, ModelGenerateInput, StreamEvent } from "../src/types.js";

const capabilities: ModelCapabilities = { streaming: true, tools: true, structuredOutput: true, jsonMode: true, toolChoice: true, parallelToolCalls: true, vision: true, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: true, webSearch: false };
const input: ModelGenerateInput = { messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] };
const sse = (...items: unknown[]) => new Response(items.map((item) => `data: ${typeof item === "string" ? item : JSON.stringify(item)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const setup = () => {
  const send = vi.fn();
  return { send, model: createChatCompletionsModel({ provider: "host", modelId: "author/model", capabilities, send }) };
};
const collect = async (events: AsyncIterable<StreamEvent>) => { const result = []; for await (const event of events) result.push(event); return result; };

describe("hosted Chat Completions transport", () => {
  it("enforces capabilities for native options and streaming before dispatch", async () => {
    const send = vi.fn().mockImplementation(async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const model = createChatCompletionsModel({ provider: "host", modelId: "restricted", capabilities: { ...capabilities, streaming: false, toolChoice: false, parallelToolCalls: false, structuredOutput: false, jsonMode: false }, send });
    for (const providerOptions of [{ tool_choice: "auto" }, { parallel_tool_calls: true }, { response_format: { type: "json_schema", json_schema: {} } }, { response_format: { type: "json_object" } }]) {
      await expect(model.generate({ ...input, providerOptions })).rejects.toThrow("does not support");
    }
    await expect(async () => collect(await model.stream!(input))).rejects.toThrow("streaming");
    expect(send).not.toHaveBeenCalled();
    await model.generate({ ...input, providerOptions: { parallel_tool_calls: false, response_format: { type: "text" } } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ prompt_tokens: 100, completion_tokens: 9, total_tokens: 109, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 3 } }, { inputTokens: 100, cachedInputTokens: 80, outputTokens: 9, reasoningTokens: 3, totalTokens: 109 }],
    [{ prompt_tokens: 100, completion_tokens: 9, cachedContentTokenCount: 70, reasoning_tokens: 2 }, { inputTokens: 100, cachedInputTokens: 70, outputTokens: 9, reasoningTokens: 2 }],
    [{ prompt_tokens_details: { cached_tokens: 0 }, cachedContentTokenCount: 70 }, { cachedInputTokens: 0 }]
  ])("preserves cache usage from completion and terminal stream metadata", async (wireUsage, expected) => {
    const { model, send } = setup();
    send.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: wireUsage }));
    expect((await model.generate(input)).usage).toMatchObject(expected);
    send.mockResolvedValueOnce(sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, { choices: [], usage: wireUsage }, "[DONE]"));
    const events = await collect(await model.stream!(input));
    expect(events.at(-1)).toMatchObject({ type: "finish", usage: expected });
  });

  it("maps complete tool history, images, schema and host reasoning", async () => {
    const { model, send } = setup();
    send.mockResolvedValue(Response.json({ choices: [{ message: { content: "ok", reasoning_content: "trace" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, reasoning_tokens: 2 } }));
    const result = await model.generate({ ...input, messages: [
      { role: "user", parts: [{ type: "image", image: "YQ==", mediaType: "image/png" }] },
      { role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "lookup", input: { id: 1 } } }, { type: "provider-data", provider: "host", data: { type: "reasoning_content", reasoningContent: "earlier" } }] },
      { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "call-1", toolName: "lookup", output: { found: true }, isError: false } }] }
    ], tools: { lookup: tool({ name: "lookup", description: "lookup", schema: z.object({ id: z.number() }), execute: async () => ({ found: true }) }) },
    structuredOutput: { mode: "native", schema: z.object({ ok: z.boolean() }) }, toolChoice: { type: "tool", toolName: "lookup" } });
    const body = send.mock.calls[0][0];
    expect(body.messages[0].content[0].image_url.url).toBe("data:image/png;base64,YQ==");
    expect(body.messages[1].reasoning_content).toBe("earlier");
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "call-1", content: '{"found":true}' });
    expect(body.tool_choice.function.name).toBe("lookup");
    expect(body.response_format.type).toBe("json_schema");
    expect(result.messages![0].parts[1]).toMatchObject({ provider: "host", data: { reasoningContent: "trace" } });
    expect(result.usage).toMatchObject({ inputTokens: 5, reasoningTokens: 2 });
  });

  it("retains trailing usage and assembles parallel fragmented tool calls", async () => {
    const { model, send } = setup();
    send.mockResolvedValue(sse(
      { choices: [{ index: 0, delta: { reasoning_content: "trace", tool_calls: [{ index: 0, id: "a", function: { name: "lookup", arguments: '{"x":' } }, { index: 1, id: "b", function: { name: "lookup", arguments: '{"x":2}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 } }, "[DONE]"));
    const events = await collect(await model.stream!(input));
    expect(events.filter((e) => e.type === "tool-call").map((e: any) => e.toolCall)).toEqual([{ id: "a", name: "lookup", input: { x: 1 } }, { id: "b", name: "lookup", input: { x: 2 } }]);
    expect(events.at(-1)).toMatchObject({ type: "finish", usage: { totalTokens: 13 } });
    expect(events[0]).toMatchObject({ type: "provider-data", provider: "host" });
  });

  it("never executes truncated tool arguments", async () => {
    const { model, send } = setup();
    send.mockResolvedValue(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "lookup", arguments: '{"x":' } }] }, finish_reason: "length" }] }, "[DONE]"));
    const events = await collect(await model.stream!(input));
    expect(events.some((e) => e.type === "tool-call")).toBe(false);
  });

  it("rejects a prematurely disconnected stream", async () => {
    const { model, send } = setup();
    send.mockResolvedValue(sse({ choices: [{ delta: { content: "partial" } }] }));
    await expect(collect(await model.stream!(input))).rejects.toThrow("without a finish reason");
  });

  it("retries HTTP 429 with a shared cancellation signal", async () => {
    const { model, send } = setup();
    send.mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    const abort = new AbortController();
    expect((await model.generate({ ...input, abortSignal: abort.signal, maxRetries: 1, retryBackoffMs: 0 })).text).toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1]);
    expect(send.mock.calls[0][1].aborted).toBe(false);
  });
  it("forwards cancellation while a request is active", async () => {
    const { model, send } = setup();
    const abort = new AbortController();
    send.mockImplementation((_body, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pending = model.generate({ ...input, abortSignal: abort.signal, maxRetries: 0 });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    abort.abort(new Error("cancelled"));
    await rejected;
    expect(send.mock.calls[0][1].aborted).toBe(true);
  });

});
