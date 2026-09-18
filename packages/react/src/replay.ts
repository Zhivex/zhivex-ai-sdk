import { randomUUID } from "node:crypto";
import type { ChatStreamChunk } from "./types.js";

export interface ChatReplayCursor {
  streamId: string;
  sequence: number;
}

export class ChatReplayError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 503) {
    super(message);
    this.name = "ChatReplayError";
  }
}

interface ReplayEntry {
  ownerId: string;
  events: string[];
  chars: number;
  done: boolean;
  expiresAt: number;
  controller: AbortController;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ChatReplayStoreOptions {
  maxStreams?: number;
  maxEvents?: number;
  maxChars?: number;
  retentionMs?: number;
  maxRunMs?: number;
}

/** Bounded, single-process replay. Authenticate ownerId on every route invocation. */
export class InMemoryChatReplayStore {
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly limits: Required<ChatReplayStoreOptions>;

  constructor(options: ChatReplayStoreOptions = {}) {
    this.limits = { maxStreams: 32, maxEvents: 10_000, maxChars: 8 * 1024 * 1024,
      retentionMs: 300_000, maxRunMs: 120_000, ...options };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} must be a positive integer.`);
    }
  }

  create(options: { ownerId: string; source: (signal: AbortSignal) => AsyncIterable<ChatStreamChunk> }): string {
    if (!options.ownerId) throw new TypeError("A server-authenticated ownerId is required.");
    this.sweep();
    if (this.entries.size >= this.limits.maxStreams) {
      throw new ChatReplayError("Chat replay capacity reached.", 503);
    }
    const streamId = randomUUID();
    const entry: ReplayEntry = { ownerId: options.ownerId, events: [], chars: 0, done: false,
      expiresAt: Infinity, controller: new AbortController(), listeners: new Set() };
    this.entries.set(streamId, entry);
    const append = (chunk: ChatStreamChunk) => {
      const sequence = entry.events.length + 1;
      const data = JSON.stringify({ ...chunk, replay: { streamId, sequence } });
      const encoded = `id: ${sequence}\ndata: ${data}\n\n`;
      if (entry.events.length >= this.limits.maxEvents || entry.chars + encoded.length > this.limits.maxChars) {
        throw new Error("Replay capacity exceeded.");
      }
      entry.events.push(encoded);
      entry.chars += encoded.length;
      for (const notify of entry.listeners) notify();
    };
    const finish = (failed: boolean) => {
      if (entry.done) return;
      // Reserve a bounded terminal diagnostic even when the payload budget is exhausted.
      for (const chunk of failed
        ? [{ type: "error", error: { message: "Chat stream interrupted on the server." } }, { type: "stream-end" }]
        : [{ type: "stream-end" }]) {
        const sequence = entry.events.length + 1;
        entry.events.push(`id: ${sequence}\ndata: ${JSON.stringify({ ...chunk, replay: { streamId, sequence } })}\n\n`);
      }
      entry.done = true;
      entry.expiresAt = Date.now() + this.limits.retentionMs;
      clearTimeout(entry.timer);
      for (const notify of entry.listeners) notify();
    };
    entry.timer = setTimeout(() => { entry.controller.abort(); finish(true); }, this.limits.maxRunMs);
    entry.controller.signal.addEventListener("abort", () => finish(true), { once: true });
    try { append({ type: "stream-start" }); }
    catch (error) { entry.controller.abort(); this.entries.delete(streamId); throw error; }
    void (async () => {
      try {
        for await (const chunk of options.source(entry.controller.signal)) {
          if (entry.done) break;
          append(chunk);
        }
        finish(false);
      } catch {
        finish(true);
        entry.controller.abort();
      }
    })();
    return streamId;
  }

  response(options: { streamId: string; ownerId: string; after?: number; signal?: AbortSignal }): Response {
    this.sweep();
    const entry = this.entry(options.streamId, options.ownerId);
    let index = options.after ?? 0;
    if (!Number.isSafeInteger(index) || index < 0 || index > entry.events.length) {
      throw new ChatReplayError("Invalid chat replay cursor.", 409);
    }
    let detached = false;
    let cancelled = false;
    let wake: (() => void) | undefined;
    const detach = () => { detached = true; wake?.(); };
    if (options.signal?.aborted) detach();
    else options.signal?.addEventListener("abort", detach, { once: true });
    const cleanup = () => {
      detach();
      options.signal?.removeEventListener("abort", detach);
    };
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (!detached && index >= entry.events.length && !entry.done) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            entry.listeners.add(resolve);
          });
          if (wake) entry.listeners.delete(wake);
          wake = undefined;
        }
        if (cancelled) return;
        if (detached || index >= entry.events.length) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(entry.events[index++]!));
      },
      cancel: () => { cancelled = true; cleanup(); }
    });
    return new Response(body, { headers: {
      "content-type": "text/event-stream", "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no", "x-zhivex-stream-id": options.streamId
    } });
  }

  cancel(streamId: string, ownerId: string): void {
    this.entry(streamId, ownerId).controller.abort();
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.controller.abort();
    this.entries.clear();
  }

  private entry(streamId: string, ownerId: string): ReplayEntry {
    const entry = this.entries.get(streamId);
    if (!entry || entry.ownerId !== ownerId) throw new ChatReplayError("Chat stream not found or expired.", 404);
    return entry;
  }

  private sweep(): void {
    for (const [id, entry] of this.entries) {
      if (entry.done && entry.expiresAt <= Date.now()) this.entries.delete(id);
    }
  }
}
