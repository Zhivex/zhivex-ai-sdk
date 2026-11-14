import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMockLanguageModel } from "../src/agent-evaluation.js";
import { streamObject } from "../src/generate-object.js";
import { streamSSE } from "../src/stream.js";
import fixtures from "./fixtures/object-stream-legacy-partials.json";

const modelFor = (text: string) => createMockLanguageModel({ streamEvents: [[
  ...text.split("").map(textDelta => ({ type: "text-delta" as const, textDelta })),
  { type: "finish", finishReason: "stop" }
]] });

describe("object stream optimization compatibility", () => {
  // Expected partials were captured from the pre-optimization parser, including
  // incomplete strings, numeric prefixes and malformed final documents.
  it.each(fixtures)("preserves default partials for $text", async ({ text, partials }) => {
    const result = streamObject({ model: modelFor(text), prompt: "x", schema: z.unknown() });
    const received: unknown[] = [];
    const deltas: string[] = [];
    for await (const event of result.eventStream) {
      if (event.type === "object-partial") received.push(event.partialObject);
      if (event.type === "object-delta") deltas.push(event.textDelta);
    }
    expect(received).toEqual(partials);
    expect(deltas).toEqual(text.split(""));
    await result.collect().catch(() => undefined);
  });

  it.each([1, 8, 1000])("coalesces snapshots at %i characters without losing text or the final object", async snapshotIntervalChars => {
    const text = JSON.stringify({ a: 123, text: "hello" });
    const result = streamObject({ model: modelFor(text), prompt: "x", schema: z.object({ a: z.number(), text: z.string() }), snapshotIntervalChars });
    const snapshots: Array<{ textDelta: string; partialText: string }> = [];
    const partials: unknown[] = [];
    const partialConsumer = (async () => { for await (const value of result.partialObjectStream) partials.push(value); })();
    let original = "";
    const completed: unknown[] = [];
    for await (const event of result.eventStream) {
      if (event.type === "text-delta") original += event.textDelta;
      if (event.type === "object-delta") snapshots.push(event);
      if (event.type === "object-complete") completed.push(event.object);
    }
    await partialConsumer;
    expect(original).toBe(text);
    expect(snapshots.map(value => value.textDelta).join("")).toBe(text);
    expect(snapshots).toHaveLength(Math.ceil(text.length / snapshotIntervalChars));
    expect(snapshots.at(-1)?.partialText).toBe(text);
    expect(partials.at(-1)).toEqual(JSON.parse(text));
    expect(completed).toEqual([JSON.parse(text)]);
    expect((await result.collect()).object).toEqual(JSON.parse(text));
    let textOnly = "";
    for await (const delta of result.textStream) textOnly += delta;
    expect(textOnly).toBe(text);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid intervals before starting the provider: %s", snapshotIntervalChars => {
    const model = modelFor("{}");
    const spy = vi.spyOn(model, "stream");
    expect(() => streamObject({ model, prompt: "x", schema: z.object({}), snapshotIntervalChars })).toThrow(/snapshotIntervalChars/);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(['{"a":"wrong"}', '{"a":1} trailing'])("still rejects invalid final output with throttled snapshots: %s", async text => {
    const result = streamObject({ model: modelFor(text), prompt: "x", schema: z.object({ a: z.number() }), snapshotIntervalChars: 1000 });
    const types: string[] = [];
    for await (const event of result.eventStream) types.push(event.type);
    expect(types).not.toContain("object-complete");
    expect(types).toContain("error");
    await expect(result.collect()).rejects.toThrow();
  });
});

const responseFor = (text: string, size: number, cancel = vi.fn()) => {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + size, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }, cancel
  }));
};
const collect = async (source: AsyncIterable<unknown>) => {
  const values: unknown[] = [];
  for await (const value of source) values.push(value);
  return values;
};

describe("fragmented SSE parsing", () => {
  it.each([1, 2, 3, 4, 7, 64, 1024])("preserves delimiters, UTF-8, multiline data and EOF with %i-byte reads", async size => {
    const text = "event: value\r\ndata: á😀\r\ndata: two\r\n\r\n: comment\n\ndata: next\n\ndata: last";
    expect(await collect(streamSSE(responseFor(text, size)))).toEqual([
      { event: "value", data: "á😀\ntwo" }, { data: "next" }, { data: "last" }
    ]);
  });
  it.each([1, 64, 10000])("enforces event and buffer limits across fragments of %i bytes", async size => {
    const cancel = vi.fn();
    await expect(collect(streamSSE(responseFor(`data: ${"x".repeat(1024)}\n\n`, size, cancel), { maxEventChars: 100, maxBufferChars: 100 }))).rejects.toThrow(/exceeded/);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("checks event size independently of the larger unfinished buffer limit", async () => {
    await expect(collect(streamSSE(responseFor(`data: ${"x".repeat(500)}\n\n`, 1), { maxEventChars: 100, maxBufferChars: 1000 }))).rejects.toThrow(/event exceeded/);
  });
  it("reconstructs a large event and releases the reader after an early break", async () => {
    const cancel = vi.fn();
    const body = responseFor(`data: ${"x".repeat(65536)}\n\ndata: ${"y".repeat(65536)}\n\n`, 64, cancel);
    for await (const event of streamSSE(body)) { expect(event.data).toHaveLength(65536); break; }
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.body!.locked).toBe(false);
  });
});
