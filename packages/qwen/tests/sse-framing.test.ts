import { expect, it, vi } from "vitest";
import { Agent, createInMemoryAgentRunStore, createTextMessage, normalizeAgentRunState, type StreamEvent } from "@zhivex-ai/core";
import { createQwen } from "../src/index.js";

const frame = (data: unknown, eol = "\n") => `data: ${JSON.stringify(data)}${eol}${eol}`;
const run = async (body: string, apiMode: "chat" | "responses") => {
  const fetch = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const model = createQwen({ apiKey: "offline-fixture", fetch: fetch as typeof globalThis.fetch })("deepseek-v4.1-flash");
  const events: StreamEvent[] = []; let error: unknown;
  try { for await (const event of await model.stream({ messages: [createTextMessage("user", "offline-fixture")], providerOptions: { apiMode } })) events.push(event); }
  catch (caught) { error = caught; }
  return { events, error, fetch };
};
const completed = { type: "response.completed", response: { id: "resp-fixture", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
const chatFinish = { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };

it.each(["\n", "\r\n", "\r"])("accepts DeepSeek Responses framing with %j", async eol => {
  const { events, error, fetch } = await run(`: heartbeat${eol}${eol}` + frame({ type: "response.output_text.delta", delta: "hello" }, eol) + frame(completed, eol) + `data: [DONE]${eol}${eol}`, "responses");
  expect(error).toBeUndefined();
  expect(events.filter(e => e.type === "text-delta")).toEqual([{ type: "text-delta", textDelta: "hello" }]);
  expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", providerFinishReason: "completed" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toContain("/responses");
});

it.each(["\n", "\r\n", "\r"])("accepts DeepSeek Chat framing with %j", async eol => {
  const { events, error } = await run(frame({ choices: [{ delta: { content: "hello" }, finish_reason: null }] }, eol) + frame(chatFinish, eol) + `data: [DONE]${eol}${eol}`, "chat");
  expect(error).toBeUndefined();
  expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1 } });
});

it.each(["chat", "responses"] as const)("rejects malformed dispatched JSON with sanitized diagnostics (%s)", async mode => {
  const { events, error } = await run('data: {private-provider-detail\n\n', mode);
  expect(events.some(e => e.type === "finish" || e.type === "tool-call")).toBe(false);
  expect(error).toMatchObject({ diagnosticCode: "QWEN_SSE_EVENT_INVALID", provider: "qwen", transport: mode, reason: "invalid_json", retryable: false });
  expect(String(error)).not.toContain("private-provider-detail");
});

it.each(["null", "[]", "42", '"private-provider-detail"'])("rejects invalid event objects: %s", async data => {
  const { error } = await run(`data: ${data}\n\n`, "responses");
  expect(error).toMatchObject({ diagnosticCode: "QWEN_SSE_EVENT_INVALID", reason: "invalid_event" });
  expect(String(error)).not.toContain("private-provider-detail");
});

it("never accepts an unterminated Responses completion at EOF", async () => {
  const { events, error } = await run(`data: ${JSON.stringify(completed)}\n`, "responses");
  expect(events.some(e => e.type === "finish")).toBe(false);
  expect(error).toMatchObject({ reason: "stream_truncated", retryable: false });
});

it.each(["", "data: [DONE]\n\n", frame({ choices: [{ delta: { content: "partial" } }] }), frame({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })])
  ("rejects Chat without a terminal finish reason: %j", async body => {
    const { events, error } = await run(body, "chat");
    expect(events.some(e => e.type === "finish" || e.type === "tool-call")).toBe(false);
    expect(error).toMatchObject({ reason: "stream_truncated", retryable: false });
  });

it("preserves valid provider errors as failures, without raw error contents", async () => {
  const { events, error } = await run(frame({ type: "error", error: { message: "private-provider-detail" } }), "responses");
  expect(events.some(e => e.type === "finish")).toBe(false);
  expect(error).toMatchObject({ diagnosticCode: "QWEN_RESPONSE_FAILED" });
  expect(String(error)).not.toContain("private-provider-detail");
});

it.each(["chat", "responses"] as const)("persists the sanitized parser failure for an agent (%s)", async apiMode => {
  const store = createInMemoryAgentRunStore();
  const model = createQwen({ apiKey: "offline-fixture", fetch: async () => new Response('data: {private-provider-detail\n\n') })("deepseek-v4.1-flash");
  const stream = new Agent({ model, store }).stream({ runId: `invalid-${apiMode}`, prompt: "offline-fixture", providerOptions: { apiMode } });
  const output = stream.collect().catch(error => error);
  const events = await Array.fromAsync(stream.eventStream).catch(() => []);
  await output;
  const state = await store.load(`invalid-${apiMode}`);
  expect(state?.status).toBe("failed");
  expect(state?.error).toMatchObject({ category: "provider-stream", diagnosticCode: "QWEN_SSE_EVENT_INVALID", provider: "qwen", transport: apiMode, reason: "invalid_json", retryable: false });
  expect(normalizeAgentRunState(state).error).toEqual(state?.error);
  expect(JSON.stringify(state?.error)).not.toContain("private-provider-detail");
  expect(events.some(event => event.type === "tool-call" || event.type === "finish")).toBe(false);
});

it.each(["chat", "responses"] as const)("does not finish or dispatch tools after cancellation (%s)", async apiMode => {
  const controller = new AbortController();
  const call = { type: "function_call", id: "call-fixture", call_id: "call-fixture", name: "fixture", arguments: "{}" };
  const terminal = apiMode === "responses" ? { ...completed, response: { ...completed.response, output: [call] } }
    : { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-fixture", function: { name: "fixture", arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
  const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(frame(terminal))); controller.abort(); stream.close(); } });
  const model = createQwen({ apiKey: "offline-fixture", fetch: async () => new Response(body) })("deepseek-v4.1-flash");
  const events: StreamEvent[] = [];
  let error: unknown;
  try { for await (const event of await model.stream({ messages: [], abortSignal: controller.signal, providerOptions: { apiMode } })) events.push(event); }
  catch (caught) { error = caught; }
  expect(error).toMatchObject({ name: "AbortError" });
  expect(events.some(event => event.type === "tool-call" || event.type === "finish")).toBe(false);
});

it("preserves a complete tool batch with multiline CR data", async () => {
  const terminal = { ...completed, response: { ...completed.response, output: [{ type: "function_call", id: "fc-fixture", call_id: "call-fixture", name: "fixture", arguments: '{"value":1}' }] } };
  const lines = JSON.stringify(terminal, null, 2).split("\n").map(line => `data: ${line}`).join("\r");
  const { events, error } = await run(`${lines}\r\rdata: [DONE]\r\r`, "responses");
  expect(error).toBeUndefined();
  expect(events.filter(event => event.type === "tool-call")).toEqual([{ type: "tool-call", toolCall: { id: "call-fixture", name: "fixture", input: { value: 1 } } }]);
  expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
});
