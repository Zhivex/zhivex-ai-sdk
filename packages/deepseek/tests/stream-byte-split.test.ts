import { describe, expect, it, vi } from "vitest";

import { createAgent, createInMemoryAgentRunStore, streamAgent, streamText } from "@zhivex-ai/core";
import { createDeepSeek } from "../src/index.js";

const wordPrefix = "zx-stream-";
const wordSuffix = "cert-7f3k-ok";
const cjk = "深度搜索";
const emoji = "😀";
const expectedText = `${wordPrefix}${wordSuffix}${cjk}${emoji}`;

const encoder = new TextEncoder();

const sseData = (payload: unknown): string => `data: ${JSON.stringify(payload)}\r\n\r\n`;

const comment = (text: string): string => `: ${text}\r\n\r\n`;

const contentEvent = (content: string): string =>
  sseData({ choices: [{ index: 0, delta: { content } }] });

/**
 * Synthetic DeepSeek SSE: word-boundary split, one character per delta,
 * reasoning interleaved with content, CJK and emoji, CRLF frames,
 * keep-alive comments, empty and null deltas, a usage-only chunk, and [DONE].
 * An index 1 choice carries text that must not leak into the transcript.
 */
const buildSse = (): string => {
  const events = [
    comment("keep-alive"),
    sseData({ choices: [{ index: 0, delta: { reasoning_content: "plan the token" } }] }),
    sseData({
      choices: [
        { index: 1, delta: { content: "SHOULD-NOT-APPEAR" } },
        { index: 0, delta: { content: wordPrefix } }
      ]
    }),
    sseData({ choices: [{ index: 0, delta: { content: "" } }] }),
    sseData({ choices: [{ index: 0, delta: { content: null } }] }),
    sseData({ choices: [{ index: 0, delta: null }] }),
    comment("ping")
  ];

  const suffix = [...wordSuffix];
  const midpoint = Math.floor(suffix.length / 2);
  for (let index = 0; index < suffix.length; index += 1) {
    if (index === midpoint) {
      events.push(sseData({ choices: [{ index: 0, delta: { reasoning_content: "midpoint" } }] }));
    }
    events.push(contentEvent(suffix[index]!));
  }

  const cjkCharacters = [...cjk];
  events.push(sseData({
    choices: [{
      index: 0,
      delta: { reasoning_content: "cjk", content: cjkCharacters[0] }
    }]
  }));
  for (const character of cjkCharacters.slice(1)) events.push(contentEvent(character));
  events.push(contentEvent(emoji));
  events.push(sseData({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  events.push(sseData({
    choices: [],
    usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 }
  }));
  events.push("data: [DONE]\r\n\r\n");
  return events.join("");
};

const utf8SequenceLength = (lead: number): number => {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
};

const multibyteRanges = (bytes: Uint8Array): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = utf8SequenceLength(bytes[offset]!);
    const wellFormed = length > 1
      && offset + length <= bytes.length
      && bytes.slice(offset + 1, offset + length).every((byte) => (byte & 0xc0) === 0x80);
    if (wellFormed) {
      ranges.push([offset, offset + length]);
      offset += length;
    } else {
      offset += 1;
    }
  }
  return ranges;
};

const splitEveryByte = (bytes: Uint8Array): Uint8Array[] =>
  [...bytes].map((byte) => Uint8Array.of(byte));

const splitInsideEveryMultibyte = (bytes: Uint8Array): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = utf8SequenceLength(bytes[offset]!);
    const wellFormed = length > 1
      && offset + length <= bytes.length
      && bytes.slice(offset + 1, offset + length).every((byte) => (byte & 0xc0) === 0x80);
    if (!wellFormed) {
      let end = offset + 1;
      while (end < bytes.length) {
        const nextLength = utf8SequenceLength(bytes[end]!);
        const nextWellFormed = nextLength > 1
          && end + nextLength <= bytes.length
          && bytes.slice(end + 1, end + nextLength).every((byte) => (byte & 0xc0) === 0x80);
        if (nextWellFormed) break;
        end += 1;
      }
      chunks.push(bytes.slice(offset, end));
      offset = end;
      continue;
    }
    for (let index = 0; index < length; index += 1) {
      chunks.push(bytes.slice(offset + index, offset + index + 1));
    }
    offset += length;
  }
  return chunks;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const splitSeeded = (bytes: Uint8Array, seed: number): Uint8Array[] => {
  const random = mulberry32(seed);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const size = 1 + Math.floor(random() * Math.min(24, remaining));
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
};

const cutsInside = (chunks: Uint8Array[], range: [number, number]): boolean => {
  let offset = 0;
  for (const chunk of chunks) {
    const end = offset + chunk.length;
    if (offset > range[0] && offset < range[1]) return true;
    offset = end;
  }
  return false;
};

const chunkedResponse = (chunks: Uint8Array[]): Response =>
  new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk.slice());
      controller.close();
    }
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });

const collectModelText = async (
  model: ReturnType<ReturnType<typeof createDeepSeek>>,
): Promise<string> => {
  let text = "";
  for await (const event of await model.stream({
    messages: [{ role: "user", parts: [{ type: "text", text: "certify" }] }]
  })) {
    if (event.type === "text-delta") text += event.textDelta;
  }
  return text;
};

const assertStreamPaths = async (chunks: Uint8Array[]): Promise<void> => {
  const fetchMock = vi.fn(async () => chunkedResponse(chunks));
  const model = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch })("deepseek-v4-flash");

  await expect(collectModelText(model)).resolves.toBe(expectedText);

  const streamed = streamText({
    model,
    prompt: "Reply exactly.",
    reasoning: { effort: "none" }
  });
  const textChunks: string[] = [];
  for await (const chunk of streamed.textStream) textChunks.push(chunk);
  const final = await streamed.collect();
  expect(textChunks.join("")).toBe(final.text);
  expect(final.text).toBe(expectedText);

  const store = createInMemoryAgentRunStore();
  const scope = { tenantId: "byte-split", userId: "offline", namespace: "stream" };
  const run = streamAgent(createAgent({
    id: "deepseek-byte-split",
    model,
    store,
    maxSteps: 1,
    reasoning: { effort: "none" }
  }), {
    prompt: "Reply exactly.",
    scope
  });
  const agentChunks: string[] = [];
  for await (const chunk of run.textStream) agentChunks.push(chunk);
  const output = await run.collect();
  const streamedText = agentChunks.join("");
  const persisted = await store.load(output.state.runId, scope);

  expect(output.status).toBe("completed");
  expect(streamedText).toBe(expectedText);
  expect(output.outputText).toBe(streamedText);
  expect(persisted?.outputText).toBe(streamedText);
};

describe("deepseek stream byte splits", () => {
  const payload = buildSse();
  const bytes = encoder.encode(payload);
  const ranges = multibyteRanges(bytes);

  it("builds a framed payload with multi-byte text", () => {
    expect(payload).toContain("\r\n\r\n");
    expect(payload).toContain(": keep-alive\r\n");
    expect(payload).toContain("data: [DONE]\r\n");
    expect(ranges.some(([start, end]) => end - start === 3)).toBe(true);
    expect(ranges.some(([start, end]) => end - start === 4)).toBe(true);
  });

  it("preserves text when every SSE byte is its own chunk", async () => {
    const chunks = splitEveryByte(bytes);
    expect(chunks).toHaveLength(bytes.length);
    expect(ranges.every((range) => cutsInside(chunks, range))).toBe(true);
    await assertStreamPaths(chunks);
  });

  it("preserves text when every multi-byte character is cut", async () => {
    const chunks = splitInsideEveryMultibyte(bytes);
    expect(ranges.every((range) => cutsInside(chunks, range))).toBe(true);
    await assertStreamPaths(chunks);
  });

  for (const seed of [7, 42, 99, 2026]) {
    it(`preserves text for seeded split ${seed}`, async () => {
      await assertStreamPaths(splitSeeded(bytes, seed));
    });
  }
});
