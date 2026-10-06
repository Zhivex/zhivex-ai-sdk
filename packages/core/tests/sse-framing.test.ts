import { expect, it, vi } from "vitest";
import { streamSSE } from "../src/stream.js";

const response = (chunks: string[], cancel = vi.fn()) => new Response(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
  cancel
}));
const collect = async (chunks: string[]) => Array.fromAsync(streamSSE(response(chunks)));

it.each(["\n", "\r\n", "\r"])("parses SSE lines terminated with %j", async eol => {
  const body = `: heartbeat${eol}${eol}event: message${eol}data: {"ok":true}${eol}${eol}data: [DONE]${eol}${eol}`;
  expect(await collect([body])).toEqual([{ event: "message", data: '{"ok":true}' }, { event: undefined, data: "[DONE]" }]);
});

it("parses mixed line endings and CRLF split across chunks", async () => {
  expect(await collect(["data: first\r", "\n\r", "\ndata: second\r\rdata: third\n\n"]))
    .toEqual(["first", "second", "third"].map(data => ({ event: undefined, data })));
});

it("removes only one optional space, preserves payload whitespace and joins data lines", async () => {
  expect(await collect(["event:  spaced \ndata:  leading \ndata:\ttab\ndata\n\n"]))
    .toEqual([{ event: " spaced ", data: " leading \n\ttab\n" }]);
});

it("dispatches empty data fields, ignores comments and unknown fields", async () => {
  expect(await collect([": heartbeat\n\nid: 1\nretry: 100\nunknown: ignored\n\ndata\n\ndata:\n\n"]))
    .toEqual([{ event: undefined, data: "" }, { event: undefined, data: "" }]);
});

it.each(["data: partial", "data: partial\n", "data: partial\r\n", "data: partial\r"])
  ("does not dispatch an unfinished event at EOF: %j", async tail => {
    expect(await collect(["data: complete\n\n", tail])).toEqual([{ event: undefined, data: "complete" }]);
  });

it("decodes a leading BOM and UTF-8 codepoints split at each byte", async () => {
  const bytes = new TextEncoder().encode('\uFEFFdata: café 🦊\r\n\r\n');
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  expect(await Array.fromAsync(streamSSE(new Response(body)))).toEqual([{ event: undefined, data: "café 🦊" }]);
});

it("cancels an unfinished transport when the consumer stops after an event", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); }, cancel });
  const events = streamSSE(new Response(body));
  await events.next();
  await events.return();
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

it("cancels oversized CR-delimited events without disclosing their contents", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${"private".repeat(10)}\r\r`)); }, cancel });
  await expect(streamSSE(new Response(body), { maxEventChars: 16 }).next()).rejects.toMatchObject({ name: "ParseError" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
