import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSocketRealtimeTransport } from "../src/realtime-transport.js";
import { MAX_REALTIME_FRAME_CHARS } from "../src/realtime-codec.js";

class Socket {
  static latest: Socket;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  bufferedAmount = 0;
  sent: Array<{ type: string; id: number; payload: unknown }> = [];
  close = vi.fn();
  send = vi.fn((data: string) => { this.sent.push(JSON.parse(data)); });
  constructor(readonly url: URL, readonly protocols?: string[]) { Socket.latest = this; }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("WebSocket", Socket); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ready = async (options: { timeoutMs?: number; maxBufferedEvents?: number } = {}) => {
  const abort = new AbortController();
  const connection = createWebSocketRealtimeTransport({ url: "wss://chat.example/relay", ...options }).connect({ signal: abort.signal });
  const socket = Socket.latest;
  socket.receive({ type: "ready" });
  return { session: await connection, socket, abort };
};

describe("realtime WebSocket lifecycle and limits", () => {
  it("delivers ordered events and correlates acknowledgements for text, audio, media and interruption", async () => {
    const { session, socket } = await ready();
    const events = session.events[Symbol.asyncIterator]();
    const waiting = events.next();
    socket.receive({ type: "event", event: { type: "realtime-text-delta", textDelta: "hello" } });
    expect((await waiting).value).toEqual({ type: "realtime-text-delta", textDelta: "hello" });
    const operations = [session.sendText("hello"), session.sendAudio({ data: new Uint8Array([0, 1]), mediaType: "audio/pcm" }),
      session.sendMedia({ data: "AQI=", mediaType: "image/png" }), session.interrupt!()];
    expect(socket.sent.map(command => command.type)).toEqual(["text", "audio", "media", "interrupt"]);
    expect(socket.sent[1]!.payload).toEqual({ data: "AAE=", mediaType: "audio/pcm" });
    expect(socket.sent[2]!.payload).toEqual({ data: "AQI=", mediaType: "image/png" });
    socket.receive({ type: "ack", id: 999 });
    for (const command of [...socket.sent].reverse()) socket.receive({ type: "ack", id: command.id });
    await Promise.all(operations);
    await events.return?.();
    expect(socket.close).toHaveBeenCalledTimes(1);
    await expect(session.sendText("after close")).rejects.toThrow("closed or backpressured");
  });

  it("rejects pending commands on abort and settles a waiting consumer", async () => {
    const { session, socket, abort } = await ready();
    const next = session.events[Symbol.asyncIterator]().next();
    const pending = expect(session.sendText("pending")).rejects.toThrow("closed");
    abort.abort();
    await pending;
    expect(await next).toEqual({ value: undefined, done: true });
    expect(socket.onmessage).toBeNull();
    expect(socket.close).toHaveBeenCalledTimes(1);
    await session.close();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the event count budget is exhausted", async () => {
    const { session, socket } = await ready({ maxBufferedEvents: 1 });
    socket.receive({ type: "event", event: { type: "realtime-text-delta", textDelta: "first" } });
    socket.receive({ type: "event", event: { type: "realtime-text-delta", textDelta: "overflow" } });
    const events = session.events[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ textDelta: "first" });
    await expect(events.next()).rejects.toThrow("buffer exceeded");
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("bounds aggregate event bytes even below the event count limit", async () => {
    const { session, socket } = await ready();
    for (let index = 0; index < 5; index++) socket.receive({ type: "event", event: { type: "realtime-text-delta", textDelta: "x".repeat(450_000) } });
    let accepted = 0;
    await expect((async () => { for await (const _event of session.events) accepted++; })()).rejects.toThrow("buffer exceeded");
    expect(accepted).toBe(4);
  });

  it.each(["duplicate-ready", "binary", "oversized", "invalid-event"])("rejects malformed protocol input: %s", async kind => {
    const { session, socket } = await ready();
    if (kind === "duplicate-ready") socket.receive({ type: "ready" });
    else if (kind === "binary") socket.onmessage?.({ data: new Uint8Array([1]) });
    else if (kind === "oversized") socket.onmessage?.({ data: "x".repeat(MAX_REALTIME_FRAME_CHARS + 1) });
    else socket.receive({ type: "event", event: { type: "realtime-text-delta", textDelta: 12 } });
    await expect(session.events[Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("limits commands, handles rejection, and releases slots after acknowledgement or timeout", async () => {
    const { session, socket } = await ready({ timeoutMs: 20 });
    socket.bufferedAmount = MAX_REALTIME_FRAME_CHARS + 1;
    await expect(session.sendText("blocked")).rejects.toThrow("backpressured");
    socket.bufferedAmount = 0;
    await expect(session.sendText("x".repeat(MAX_REALTIME_FRAME_CHARS))).rejects.toThrow("too large");
    const rejected = expect(session.sendText("rejected")).rejects.toThrow("denied");
    socket.receive({ type: "ack", id: socket.sent.at(-1)!.id, error: "denied" });
    await rejected;
    const expired = expect(session.sendText("no ack")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20);
    await expired;
    socket.send.mockImplementationOnce(() => { throw new Error("socket write failed"); });
    await expect(session.sendText("write error")).rejects.toThrow("socket write failed");
    const pending = Array.from({ length: 32 }, () => session.sendText("pending"));
    await expect(session.sendText("overflow")).rejects.toThrow("backpressured");
    const settled = Promise.allSettled(pending);
    await session.close();
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
  });

  it.each(["timeout", "error", "close", "unexpected"])("fails connection setup on %s", async failure => {
    const pending = createWebSocketRealtimeTransport({ url: "wss://chat.example", timeoutMs: 10 }).connect({ signal: new AbortController().signal });
    const rejected = expect(pending).rejects.toThrow();
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(10);
    else if (failure === "error") Socket.latest.onerror?.();
    else if (failure === "close") Socket.latest.onclose?.();
    else Socket.latest.receive({ type: "event", event: { type: "realtime-start" } });
    await rejected;
    expect(Socket.latest.close).toHaveBeenCalledTimes(1);
  });

  it("accepts a host ticket callback and closes the consumer when the socket closes normally", async () => {
    const connect = createWebSocketRealtimeTransport({ url: async () => "ws://127.0.0.1/relay?ticket=short-lived", protocols: ["chat"] }).connect({ signal: new AbortController().signal });
    await Promise.resolve();
    const socket = Socket.latest;
    socket.receive({ type: "ready" });
    const session = await connect;
    expect(socket.protocols).toEqual(["chat"]);
    const next = session.events[Symbol.asyncIterator]().next();
    socket.onclose?.();
    expect((await next).done).toBe(true);
  });

  it("rejects insecure endpoints and pre-aborted setup before opening a socket", async () => {
    for (const url of ["ws://remote.example", "wss://user:password@remote.example"]) {
      await expect(createWebSocketRealtimeTransport({ url }).connect({ signal: new AbortController().signal })).rejects.toThrow();
    }
    const aborted = new AbortController(); aborted.abort(new Error("stopped"));
    await expect(createWebSocketRealtimeTransport({ url: "wss://chat.example" }).connect({ signal: aborted.signal })).rejects.toThrow("stopped");
    expect(() => createWebSocketRealtimeTransport({ url: "wss://chat.example", maxBufferedEvents: 0 })).toThrow("Invalid realtime transport limits");
  });
});
