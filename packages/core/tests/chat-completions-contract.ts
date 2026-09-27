import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../src/types.js";

const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""));
const choice = (delta: unknown, finish_reason?: string) => ({ choices: [{ index: 0, delta, finish_reason }] });
const toolDelta = (index: number, id: string | undefined, name: string | undefined, args: string) => ({ tool_calls: [{ index, id, function: { name, arguments: args } }] });
const collect = async (stream: AsyncIterable<StreamEvent>) => {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

/** Identical wire fixtures run through each adapter, not just its declared capabilities. */
export const runChatCompletionsStreamContract = (stream: (response: Response) => Promise<AsyncIterable<StreamEvent>>) => {
  describe("shared Chat Completions wire contract", () => {
    it.each(["tool_calls", "function_call", "stop"])("validates all calls before emitting and normalizes %s", async (finish) => {
      const events = await collect(await stream(sse(
        choice(toolDelta(1, "second", "lookup", '{"n":2}')),
        choice(toolDelta(0, "first", "lookup", '{"n":')),
        choice(toolDelta(0, undefined, undefined, "1}")),
        choice({}, finish),
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 3 } } },
        "[DONE]"
      )));
      expect(events).toEqual([
        { type: "tool-call", toolCall: { id: "first", name: "lookup", input: { n: 1 } } },
        { type: "tool-call", toolCall: { id: "second", name: "lookup", input: { n: 2 } } },
        { type: "finish", finishReason: "tool-calls", providerFinishReason: finish, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 } }
      ]);
    });

    it.each(["tool_calls", "stop"])("rejects malformed completed tools with %s", async (finish) => {
      const emitted: StreamEvent[] = [];
      await expect((async () => {
        for await (const event of await stream(sse(
          choice(toolDelta(0, "good", "lookup", "{}")),
          choice(toolDelta(1, "bad", "lookup", "{")),
          choice({}, finish), "[DONE]"
        ))) emitted.push(event);
      })()).rejects.toThrow("malformed tool arguments");
      expect(emitted).toEqual([]);
    });

    it.each(["length", "content_filter"])("never executes tools after %s", async (finish) => {
      const events = await collect(await stream(sse(choice(toolDelta(0, "partial", "lookup", "{")), choice({}, finish), "[DONE]")));
      expect(events.map((event) => event.type)).toEqual(["finish"]);
    });

    it("rejects truncated streams without a finish reason", async () => {
      await expect(collect(await stream(sse(choice(toolDelta(0, "call", "lookup", "{}")))))).rejects.toThrow("without a finish reason");
    });

    it("preserves a plain stop when no tools are present", async () => {
      const events = await collect(await stream(sse(choice({ content: "hello" }), choice({}, "stop"), "[DONE]")));
      expect(events).toEqual([{ type: "text-delta", textDelta: "hello" }, { type: "finish", finishReason: "stop", providerFinishReason: "stop", usage: undefined }]);
    });

    it("releases the body when the consumer stops early", async () => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(choice({ content: "hello" }))}\n\n`)); },
        cancel
      }));
      for await (const _event of await stream(response)) break;
      expect(cancel).toHaveBeenCalledOnce();
    });
  });
};
