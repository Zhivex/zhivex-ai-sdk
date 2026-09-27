import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderToolCallError, streamText, tool, type ModelMessage, type StreamEvent } from "@zhivex-ai/core";
import { createVertex } from "../src/index.js";

const messages: ModelMessage[] = [{ role: "user", parts: [{ type: "text", text: "test" }] }];
const frame = (parts: unknown[], finishReason?: string) => ({ candidates: [{ index: 0, content: { parts }, ...(finishReason ? { finishReason } : {}) }] });
const call = (value = "test", id?: string) => ({ functionCall: { name: "echo", args: { value }, ...(id ? { id } : {}) }, thoughtSignature: "signature" });
const sse = (frames: unknown[]) => new Response(frames.map(item => `data: ${JSON.stringify(item)}\n\n`).join(""));
const model = (frames: unknown[]) => createVertex({ apiKey: "test", fetch: vi.fn(async () => sse(frames)) as typeof fetch })("gemini-2.5-flash-lite");
const collect = async (events: AsyncIterable<StreamEvent>) => { const result: StreamEvent[] = []; for await (const event of events) result.push(event); return result; };

describe("Vertex GenerateContent terminal tool validation", () => {
  it.each(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MAX_TOKENS", "SAFETY", "OTHER", undefined])(
    "does not execute a buffered tool after terminal %s", async (reason) => {
      const execute = vi.fn(async () => ({ ok: true }));
      const frames = [frame([call()]), ...(reason ? [frame([], reason)] : [])];
      const events: StreamEvent[] = [];
      await expect((async () => {
        for await (const event of await model(frames).stream!({ messages })) events.push(event);
      })()).rejects.toBeInstanceOf(ProviderToolCallError);
      expect(events.some(event => event.type === "tool-call")).toBe(false);
      await expect(streamText({ model: model(frames), prompt: "test", maxSteps: 1,
        tools: { echo: tool({ name: "echo", schema: z.object({ value: z.string() }), execute }) }
      }).collect()).rejects.toBeInstanceOf(ProviderToolCallError);
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("retains parallel calls, signatures and trailing usage with one finish", async () => {
    const events = await collect(await model([
      frame([call("one")]), frame([call("two", "native-id")]), frame([], "STOP"),
      { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } }
    ]).stream!({ messages }));
    const calls = events.filter(event => event.type === "tool-call");
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map(event => event.toolCall.id)).size).toBe(2);
    expect(calls[1]?.toolCall.id).toBe("native-id");
    expect(calls.map(event => event.toolCall.providerMetadata)).toEqual([
      { geminiThoughtSignature: "signature" }, { geminiThoughtSignature: "signature" }
    ]);
    expect(events.filter(event => event.type === "finish")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "finish", providerFinishReason: "STOP", usage: { totalTokens: 7 } });
  });

  it("does not reuse fallback IDs retained after history compaction", async () => {
    const first = await collect(await model([frame([call()], "STOP")]).stream!({ messages }));
    const firstCall = first.find(event => event.type === "tool-call")!;
    const history: ModelMessage[] = [{ role: "assistant", parts: [{ type: "tool-call", toolCall: firstCall.toolCall }] }];
    const second = await collect(await model([frame([call()], "STOP")]).stream!({ messages: history }));
    expect(second.find(event => event.type === "tool-call")!.toolCall.id).not.toBe(firstCall.toolCall.id);
  });

  it("rejects duplicate native IDs before emitting any tools", async () => {
    const events: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of await model([frame([call("one", "duplicate")]), frame([call("two", "duplicate")], "STOP")]).stream!({ messages })) events.push(event);
    })()).rejects.toBeInstanceOf(ProviderToolCallError);
    expect(events).toEqual([]);
  });

  it.each([{ name: "", args: {} }, { name: "echo", args: "not-an-object" }, { name: "echo", args: [] }])(
    "rejects malformed tool payloads atomically", async (functionCall) => {
      const events: StreamEvent[] = [];
      await expect((async () => {
        for await (const event of await model([frame([call(), { functionCall }], "STOP")]).stream!({ messages })) events.push(event);
      })()).rejects.toBeInstanceOf(ProviderToolCallError);
      expect(events).toEqual([]);
    }
  );

  it("rejects native IDs already present in tool results", async () => {
    const history: ModelMessage[] = [{ role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "used", toolName: "echo", output: {}, isError: false } }] }];
    await expect(collect(await model([frame([call("test", "used")], "STOP")]).stream!({ messages: history }))).rejects.toBeInstanceOf(ProviderToolCallError);
  });

  it("retains accounting on a sanitized terminal failure", async () => {
    const pending = collect(await model([frame([call("private-argument")]), frame([], "MALFORMED_FUNCTION_CALL"),
      { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } }
    ]).stream!({ messages }));
    await expect(pending).rejects.toMatchObject({ provider: "vertex", effectsPossible: false, usage: { totalTokens: 7 } });
    await pending.catch(error => expect(JSON.stringify(error)).not.toContain("private-argument"));
  });

  it("rejects disconnected text streams without a terminal state", async () => {
    await expect(collect(await model([frame([{ text: "partial" }])]).stream!({ messages }))).rejects.toBeInstanceOf(ProviderToolCallError);
  });

  it("preserves text-only token limits and maps safety blocks", async () => {
    expect((await collect(await model([frame([{ text: "partial" }], "MAX_TOKENS")]).stream!({ messages }))).at(-1)).toMatchObject({ type: "finish", finishReason: "length" });
    expect((await collect(await model([frame([], "SAFETY")]).stream!({ messages }))).at(-1)).toMatchObject({ type: "finish", finishReason: "content-filter" });
  });

  it("cancels the body when a text consumer exits early", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame([{ text: "hello" }]))}\n\n`)); }, cancel }));
    const instance = createVertex({ apiKey: "test", fetch: vi.fn(async () => response) as typeof fetch })("gemini-2.5-flash-lite");
    for await (const _ of await instance.stream!({ messages })) break;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
