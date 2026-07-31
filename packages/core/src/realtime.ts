import { BoundedReplayBroadcast, StreamBufferOverflowError } from "./bounded-broadcast.js";
import { ConfigurationError, UnsupportedFeatureError, ValidationError } from "./errors.js";
import type {
  AudioFrame,
  MediaFrame,
  ModelCapabilities,
  ProviderOptions,
  RealtimeConnectOptions,
  RealtimeErrorEvent,
  RealtimeEvent,
  RealtimeModel,
  RealtimeResponseCompleteEvent,
  RealtimeSession,
  RealtimeSessionConfig,
  RealtimeSessionEndedEvent,
  RealtimeSessionStartedEvent,
  ToolExecutionResult
} from "./types.js";

export interface RealtimeConnection {
  sendJson(payload: Record<string, unknown>): Promise<void>;
  recvJson(): Promise<unknown>;
  close(): Promise<void>;
}

export type RealtimeEventParser = (payload: Record<string, unknown>) => RealtimeEvent[];
export type RealtimePayloadBuilder<TValue> = (value: TValue, config: RealtimeSessionConfig) => Array<Record<string, unknown>>;
export type RealtimeConnectionFactory = (
  url: string,
  headers: Record<string, string>,
  options?: RealtimeConnectOptions
) => Promise<RealtimeConnection>;

export interface RealtimeSessionCallbacks {
  parseEvent: RealtimeEventParser;
  buildAudioPayloads: RealtimePayloadBuilder<AudioFrame>;
  buildMediaPayloads?: RealtimePayloadBuilder<MediaFrame>;
  buildTextPayloads: RealtimePayloadBuilder<string>;
  buildToolResultPayloads: RealtimePayloadBuilder<ToolExecutionResult>;
  buildUpdatePayloads: RealtimePayloadBuilder<RealtimeSessionConfig>;
  buildInitialPayloads?: RealtimePayloadBuilder<RealtimeSessionConfig>;
  buildClosePayloads?: RealtimePayloadBuilder<RealtimeSessionConfig>;
}

export class CallbackRealtimeSession implements RealtimeSession {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  config: RealtimeSessionConfig;

  private readonly connection: RealtimeConnection;
  private readonly callbacks: RealtimeSessionCallbacks;
  private readonly broadcast = new BoundedReplayBroadcast<RealtimeEvent>();
  private receiverPromise?: Promise<void>;
  private closed = false;
  private ended = false;

  constructor(options: {
    provider: string;
    modelId: string;
    capabilities: ModelCapabilities;
    config: RealtimeSessionConfig;
    connection: RealtimeConnection;
    callbacks: RealtimeSessionCallbacks;
  }) {
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.capabilities = options.capabilities;
    this.config = options.config;
    this.connection = options.connection;
    this.callbacks = options.callbacks;
  }

  async initialize() {
    if (this.callbacks.buildInitialPayloads) {
      await this.sendPayloads(this.callbacks.buildInitialPayloads(this.config, this.config));
    }
    const event: RealtimeSessionStartedEvent = {
      type: "realtime-start"
    };
    await this.broadcast.publish(event);
    if (!this.receiverPromise) {
      this.receiverPromise = this.receiveLoop();
    }
  }

  async sendAudio(frame: AudioFrame) {
    await this.sendPayloads(this.callbacks.buildAudioPayloads(frame, this.config));
  }

  async sendMedia(frame: MediaFrame) {
    if (frame.mediaType.startsWith("audio/")) {
      await this.sendAudio(frame);
      return;
    }

    if (!this.callbacks.buildMediaPayloads) {
      throw new UnsupportedFeatureError(
        `Realtime media input is not supported for provider "${this.provider}" with media type "${frame.mediaType}".`
      );
    }

    await this.sendPayloads(this.callbacks.buildMediaPayloads(frame, this.config));
  }

  async sendText(text: string) {
    await this.sendPayloads(this.callbacks.buildTextPayloads(text, this.config));
  }

  async sendToolResult(result: ToolExecutionResult) {
    await this.sendPayloads(this.callbacks.buildToolResultPayloads(result, this.config));
    if (!this.broadcast.isClosed) {
      await this.broadcast.publish({
        type: "realtime-tool-result",
        toolResult: result
      });
    }
  }

  async update(config: Partial<RealtimeSessionConfig>) {
    this.config = {
      ...this.config,
      ...config
    };
    await this.sendPayloads(this.callbacks.buildUpdatePayloads(this.config, this.config));
  }

  eventStream() {
    return this.broadcast.stream();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      if (this.callbacks.buildClosePayloads) {
        await this.sendPayloads(this.callbacks.buildClosePayloads(this.config, this.config));
      }
    } finally {
      await this.connection.close();
      try {
        await this.receiverPromise;
      } catch {
        // ignore connection shutdown errors
      }
      if (!this.ended) {
        this.ended = true;
        await this.broadcast.publish({
          type: "realtime-end",
          reason: "client-close"
        }, { terminal: true });
      }
      await this.broadcast.close();
    }
  }

  private async sendPayloads(payloads: Array<Record<string, unknown>>) {
    for (const payload of payloads) {
      await this.connection.sendJson(payload);
    }
  }

  private async receiveLoop() {
    try {
      while (true) {
        const payload = await this.connection.recvJson();
        if (payload == null) {
          break;
        }
        for (const event of this.callbacks.parseEvent((payload ?? {}) as Record<string, unknown>)) {
          if (event.type === "realtime-end") {
            this.ended = true;
          }
          await this.broadcast.publish(event, { terminal: event.type === "realtime-end" });
          if (event.type === "realtime-end") {
            await this.broadcast.close();
            return;
          }
        }
      }
      if (!this.ended) {
        this.ended = true;
        await this.broadcast.publish({
          type: "realtime-end",
          reason: "connection-closed"
        }, { terminal: true });
      }
    } catch (error) {
      if (error instanceof StreamBufferOverflowError) {
        this.closed = true;
        this.ended = true;
        this.broadcast.fail(error);
        await this.connection.close();
        return;
      }
      const event: RealtimeErrorEvent = {
        type: "realtime-error",
        error: error instanceof Error ? error : new Error(String(error)),
        message: error instanceof Error ? error.message : String(error)
      };
      await this.broadcast.publish(event, { terminal: true });
      if (!this.ended) {
        this.ended = true;
        const ended: RealtimeSessionEndedEvent = {
          type: "realtime-end",
          reason: "error",
          providerMetadata: {
            message: event.message ?? ""
          }
        };
        await this.broadcast.publish(ended, { terminal: true });
      }
    } finally {
      await this.broadcast.close();
    }
  }
}

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

class BrowserRealtimeConnection implements RealtimeConnection {
  private readonly socket: WebSocketLike;
  private readonly queue: unknown[] = [];
  private readonly resolvers: Array<(value: unknown) => void> = [];
  private closed = false;
  private queueFailure?: Error;
  private readonly maxIncomingFrameBytes: number;

  constructor(socket: WebSocketLike, maxIncomingFrameBytes: number) {
    this.socket = socket;
    this.maxIncomingFrameBytes = maxIncomingFrameBytes;
    socket.onmessage = (event) => {
      const value = event.data;
      if (incomingFrameBytes(value) > this.maxIncomingFrameBytes) {
        this.queueFailure = new ValidationError(
          `Realtime frame exceeds the ${this.maxIncomingFrameBytes}-byte limit.`
        );
        this.closed = true;
        while (this.resolvers.length > 0) {
          this.resolvers.shift()!(undefined);
        }
        this.socket.close();
        return;
      }
      if (this.resolvers.length > 0) {
        this.resolvers.shift()!(value);
      } else {
        if (this.queue.length >= 256) {
          this.queueFailure = new StreamBufferOverflowError(256);
          this.closed = true;
          this.socket.close();
          return;
        }
        this.queue.push(value);
      }
    };
    socket.onclose = () => {
      this.closed = true;
      while (this.resolvers.length > 0) {
        this.resolvers.shift()!(undefined);
      }
    };
    socket.onerror = () => {
      this.closed = true;
      while (this.resolvers.length > 0) {
        this.resolvers.shift()!(undefined);
      }
    };
  }

  async sendJson(payload: Record<string, unknown>) {
    this.socket.send(JSON.stringify(payload));
  }

  async recvJson() {
    if (this.queueFailure) {
      throw this.queueFailure;
    }
    if (this.queue.length > 0) {
      return parseIncoming(this.queue.shift(), this.maxIncomingFrameBytes);
    }

    if (this.closed) {
      return undefined;
    }

    const next = await new Promise<unknown>((resolve) => {
      this.resolvers.push(resolve);
    });
    if (this.queueFailure) {
      throw this.queueFailure;
    }
    return parseIncoming(next, this.maxIncomingFrameBytes);
  }

  async close() {
    this.socket.close();
  }
}

const incomingFrameBytes = (value: unknown): number => {
  if (typeof value === "string") {
    return new TextEncoder().encode(value).byteLength;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.size;
  }
  return 0;
};

const parseIncoming = (value: unknown, maxIncomingFrameBytes: number) => {
  if (value == null) {
    return undefined;
  }
  if (incomingFrameBytes(value) > maxIncomingFrameBytes) {
    throw new ValidationError(`Realtime frame exceeds the ${maxIncomingFrameBytes}-byte limit.`);
  }
  if (typeof value === "string") {
    return JSON.parse(value) as unknown;
  }
  if (value instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(value)) as unknown;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.text().then((text) => JSON.parse(text) as unknown);
  }
  return value;
};

const waitForOpen = (socket: WebSocketLike, signal?: AbortSignal, timeoutMs?: number) =>
  new Promise<void>((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (message: string) => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      try {
        socket.close();
      } catch {
        // Best-effort cleanup must not hide the connection error.
      }
      reject(new Error(message));
    };
    const onAbort = () => {
      fail("Realtime connection aborted.");
    };
    timer = timeoutMs ? setTimeout(() => {
      fail(`Realtime connection timed out after ${timeoutMs}ms.`);
    }, timeoutMs) : undefined;
    socket.onopen = () => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve();
    };
    socket.onerror = () => {
      fail("Realtime connection failed.");
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });

export const openWebSocketConnection: RealtimeConnectionFactory = async (url, headers, options) => {
  if (Object.keys(headers).length > 0) {
    throw new ConfigurationError(
      'Default realtime WebSocket connections do not support custom headers. Provide a "realtimeConnectionFactory" from your runtime when auth headers are required.'
    );
  }

  const WebSocketCtor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!WebSocketCtor) {
    throw new ConfigurationError(
      'No global WebSocket implementation is available. Provide a "realtimeConnectionFactory" for realtime sessions.'
    );
  }

  const maxIncomingFrameBytes = options?.maxIncomingFrameBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxIncomingFrameBytes) || maxIncomingFrameBytes <= 0) {
    throw new ConfigurationError(
      'The realtime "maxIncomingFrameBytes" option must be a positive safe integer.'
    );
  }
  const socket = new WebSocketCtor(url, options?.subprotocols);
  await waitForOpen(socket, options?.signal, options?.timeoutMs);
  return new BrowserRealtimeConnection(socket, maxIncomingFrameBytes);
};

export const unsupportedBrowserToken = async (): Promise<never> => {
  throw new UnsupportedFeatureError("This realtime model does not support browser session tokens.");
};

const encodeRealtimeFrameData = (data: string | Uint8Array | ArrayBuffer): string => {
  if (typeof data === "string") {
    return data;
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Buffer.from(bytes).toString("base64");
};

export const encodeAudioFrame = (frame: AudioFrame): string => encodeRealtimeFrameData(frame.data);

export const encodeMediaFrame = (frame: MediaFrame): string => encodeRealtimeFrameData(frame.data);

export const toolResultPayload = (result: ToolExecutionResult): Record<string, unknown> =>
  result.isError
    ? {
        error: result.error ?? { message: "Tool execution failed." }
      }
    : {
        output: result.output ?? null
      };
