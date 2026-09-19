import type { RawData } from "ws";
import { ValidationError } from "./errors.js";
import type { RealtimeConnection, RealtimeConnectionFactory } from "./realtime.js";

const REALTIME_QUEUE_LIMIT = 256;

const nodeWebSocketDataToText = (data: RawData) => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
};

const nodeWebSocketDataByteLength = (data: RawData) =>
  Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data instanceof ArrayBuffer
      ? data.byteLength
      : data.byteLength;

const REALTIME_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export const openAuthenticatedWebSocketConnection: RealtimeConnectionFactory = async (url, headers, options) => {
  if (options?.signal?.aborted) {
    throw new Error("Realtime connection aborted.");
  }
  const maxIncomingFrameBytes = options?.maxIncomingFrameBytes ?? REALTIME_MAX_MESSAGE_BYTES;
  if (!Number.isSafeInteger(maxIncomingFrameBytes) || maxIncomingFrameBytes <= 0) {
    throw new ValidationError(
      'The realtime "maxIncomingFrameBytes" option must be a positive safe integer.'
    );
  }
  if (
    options?.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new ValidationError('The realtime "timeoutMs" option must be a positive safe integer.');
  }

  const { default: WebSocket } = await import("ws");
  if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException("Realtime connection aborted.", "AbortError");
  const socket = options?.subprotocols?.length
    ? new WebSocket(url, options.subprotocols, { headers, maxPayload: maxIncomingFrameBytes, followRedirects: false })
    : new WebSocket(url, { headers, maxPayload: maxIncomingFrameBytes, followRedirects: false });

  // Closing a CONNECTING ws schedules an error; keep it handled after cleanup.
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      options?.signal?.removeEventListener("abort", onAbort);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      callback();
    };
    const onClose = () => finish(() => reject(new Error("Realtime connection closed before opening.")));
    const onOpen = () => finish(resolve);
    const onError = (error: Error) => finish(() => reject(error));
    const onAbort = () => {
      socket.close();
      finish(() => reject(new Error("Realtime connection aborted.")));
    };
    const timer = options?.timeoutMs
      ? setTimeout(
          () => {
            socket.close();
            finish(() => reject(new Error(`Realtime connection timed out after ${options.timeoutMs}ms.`)));
          },
          options.timeoutMs
        )
      : undefined;

    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
    options?.signal?.addEventListener("abort", onAbort, { once: true });
  });

  const queue: string[] = [];
  const readers: Array<{
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  let closed = false;
  let connectionError: Error | undefined;

  const rejectReaders = (error: Error) => {
    for (const reader of readers.splice(0)) {
      reader.reject(error);
    }
  };
  const closeReaders = () => {
    for (const reader of readers.splice(0)) {
      reader.resolve(undefined);
    }
  };
  const onSessionAbort = () => {
    if (closed || connectionError) {
      return;
    }
    connectionError = options?.signal?.reason instanceof Error
      ? options.signal.reason
      : new DOMException("The Realtime session was aborted.", "AbortError");
    rejectReaders(connectionError);
    socket.close();
  };
  if (options?.signal?.aborted) {
    onSessionAbort();
  } else {
    options?.signal?.addEventListener("abort", onSessionAbort, { once: true });
  }

  socket.on("message", (data) => {
    const frameBytes = nodeWebSocketDataByteLength(data);
    if (frameBytes > maxIncomingFrameBytes) {
      connectionError = new ValidationError(
        `Realtime frame exceeds the configured ${maxIncomingFrameBytes}-byte limit.`
      );
      rejectReaders(connectionError);
      socket.close();
      return;
    }
    const text = nodeWebSocketDataToText(data);
    const reader = readers.shift();
    if (reader) {
      try {
        reader.resolve(JSON.parse(text));
      } catch (error) {
        reader.reject(error);
      }
      return;
    }

    if (queue.length >= REALTIME_QUEUE_LIMIT) {
      connectionError = new Error(
        `Realtime receive buffer exceeded ${REALTIME_QUEUE_LIMIT} messages.`
      );
      connectionError.name = "StreamBufferOverflowError";
      socket.close();
      return;
    }
    queue.push(text);
  });
  socket.on("error", (error) => {
    connectionError = error;
    rejectReaders(error);
  });
  socket.on("close", (code, reason) => {
    closed = true;
    options?.signal?.removeEventListener("abort", onSessionAbort);
    if (!connectionError && code !== 1000 && code !== 1001) {
      connectionError = new Error(`Realtime WebSocket closed with code ${code}${reason.length ? `: ${reason.toString()}` : "."}`);
    }
    if (connectionError) {
      rejectReaders(connectionError);
    } else {
      closeReaders();
    }
  });

  const connection: RealtimeConnection = {
    async sendJson(payload) {
      if (connectionError) {
        throw connectionError;
      }
      if (closed) {
        throw new Error("Realtime connection is closed.");
      }
      await new Promise<void>((resolve, reject) => {
        socket.send(JSON.stringify(payload), (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
    async recvJson() {
      if (connectionError) {
        throw connectionError;
      }
      if (queue.length > 0) {
        return JSON.parse(queue.shift()!);
      }
      if (closed) {
        return undefined;
      }
      return new Promise((resolve, reject) => readers.push({ resolve, reject }));
    },
    async close() {
      if (closed) {
        return;
      }
      options?.signal?.removeEventListener("abort", onSessionAbort);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1_000);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close();
      });
    }
  };

  return connection;
};
