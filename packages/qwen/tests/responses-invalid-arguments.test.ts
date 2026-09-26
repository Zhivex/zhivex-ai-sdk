import { expect, it, vi } from "vitest";
import { createTextMessage, ProviderToolCallError, generateText, streamText, tool, type StreamEvent } from "@zhivex-ai/core";
import { z } from "zod";
import { createQwen } from "../src/index.js";

const usage = { input_tokens: 12, output_tokens: 8, total_tokens: 20 };
const item = (argumentsValue: unknown = '{"value":1}', index = 0) => ({ type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "fixture", arguments: argumentsValue });
const terminal = { type: "response.completed", response: { status: "completed", usage } };
const done = (args: unknown = '{"value":1}', index = 0) => ({ type: "response.output_item.done", output_index: index, item: item(args, index) });
const input = { messages: [createTextMessage("user", "fixture")], providerOptions: { apiMode: "responses" as const } };
const modelFor = (body: unknown[] | string) => createQwen({ apiKey: "fixture", fetch: async () => new Response(
  typeof body === "string" ? body : body.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } }
)})("qwen3.8-flash");
const collect = async (body: unknown[] | string) => {
  const events: StreamEvent[] = []; let error: unknown;
  try { for await (const event of await modelFor(body).stream(input)) events.push(event); }
  catch (e) { error = e; }
  return { events, error };
};

it.each(['{"PRIVATE_SENTINEL":', '{invalid', 'null', '[]', '42', '"PRIVATE_SENTINEL"', '', undefined, {}])("rejects invalid arguments in generate and stream: %j", async args => {
  // Explicit undefined must remain missing rather than invoking the fixture default.
  const raw = { ...item(), arguments: args };
  const generateModel = createQwen({ apiKey: "fixture", fetch: async () => Response.json({ status: "completed", output: [raw], usage }) })("qwen3.8-flash");
  const error = await generateModel.generate(input).catch(e => e);
  expect(error).toBeInstanceOf(ProviderToolCallError);
  const streamed = await collect([{ type: "response.output_item.done", output_index: 0, item: raw }, terminal]);
  expect(streamed.error).toBeInstanceOf(ProviderToolCallError);
  expect(streamed.events.some(e => e.type === "tool-call")).toBe(false);
  for (const failure of [error, streamed.error]) {
    expect(failure).toMatchObject({ provider: "qwen", transport: "responses", diagnosticCode: "QWEN_RESPONSES_TOOL_CALL_INVALID", retryable: false, effectsPossible: false, usage: { inputTokens: 12, outputTokens: 8 } });
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure) + JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL");
  }
});

it.each(["responses", "chat"] as const)("classifies malformed SSE independently in %s", async apiMode => {
  for (const raw of ['{PRIVATE_SENTINEL', 'null', '[]']) {
    const model = modelFor(`data: ${raw}\n\n`);
    let failure: any;
    try { for await (const _ of await model.stream({ ...input, providerOptions: { apiMode, enable_thinking: false } })) {} }
    catch (e) { failure = e; }
    expect(failure).toMatchObject({ name: "QwenStreamEventError", diagnosticCode: "QWEN_SSE_EVENT_INVALID", transport: apiMode, retryable: false });
    expect(failure).not.toBeInstanceOf(SyntaxError);
    expect(failure.cause).toBeUndefined();
    expect(String(failure) + JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL");
  }
});

it("validates mixed batches before exposing any executable call", async () => {
  const result = await collect([done(), done('{"PRIVATE_SENTINEL":', 1), terminal]);
  expect(result.events).toEqual([]);
  expect(result.error).toMatchObject({ reason: "invalid_json", effectsPossible: false });
});

it("merges deltas and duplicate done events once and preserves IDs and terminal usage", async () => {
  const result = await collect([
    { type: "response.output_item.added", output_index: 0, item: item("") },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_0", delta: '{"value":' },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_0", delta: '1}' },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_0", arguments: '{"value":1}' },
    done(), done(), terminal
  ]);
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual([
    { type: "tool-call", toolCall: { id: "call_0", name: "fixture", input: { value: 1 } } },
    { type: "finish", finishReason: "tool-calls", providerFinishReason: "completed", usage: expect.objectContaining({ inputTokens: 12, outputTokens: 8, totalTokens: 20 }) }
  ]);
});

it.each([
  [done()],
  [{ type: "response.output_item.added", output_index: 0, item: item() }, terminal],
  [done(), { type: "response.incomplete", response: { status: "incomplete", usage } }],
  [done(), done('{"value":2}'), terminal],
  [done(), { type: "response.function_call_arguments.delta", output_index: 0, delta: ' ' }, terminal]
])("rejects truncated, incomplete or contradictory calls", async (...events) => {
  const result = await collect(events);
  expect(result.error).toBeInstanceOf(ProviderToolCallError);
  expect(result.events.some(e => e.type === "tool-call")).toBe(false);
});

it("does not retain invalid terminal accounting", async () => {
  const result = await collect([done('{invalid'), { ...terminal, response: { status: "completed", usage: { input_tokens: -1, output_tokens: "PRIVATE_SENTINEL" } } }]);
  expect(result.error).toMatchObject({ reason: "invalid_json" });
  expect((result.error as ProviderToolCallError).usage).toBeUndefined();
});

it("reports possible hosted effects without claiming rollback", async () => {
  const result = await collect([{ type: "response.output_item.done", item: { type: "web_search_call", status: "completed" } }, done('{invalid'), terminal]);
  expect(result.error).toMatchObject({ effectsPossible: true, retryable: false });
});

it.each(["generate", "stream"])("never executes or requests approval for a mixed invalid batch through %sText", async mode => {
  const execute = vi.fn(async () => ({}));
  const callable = tool({ name: "fixture", description: "fixture", schema: z.object({ value: z.number() }), requiresApproval: true, approvalMode: "interrupt", execute });
  const model = mode === "stream" ? modelFor([done(), done('{invalid', 1), terminal]) : createQwen({ apiKey: "fixture", fetch: async () => Response.json({ status: "completed", output: [item(), item('{invalid', 1)], usage }) })("qwen3.8-flash");
  const options = { model, prompt: "fixture", providerOptions: input.providerOptions, tools: { fixture: callable } };
  if (mode === "generate") await expect(generateText(options)).rejects.toBeInstanceOf(ProviderToolCallError);
  else {
    const result = streamText(options);
    const events = [];
    for await (const event of result.eventStream) events.push(event);
    expect(events.some(event => event.type === "tool-approval-request")).toBe(false);
    await expect(result.collect()).rejects.toBeInstanceOf(ProviderToolCallError);
  }
  expect(execute).not.toHaveBeenCalled();
});

it("preserves cancellation before buffered calls can escape", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Fixture cancellation", "AbortError");
  const body = [{ type: "response.output_text.delta", delta: "text" }, done(), terminal];
  const events = [];
  let failure: unknown;
  try {
    for await (const event of await modelFor(body).stream({ ...input, abortSignal: controller.signal })) {
      events.push(event);
      controller.abort(reason);
    }
  } catch (error) { failure = error; }
  expect(failure).toBe(reason);
  expect(events.some(event => event.type === "tool-call")).toBe(false);
});

it("rejects EOF without a terminal response and late malformed SSE without emitting calls", async () => {
  for (const suffix of ["", "data: {PRIVATE_SENTINEL\n\n"]) {
    const result = await collect(`data: ${JSON.stringify(done())}\n\n${suffix}`);
    expect(result.events).toEqual([]);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBeInstanceOf(SyntaxError);
  }
});

it("supports terminal-only function items", async () => {
  const result = await collect([{ ...terminal, response: { ...terminal.response, output: [item()] } }]);
  expect(result.error).toBeUndefined();
  expect(result.events[0]).toMatchObject({ type: "tool-call", toolCall: { id: "call_0", input: { value: 1 } } });
});
it("validates terminal snapshots before any buffered call escapes", async () => {
  for (const output of [[item('{invalid')], [item(), item('{invalid', 1)], []]) {
    const result = await collect([done(), { ...terminal, response: { ...terminal.response, output } }]);
    expect(result.error).toBeInstanceOf(ProviderToolCallError);
    expect(result.events).toEqual([]);
  }
});
