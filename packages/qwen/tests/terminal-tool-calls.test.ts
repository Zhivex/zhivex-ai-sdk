import { expect, it } from "vitest";
import { createTextMessage, type StreamEvent } from "@zhivex-ai/core";
import { createQwen } from "../src/index.js";

const call = (index = 0, args = '{"value":1}') => ({ index, id: `call-${index}`, type: "function", function: { name: "fixture", arguments: args } });
const collect = async (finish: string | null, calls = [call()], after: unknown[] = []) => {
  const chunks = [{ choices: [{ delta: { tool_calls: calls }, finish_reason: null }] },
    ...(finish ? [{ choices: [{ delta: {}, finish_reason: finish }] }] : []),
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }, ...after];
  const provider = createQwen({ apiKey: "fixture", fetch: async () => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) });
  const events: StreamEvent[] = []; let error: unknown;
  try { for await (const event of await provider("qwen3.8-flash").stream({ messages: [createTextMessage("user", "fixture")], providerOptions: { apiMode: "chat", enable_thinking: false } })) events.push(event); }
  catch (e) { error = e; }
  return { events, error };
};
it.each(["stop", "tool_calls"])("materializes complete calls on %s with terminal usage", async finish => {
  const { events, error } = await collect(finish);
  expect(error).toBeUndefined();
  expect(events.filter(e => e.type === "tool-call")).toEqual([{ type: "tool-call", toolCall: { id: "call-0", name: "fixture", input: { value: 1 } } }]);
  expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls", providerFinishReason: finish, usage: { inputTokens: 12, outputTokens: 8 } });
});
it.each(["length", "content_filter", null])("never emits calls on unsuccessful terminal %s", async finish => {
  const { events, error } = await collect(finish);
  expect(events.some(e => e.type === "tool-call")).toBe(false);
  expect(error).toMatchObject({ provider: "qwen", usage: { inputTokens: 12, outputTokens: 8 } });
});
it.each(['{"value":', 'null', '[]'])("validates the entire call batch before emission: %s", async args => {
  const { events, error } = await collect("stop", [call(), call(1, args)]);
  expect(events.some(e => e.type === "tool-call")).toBe(false);
  expect(error).toMatchObject({ provider: "qwen", reason: "invalid_json", usage: { inputTokens: 12, outputTokens: 8 } });
});
it("does not emit a previously finished call when late fragments invalidate its JSON", async () => {
  const { events, error } = await collect("tool_calls", [call()], [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'bad' } }] } }] }]);
  expect(events.some(e => e.type === "tool-call")).toBe(false);
  expect(error).toBeDefined();
});
it("does not emit calls when a provider error arrives after terminal tool fragments", async () => {
  const { events, error } = await collect("stop", [call()], [{ error: { code: "fixture_error", message: "PRIVATE_PROVIDER_DETAIL" } }]);
  expect(events.some(e => e.type === "tool-call")).toBe(false);
  expect(error).toMatchObject({ provider: "qwen", reason: "response_failed", usage: { inputTokens: 12, outputTokens: 8 } });
  expect(String(error)).not.toContain("PRIVATE_PROVIDER_DETAIL");
});
