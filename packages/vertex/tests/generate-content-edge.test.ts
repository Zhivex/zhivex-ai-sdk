import { describe, expect, it, vi } from "vitest";
import { ProviderToolCallError, type ModelMessage, type StreamEvent } from "@zhivex-ai/core";
import { createVertex } from "../src/index.js";

const messages: ModelMessage[] = [{ role: "user", parts: [{ type: "text", text: "test" }] }];
const call = (args: unknown = {}, id?: string) => ({ functionCall: { name: "echo", args, ...(id ? { id } : {}) } });
const frame = (parts: unknown[], finishReason?: string) => ({ candidates: [{ index: 0, content: { parts }, ...(finishReason ? { finishReason } : {}) }] });
const model = (response: () => Response) => createVertex({ apiKey: "test", fetch: vi.fn(async () => response()) as typeof fetch })("gemini-2.5-flash-lite");
const streaming = (frames: unknown[]) => model(() => new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join("")));
const collect = async (events: AsyncIterable<StreamEvent>) => {
  const result: StreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
};

describe("Vertex GenerateContent buffering edge cases", () => {
  it.each(["text", "inlineData", "functionResponse"])("rejects mixed functionCall and %s parts before nonstream materialization", async (field) => {
    const mixed = { ...call({ privateValue: "do-not-expose" }), [field]: field === "text" ? "mixed" : {} };
    const instance = model(() => Response.json(frame([mixed, call({ second: true }, "second")], "STOP")));
    const result = instance.generate({ messages });
    await expect(result).rejects.toBeInstanceOf(ProviderToolCallError);
    await result.catch(error => expect(JSON.stringify(error)).not.toContain("do-not-expose"));
  });

  it("rejects a mixed text/functionCall stream part before exposing its text", async () => {
    const events: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of await streaming([frame([{ ...call(), text: "invalid mixed part" }], "STOP")]).stream!({ messages })) events.push(event);
    })()).rejects.toBeInstanceOf(ProviderToolCallError);
    expect(events).toEqual([]);
  });

  it("accepts 128 calls and rejects a 129th before emitting any", async () => {
    const allowed = Array.from({ length: 128 }, () => call());
    const events = await collect(await streaming([frame(allowed, "STOP")]).stream!({ messages }));
    expect(events.filter(event => event.type === "tool-call")).toHaveLength(128);
    const emitted: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of await streaming([frame(allowed), frame([call()], "STOP")]).stream!({ messages })) emitted.push(event);
    })()).rejects.toMatchObject({ reason: "arguments_too_large" });
    expect(emitted).toEqual([]);
  });

  it("bounds cumulative pending payload size across individually valid SSE events", async () => {
    const largeCall = call({ text: "x".repeat(600_000) });
    const events: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of await streaming([frame([largeCall]), frame([largeCall], "STOP")]).stream!({ messages })) events.push(event);
    })()).rejects.toMatchObject({ reason: "arguments_too_large" });
    expect(events).toEqual([]);
  });

  it.each([[call()], [{ text: "invalid trailing text" }]])("rejects content appended after a terminal state without exposing buffered tools", async (...parts) => {
    const events: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of await streaming([frame([call()], "STOP"), frame(parts)]).stream!({ messages })) events.push(event);
    })()).rejects.toMatchObject({ reason: "response_failed" });
    expect(events).toEqual([]);
  });

  it("reserves native IDs from later chunks before assigning deterministic fallbacks", async () => {
    const events = await collect(await streaming([
      frame([call()]), frame([call({}, "vertex-call-0")]), frame([], "STOP")
    ]).stream!({ messages }));
    expect(events.filter(event => event.type === "tool-call").map(event => event.toolCall.id)).toEqual(["vertex-call-1", "vertex-call-0"]);
  });
});
