import { describe, expect, it } from "vitest";
import { ChatReplayError, InMemoryChatReplayStore } from "../src/replay.js";
import { createFetchChatTransport, parseChatEventStream } from "../src/transport.js";
import { chatReducer, createInitialChatState } from "../src/reducer.js";
import type { ChatStreamChunk } from "../src/types.js";

const collect = async (source: AsyncIterable<ChatStreamChunk>) => {
  const result: ChatStreamChunk[] = [];
  for await (const chunk of source) result.push(chunk);
  return result;
};

describe("chat replay", () => {
  it("continues after a reader disconnects, authorizes replay and never reruns the producer", async () => {
    const store = new InMemoryChatReplayStore();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const streamId = store.create({ ownerId: "alice", source: async function* () {
      runs++;
      await gate;
      yield { type: "text-delta", messageId: "a", role: "assistant", textDelta: "hello" };
    } });
    const reader = store.response({ streamId, ownerId: "alice" }).body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(() => store.response({ streamId, ownerId: "bob" })).toThrow(ChatReplayError);
    expect(() => store.cancel(streamId, "bob")).toThrow(ChatReplayError);
    expect(() => store.response({ streamId, ownerId: "alice", after: 100 })).toThrow(ChatReplayError);
    release();
    const chunks = await collect(parseChatEventStream(store.response({ streamId, ownerId: "alice", after: 1 }).body!));
    expect(chunks.map((chunk) => chunk.type)).toEqual(["text-delta", "stream-end"]);
    expect(chunks.map((chunk) => chunk.replay?.sequence)).toEqual([2, 3]);
    expect(runs).toBe(1);
    store.dispose();
  });

  it("bounds retention and rejects expired cursors", async () => {
    const store = new InMemoryChatReplayStore({ maxEvents: 2, retentionMs: 1, maxStreams: 1 });
    const id = store.create({ ownerId: "a", source: async function* () {
      yield { type: "text-delta", messageId: "a", role: "assistant", textDelta: "one" };
      yield { type: "text-delta", messageId: "a", role: "assistant", textDelta: "two" };
    } });
    const chunks = await collect(parseChatEventStream(store.response({ streamId: id, ownerId: "a" }).body!));
    expect(chunks.map((chunk) => chunk.type)).toEqual(["stream-start", "text-delta", "error", "stream-end"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(() => store.response({ streamId: id, ownerId: "a" })).toThrow("expired");
    store.dispose();
  });

  it("cancels a blocked producer and closes subscribers within the run deadline", async () => {
    const store = new InMemoryChatReplayStore({ maxRunMs: 10 });
    let signal!: AbortSignal;
    const id = store.create({ ownerId: "a", source: async function* (nextSignal) {
      signal = nextSignal;
      await new Promise<void>((resolve) => nextSignal.addEventListener("abort", () => resolve(), { once: true }));
    } });
    const chunks = await collect(parseChatEventStream(store.response({ streamId: id, ownerId: "a" }).body!));
    expect(signal.aborted).toBe(true);
    expect(chunks.at(-1)?.type).toBe("stream-end");
    store.dispose();
  });

  it("rejects truncated resumable responses and uses GET for recovery without building a message", async () => {
    const calls: RequestInit[] = [];
    let bodies = 0;
    const encoder = new TextEncoder();
    const transport = createFetchChatTransport({ reconnectEndpoint: "/replay", buildRequestBody: () => { bodies++; return {}; },
      fetch: async (_url, init) => {
        calls.push(init!);
        const chunk = calls.length === 1
          ? { type: "stream-start", replay: { streamId: "run", sequence: 1 } }
          : { type: "stream-end", replay: { streamId: "run", sequence: 2 } };
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)); controller.close();
        } }), { headers: { "content-type": "text/event-stream" } });
      } });
    const request = { messages: [], signal: new AbortController().signal };
    await expect(collect(transport.send(request))).rejects.toMatchObject({ code: "network_error" });
    await collect(transport.reconnect!({ ...request, checkpoint: { streamId: "run", sequence: 1 } }));
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    expect(calls[1]?.body).toBeUndefined();
    expect(bodies).toBe(1);
  });

  it("deduplicates text and usage, rejects gaps and preserves batch order", () => {
    const chunks: ChatStreamChunk[] = [
      { type: "text-delta", messageId: "a", role: "assistant", textDelta: "one", replay: { streamId: "run", sequence: 1 } },
      { type: "text-delta", messageId: "a", role: "assistant", textDelta: "two", replay: { streamId: "run", sequence: 2 } },
      { type: "finish", messageId: "a", usage: { outputTokens: 2 }, replay: { streamId: "run", sequence: 3 } }
    ];
    const state = chatReducer(createInitialChatState(), { type: "stream-chunks", chunks, now: 10 });
    expect(chatReducer(state, { type: "stream-chunks", chunks, now: 10 })).toBe(state);
    expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "onetwo" }]);
    expect(state.usage?.outputTokens).toBe(2);
    expect(() => chatReducer(state, { type: "stream-chunk", chunk: { ...chunks[0]!, replay: { streamId: "run", sequence: 5 } } })).toThrow("missing");
    expect(() => chatReducer(state, { type: "stream-chunk", chunk: { ...chunks[0]!, replay: { streamId: "other", sequence: 4 } } })).toThrow("changed");
    const sequential = chunks.reduce((current, chunk) => chatReducer(current, { type: "stream-chunk", chunk, now: 10 }), createInitialChatState());
    expect(state).toEqual(sequential);
  });
});
