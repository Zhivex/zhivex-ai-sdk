import type { AgentLiveEvent, AudioFrame, MediaFrame } from "@zhivex-ai/core";
import type { RealtimeChatSession, RealtimeChatTransport } from "./realtime.js";
import { decodeRealtimeEvent, MAX_REALTIME_FRAME_CHARS, realtimeBase64 } from "./realtime-codec.js";

export interface WebSocketRealtimeTransportOptions {
  /** Application relay URL. Authenticate with same-site cookies or a short-lived relay ticket. */
  url: string | (() => string | Promise<string>);
  protocols?: string[];
  timeoutMs?: number;
  maxBufferedEvents?: number;
}

export function createWebSocketRealtimeTransport(options: WebSocketRealtimeTransportOptions): RealtimeChatTransport {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxEvents = options.maxBufferedEvents ?? 128;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxEvents) || maxEvents <= 0) throw new RangeError("Invalid realtime transport limits.");
  return { async connect({ signal }) {
    const url = new URL(typeof options.url === "function" ? await options.url() : options.url, globalThis.location?.href);
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Realtime relay requires WSS (or loopback WS).");
    if (url.username || url.password) throw new Error("Realtime relay URL must not contain credentials.");
    if (signal.aborted) throw signal.reason;
    const socket = new WebSocket(url, options.protocols);
    const queue: Array<{ event: AgentLiveEvent; chars: number }> = [];
    let queuedChars = 0;
    let wake: (() => void) | undefined;
    let closed = false;
    let failure: Error | undefined;
    let ready = false;
    let counter = 0;
    const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const opened = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const finish = (error?: Error) => {
      if (closed) return;
      closed = true; failure = error; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (!ready) rejectReady(error ?? new Error("Realtime relay closed before ready."));
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error ?? new Error("Realtime relay closed.")); }
      pending.clear(); wake?.(); socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close();
    };
    const abort = () => finish();
    const timer = setTimeout(() => finish(new Error("Realtime relay connection timed out.")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    socket.onclose = () => finish(ready ? undefined : new Error("Realtime relay connection closed."));
    socket.onerror = () => finish(new Error("Realtime relay connection failed."));
    socket.onmessage = message => {
      try {
        if (typeof message.data !== "string" || message.data.length > MAX_REALTIME_FRAME_CHARS) throw new Error("Invalid realtime relay frame.");
        const data = JSON.parse(message.data);
        if (data.type === "ready") { if (ready) throw new Error("Duplicate relay ready."); ready = true; clearTimeout(timer); resolveReady(); return; }
        if (data.type === "ack") {
          const entry = pending.get(data.id); if (!entry) return;
          pending.delete(data.id); clearTimeout(entry.timer);
          if (typeof data.error === "string") entry.reject(new Error(data.error)); else entry.resolve();
          return;
        }
        if (data.type !== "event" || !ready) throw new Error("Unexpected realtime relay frame.");
        const event = decodeRealtimeEvent(data.event);
        if (queue.length >= maxEvents || queuedChars + message.data.length > 2 * 1024 * 1024) throw new Error("Realtime event buffer exceeded.");
        queuedChars += message.data.length; queue.push({ event, chars: message.data.length }); wake?.();
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid realtime relay response.")); }
    };
    await opened;
    const command = (type: string, payload: unknown): Promise<void> => {
      if (closed || pending.size >= 32 || socket.bufferedAmount > MAX_REALTIME_FRAME_CHARS) return Promise.reject(new Error("Realtime relay is closed or backpressured."));
      const id = ++counter;
      const encoded = JSON.stringify({ type, id, payload });
      if (encoded.length > MAX_REALTIME_FRAME_CHARS) return Promise.reject(new Error("Realtime command is too large."));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Realtime command timed out.")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(encoded); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    };
    const frame = (value: AudioFrame | MediaFrame) => ({ ...value, data: typeof value.data === "string" ? value.data : realtimeBase64(value.data) });
    const session: RealtimeChatSession = {
      events: (async function* () {
        try {
          while (true) {
            const item = queue.shift();
            if (item) { queuedChars -= item.chars; yield item.event; continue; }
            if (closed) { if (failure) throw failure; return; }
            await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
          }
        } finally { finish(); }
      })(),
      sendText: text => command("text", text),
      sendAudio: value => command("audio", frame(value)),
      sendMedia: value => command("media", frame(value)),
      interrupt: () => command("interrupt", null),
      close: async () => { finish(); }
    };
    return session;
  } };
}
