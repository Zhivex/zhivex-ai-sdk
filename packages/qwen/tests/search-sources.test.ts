import { expect, it, vi } from "vitest";
import { createTextMessage, type StreamEvent } from "@zhivex-ai/core";
import { createQwen, qwenWebSearchTool } from "../src/index.js";
const messages = [createTextMessage("user", "Search")];
const citation = { type: "url_citation", url: "https://example.com", title: "Source", start_index: 0, end_index: 5, private: "SECRET" };
const part = { type: "output_text", text: "Hello", annotations: [citation] };
const item = { type: "message", id: "msg_1", content: [part] };
const usage = { input_tokens: 10, output_tokens: 16, total_tokens: 26 };
const searchItem = { type: "web_search_call", id: "search_1", status: "completed", action: { type: "search", sources: [{ type: "url", url: "https://example.com/source" }] } };
const searchEvents = (events: StreamEvent[]) => events.filter(event => event.type === "provider-data" && (event.data as any)?.type === "web_search_call");
const terminal = (status = "completed", output: unknown[] = [item]) => ({ type: `response.${status}`, response: { status, output, usage } });
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const collect = async (events: unknown[], options = {}) => {
  const model = createQwen({ apiKey: "fixture", fetch: async () => sse(events) })("qwen3.8-flash");
  const result: StreamEvent[] = [];
  for await (const event of await model.stream({ messages, ...options })) result.push(event);
  return result;
};

it.each(["qwen3.8-flash", "qwen3.8-max-0902", "qwen3.8-omni-flash", "qwen3.7-plus", "qwen3.5-plus", "deepseek-v4.1-flash", "kimi-k3"])("bounds hosted search in generate and stream for %s", async id => {
  const fetcher = vi.fn(async (_url: any, init: any) => JSON.parse(init.body).stream ? sse([terminal("incomplete", [])]) : Response.json(terminal("incomplete", []).response));
  const model = createQwen({ apiKey: "fixture", fetch: fetcher })(id);
  const input = { messages, maxTokens: 100, tools: { search: qwenWebSearchTool() } };
  const result = await model.generate(input);
  const events = []; for await (const e of await model.stream(input)) events.push(e);
  expect(result.finishReason).toBe("length");
  expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "length", usage: { outputTokens: 16 } });
  for (const [url, init] of fetcher.mock.calls) {
    expect(String(url)).toMatch(/\/responses$/);
    expect(JSON.parse(init.body)).toMatchObject({ max_output_tokens: 100, tools: [{ type: "web_search" }] });
  }
});
it.each([0, 15, 16.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid Responses limit %s before fetch", async maxTokens => {
  const fetcher = vi.fn(); const model = createQwen({ apiKey: "fixture", fetch: fetcher })("qwen3.8-flash");
  for (const method of ["generate", "stream"] as const) await expect(model[method]({ messages, maxTokens, tools: { search: qwenWebSearchTool() } })).rejects.toThrow("at least 16");
  expect(fetcher).not.toHaveBeenCalled();
});
it("accepts a provider limit without silently stripping it and rejects conflicts", async () => {
  const fetcher = vi.fn(async () => Response.json(terminal().response));
  const model = createQwen({ apiKey: "fixture", fetch: fetcher })("qwen3.8-flash");
  await model.generate({ messages, providerOptions: { max_output_tokens: 16 } });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).max_output_tokens).toBe(16);
  await expect(model.generate({ messages, maxTokens: 32, providerOptions: { apiMode: "responses", max_output_tokens: 16 } })).rejects.toThrow("must agree");
});
it("retains incompatible budgets and unknown-model limit rejection", async () => {
  for (const [id, options] of [["qwen3.8-flash", { reasoning: { budgetTokens: 100 } }], ["unknown", { maxTokens: 100 }]] as const) {
    const fetcher = vi.fn();
    await expect(createQwen({ apiKey: "fixture", fetch: fetcher })(id).generate({ messages, tools: { search: qwenWebSearchTool() }, ...options })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  }
});
it("deduplicates content, item and terminal citations, retaining indices and no message payload", async () => {
  const content = { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part };
  const done = { type: "response.output_item.done", output_index: 0, item };
  const events = await collect([content, content, done, terminal()]);
  const sources = events.filter(e => e.type === "provider-data");
  expect(sources).toEqual([{ type: "provider-data", provider: "qwen", data: { type: "response.annotations", itemId: "msg_1", outputIndex: 0, contentIndex: 0, annotations: [{ type: "url_citation", url: citation.url, title: "Source", start_index: 0, end_index: 5 }] } }]);
  expect(JSON.stringify(sources)).not.toMatch(/SECRET|Hello/);
});
it.each(["completed", "incomplete"])("preserves terminal-only annotations on %s", async status => {
  const events = await collect([terminal(status)]);
  expect(events[0]).toMatchObject({ type: "provider-data", data: { annotations: [{ url: citation.url }] } });
});
it.each(["completed", "incomplete"])("preserves terminal-only hosted search sources on %s", async status => {
  const events = await collect([terminal(status, [searchItem])]);
  expect(searchEvents(events)).toEqual([{ type: "provider-data", provider: "qwen", data: searchItem }]);
  expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: status === "completed" ? "stop" : "length" });
});
it.each([true, false])("deduplicates hosted search snapshots with provider IDs: %s", async withId => {
  const { id, ...withoutId } = searchItem;
  const search = withId ? searchItem : withoutId;
  const done = { type: "response.output_item.done", output_index: 0, item: search };
  const events = await collect([done, done, terminal("completed", [search]), terminal("completed", [search])]);
  expect(searchEvents(events)).toEqual([{ type: "provider-data", provider: "qwen", data: search }]);
});
it("emits final enriched search sources even when an earlier snapshot was emitted", async () => {
  const early = { ...searchItem, action: { type: "search", sources: [] } };
  const events = await collect([
    { type: "response.output_item.done", output_index: 0, item: early },
    terminal("completed", [searchItem])
  ]);
  expect(searchEvents(events).map(event => (event as any).data)).toEqual([early, searchItem]);
});
it("keeps distinct hosted search calls with identical sources", async () => {
  const second = { ...searchItem, id: "search_2" };
  const events = await collect([
    { type: "response.output_item.done", output_index: 0, item: searchItem },
    terminal("completed", [searchItem, second])
  ]);
  expect(searchEvents(events).map(event => (event as any).data)).toEqual([searchItem, second]);
});
it("stops terminal-only hosted sources on cancellation", async () => {
  const controller = new AbortController();
  const second = { ...searchItem, id: "search_2" };
  const model = createQwen({ apiKey: "fixture", fetch: async () => sse([terminal("completed", [searchItem, second])]) })("qwen3.8-flash");
  const iterator = (await model.stream({ messages, abortSignal: controller.signal }))[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: "provider-data", data: searchItem });
  controller.abort();
  await expect(iterator.next()).rejects.toThrow();
});
it("does not invent sources from empty, malformed or unsafe annotations", async () => {
  const events = await collect([terminal("completed", [{ ...item, content: [{ ...part, annotations: [null, {}, { ...citation, url: "javascript:alert(1)" }] }] }])]);
  expect(events).toHaveLength(1);
});
it("retains citations already received on truncation and rejects a success finish", async () => {
  const model = createQwen({ apiKey: "fixture", fetch: async () => sse([{ type: "response.output_item.done", output_index: 0, item }]) })("qwen3.8-flash");
  const events = []; let error;
  try { for await (const event of await model.stream({ messages })) events.push(event); } catch (e) { error = e; }
  expect(events[0]).toMatchObject({ type: "provider-data" });
  expect(error).toMatchObject({ reason: "stream_truncated" });
  expect(events.some(e => e.type === "finish")).toBe(false);
});
it("stops sources on cancellation and preserves explicit provider errors", async () => {
  const controller = new AbortController();
  const model = createQwen({ apiKey: "fixture", fetch: async () => sse([{ type: "response.output_item.done", output_index: 0, item }, terminal()]) })("qwen3.8-flash");
  const iterator = (await model.stream({ messages, abortSignal: controller.signal }))[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: "provider-data" });
  controller.abort(); await expect(iterator.next()).rejects.toThrow();
  await expect(collect([{ type: "error", error: { message: "private" } }])).rejects.toMatchObject({ diagnosticCode: "QWEN_RESPONSE_FAILED" });
});
it("preserves generated citations but does not replay them as provider input", async () => {
  const requests: any[] = [];
  const model = createQwen({ apiKey: "fixture", fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); return Response.json(terminal().response);
  } })("qwen3.8-flash");
  const result = await model.generate({ messages });
  expect(result.messages[0]?.parts).toContainEqual(expect.objectContaining({ type: "provider-data", data: expect.objectContaining({ type: "response.annotations" }) }));
  await model.generate({ messages: [...messages, ...result.messages, createTextMessage("user", "Continue")] });
  expect(requests[1].input.some((item: any) => item.type === "response.annotations")).toBe(false);
});
