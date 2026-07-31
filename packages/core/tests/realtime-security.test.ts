import { describe, expect, it } from "vitest";

import { openWebSocketConnection } from "../src/index.js";

class FakeWebSocket {
  static latest?: FakeWebSocket;
  closeCalled = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor() {
    FakeWebSocket.latest = this;
    queueMicrotask(() => this.onopen?.({}));
  }

  send() {}

  close() {
    this.closeCalled = true;
    this.onclose?.({});
  }

  emit(data: string | ArrayBuffer | Blob) {
    this.onmessage?.({ data });
  }
}

class PendingWebSocket extends FakeWebSocket {
  constructor() {
    super();
    FakeWebSocket.latest = this;
    this.onopen = null;
  }
}

describe("realtime frame security", () => {
  it("decodes browser frames without relying on the Node Buffer global", async () => {
    const originalWebSocket = globalThis.WebSocket;
    const globals = globalThis as unknown as { Buffer?: unknown };
    const originalBuffer = globals.Buffer;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    delete globals.Buffer;
    try {
      const stringConnection = await openWebSocketConnection("wss://example.com", {});
      FakeWebSocket.latest!.emit('{"kind":"string"}');
      await expect(stringConnection.recvJson()).resolves.toEqual({ kind: "string" });

      const arrayBufferConnection = await openWebSocketConnection("wss://example.com", {});
      FakeWebSocket.latest!.emit(new TextEncoder().encode('{"kind":"bytes"}').buffer);
      await expect(arrayBufferConnection.recvJson()).resolves.toEqual({ kind: "bytes" });
    } finally {
      globals.Buffer = originalBuffer;
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("rejects oversized string, ArrayBuffer, and Blob frames before decoding", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      for (const frame of [
        "x".repeat(9),
        new Uint8Array(9).buffer,
        new Blob([new Uint8Array(9)])
      ]) {
        const connection = await openWebSocketConnection("wss://example.com", {}, {
          maxIncomingFrameBytes: 8
        });
        FakeWebSocket.latest!.emit(frame);
        await expect(connection.recvJson()).rejects.toThrow("8-byte limit");
      }
    } finally {
      globalThis.WebSocket = original;
    }
  });

  it("closes the socket when opening is already aborted", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = PendingWebSocket as unknown as typeof WebSocket;
    const controller = new AbortController();
    controller.abort();
    try {
      const connection = openWebSocketConnection("wss://example.com", {}, {
        signal: controller.signal
      });
      await expect(connection).rejects.toThrow("aborted");
      expect(FakeWebSocket.latest).toBeInstanceOf(PendingWebSocket);
      expect(FakeWebSocket.latest!.closeCalled).toBe(true);
    } finally {
      globalThis.WebSocket = original;
    }
  });
});
