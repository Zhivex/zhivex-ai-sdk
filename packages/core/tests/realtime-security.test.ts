import { describe, expect, it } from "vitest";

import { encodeAudioFrame, encodeMediaFrame, openWebSocketConnection } from "../src/index.js";

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

  fail() {
    this.onerror?.({});
  }

  closeFromServer() {
    this.onclose?.({});
  }
}

class PendingWebSocket extends FakeWebSocket {
  constructor() {
    super();
    FakeWebSocket.latest = this;
    this.onopen = null;
  }
}

class CloseBeforeOpenWebSocket {
  static latest?: CloseBeforeOpenWebSocket;
  closeCalled = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor() {
    CloseBeforeOpenWebSocket.latest = this;
    queueMicrotask(() => this.onclose?.({}));
  }

  send() {}

  close() {
    this.closeCalled = true;
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

  it("encodes audio and media frames without relying on the Node Buffer global", () => {
    const globals = globalThis as unknown as { Buffer?: unknown };
    const originalBuffer = globals.Buffer;
    const largeFrame = Uint8Array.from(
      { length: 64 * 1024 + 5 },
      (_, index) => index % 251
    );
    const expectedLargeFrame = Buffer.from(largeFrame).toString("base64");
    delete globals.Buffer;
    try {
      expect(encodeAudioFrame({
        data: new Uint8Array([0, 1, 2, 253, 254, 255]),
        mediaType: "audio/pcm"
      })).toBe("AAEC/f7/");
      expect(encodeMediaFrame({
        data: new Uint8Array([251, 255]).buffer,
        mediaType: "image/png"
      })).toBe("+/8=");
      expect(encodeAudioFrame({
        data: "already-base64",
        mediaType: "audio/pcm"
      })).toBe("already-base64");
      expect(encodeMediaFrame({
        data: largeFrame,
        mediaType: "image/jpeg"
      })).toBe(expectedLargeFrame);
    } finally {
      globals.Buffer = originalBuffer;
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

  it("rejects when the socket closes before opening", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = CloseBeforeOpenWebSocket as unknown as typeof WebSocket;
    try {
      await expect(openWebSocketConnection("wss://example.com", {})).rejects.toThrow(
        "closed before opening"
      );
      expect(CloseBeforeOpenWebSocket.latest?.closeCalled).toBe(true);
    } finally {
      globalThis.WebSocket = original;
    }
  });

  it("rejects pending receives on socket errors and aborts after opening", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const failedConnection = await openWebSocketConnection("wss://example.com", {});
      const failedReceive = failedConnection.recvJson();
      FakeWebSocket.latest!.fail();
      await expect(failedReceive).rejects.toThrow("WebSocket connection failed");
      expect(FakeWebSocket.latest!.closeCalled).toBe(true);

      const controller = new AbortController();
      const abortedConnection = await openWebSocketConnection("wss://example.com", {}, {
        signal: controller.signal
      });
      const abortedReceive = abortedConnection.recvJson();
      controller.abort();
      await expect(abortedReceive).rejects.toThrow("aborted");
      expect(FakeWebSocket.latest!.closeCalled).toBe(true);
    } finally {
      globalThis.WebSocket = original;
    }
  });

  it("closes malformed connections and releases pending receives on client close", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const malformedConnection = await openWebSocketConnection("wss://example.com", {});
      FakeWebSocket.latest!.emit("not-json");
      await expect(malformedConnection.recvJson()).rejects.toBeInstanceOf(SyntaxError);
      expect(FakeWebSocket.latest!.closeCalled).toBe(true);

      const closedConnection = await openWebSocketConnection("wss://example.com", {});
      const pendingReceive = closedConnection.recvJson();
      await closedConnection.close();
      await expect(pendingReceive).resolves.toBeUndefined();
    } finally {
      globalThis.WebSocket = original;
    }
  });

  it("rejects invalid connection limits before constructing a socket", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      await expect(openWebSocketConnection("wss://example.com", {}, {
        timeoutMs: 0
      })).rejects.toThrow("positive safe integer");
      await expect(openWebSocketConnection("wss://example.com", {}, {
        maxIncomingFrameBytes: Number.NaN
      })).rejects.toThrow("positive safe integer");
    } finally {
      globalThis.WebSocket = original;
    }
  });
});
