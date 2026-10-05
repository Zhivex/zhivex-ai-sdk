import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "@zhivex-ai/core";
import { createOpenRouter } from "../src/index.js";
const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "test" }] }], maxRetries: 2 };
const response = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
const collect = async (source: AsyncIterable<StreamEvent>) => { const events = []; for await (const event of source) events.push(event); return events; };
describe("OpenRouter fragmented tools and terminal accounting", () => {
  it("assembles interleaved tool fragments by index and retains the usage-only trailer", async () => {
    const fetcher = vi.fn().mockImplementation(async () => response([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "weather", arguments: '{"city":' } }, { index: 1, id: "call_b", function: { name: "time", arguments: "{" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "}" } }, { index: 0, function: { arguments: '"París"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } } }
    ]));
    const events = await collect(await createOpenRouter({ apiKey: "test", fetch: fetcher })("openai/gpt-4o-mini").stream!(input));
    expect(events.filter(event => event.type === "tool-call")).toEqual([
      { type: "tool-call", toolCall: { id: "call_a", name: "weather", input: { city: "París" } } },
      { type: "tool-call", toolCall: { id: "call_b", name: "time", input: {} } }
    ]);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 3 } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not emit buffered tool effects or retry when the stream reports a later error", async () => {
    const fetcher = vi.fn().mockImplementation(async () => response([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "weather", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      { error: { message: "failed" } }
    ]));
    const source = await createOpenRouter({ apiKey: "test", fetch: fetcher })("openai/gpt-4o-mini").stream!(input);
    const events: StreamEvent[] = [];
    await expect((async () => { for await (const event of source) events.push(event); })()).rejects.toThrow();
    expect(events.some(event => event.type === "tool-call")).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
