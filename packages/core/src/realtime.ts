import { ConfigurationError, UnsupportedFeatureError } from "./errors.js";
import type {
  AudioFrame,
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
  buildTextPayloads: RealtimePayloadBuilder<string>;
  buildToolResultPayloads: RealtimePayloadBuilder<ToolExecutionResult>;
  buildUpdatePayloads: RealtimePayloadBuilder<RealtimeSessionConfig>;
  buildInitialPayloads?: RealtimePayloadBuilder<RealtimeSessionConfig>;
  buildClosePayloads?: RealtimePayloadBuilder<RealtimeSessionConfig>;
}

class Broadcast {
  private history: RealtimeEvent[] = [];
  private done = false;
  private subscribers = new Set<(event: RealtimeEvent | undefined) => void>();

  async publish(event: RealtimeEvent) {
    this.history.push(event);
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  async close() {
    this.done = true;
    for (const subscriber of this.subscribers) {
      subscriber(undefined);
    }
    this.subscribers.clear();
  }

  stream(): AsyncIterable<RealtimeEvent> {
    const self = this;
    return (async function* () {
      let cursor = 0;
      while (true) {
        while (cursor < self.history.length) {
          yield self.history[cursor]!;
          cursor += 1;
        }

        if (self.done) {
          return;
        }

        const next = await new Promise<RealtimeEvent | undefined>((resolve) => {
          const subscriber = (event: RealtimeEvent | undefined) => {
            self.subscribers.delete(subscriber);
            resolve(event);
          };
          self.subscribers.add(subscriber);
        });

        if (!next) {
          return;
        }
      }
    })();
  }
}

export class CallbackRealtimeSession implements RealtimeSession {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  config: RealtimeSessionConfig;

  private readonly connection: RealtimeConnection;
  private readonly callbacks: RealtimeSessionCallbacks;
  private readonly broadcast = new Broadcast();
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
    if (!this.receiverPromise) {
      this.receiverPromise = this.receiveLoop();
    }
    if (this.callbacks.buildInitialPayloads) {
      await this.sendPayloads(this.callbacks.buildInitialPayloads(this.config, this.config));
    }
    const event: RealtimeSessionStartedEvent = {
      type: "realtime-start"
    };
    await this.broadcast.publish(event);
  }

  async sendAudio(frame: AudioFrame) {
    await this.sendPayloads(this.callbacks.buildAudioPayloads(frame, this.config));
  }

  async sendText(text: string) {
    await this.sendPayloads(this.callbacks.buildTextPayloads(text, this.config));
  }

  async sendToolResult(result: ToolExecutionResult) {
    await this.sendPayloads(this.callbacks.buildToolResultPayloads(result, this.config));
    await this.broadcast.publish({
      type: "realtime-tool-result",
      toolResult: result
    });
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
        });
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
          await this.broadcast.publish(event);
          if (event.type === "realtime-end") {
            await this.broadcast.close();
            return;
          }
        }
      }
    } catch (error) {
      const event: RealtimeErrorEvent = {
        type: "realtime-error",
        error: error instanceof Error ? error : new Error(String(error)),
        message: error instanceof Error ? error.message : String(error)
      };
      await this.broadcast.publish(event);
      if (!this.ended) {
        this.ended = true;
        const ended: RealtimeSessionEndedEvent = {
          type: "realtime-end",
          reason: "error",
          providerMetadata: {
            message: event.message ?? ""
          }
        };
        await this.broadcast.publish(ended);
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

  constructor(socket: WebSocketLike) {
    this.socket = socket;
    socket.onmessage = (event) => {
      const value = event.data;
      if (this.resolvers.length > 0) {
        this.resolvers.shift()!(value);
      } else {
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
    if (this.queue.length > 0) {
      return parseIncoming(this.queue.shift());
    }

    if (this.closed) {
      return undefined;
    }

    const next = await new Promise<unknown>((resolve) => {
      this.resolvers.push(resolve);
    });
    return parseIncoming(next);
  }

  async close() {
    this.socket.close();
  }
}

const parseIncoming = (value: unknown) => {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as unknown;
  }
  if (value instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.text().then((text) => JSON.parse(text) as unknown);
  }
  return value;
};

const waitForOpen = (socket: WebSocketLike, signal?: AbortSignal, timeoutMs?: number) =>
  new Promise<void>((resolve, reject) => {
    let finished = false;
    const onAbort = () => {
      if (finished) {
        return;
      }
      finished = true;
      reject(new Error("Realtime connection aborted."));
    };
    const timer = timeoutMs ? setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Realtime connection timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs) : undefined;
    socket.onopen = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve();
    };
    socket.onerror = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      reject(new Error("Realtime connection failed."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
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

  const socket = new WebSocketCtor(url, options?.subprotocols);
  await waitForOpen(socket, options?.signal, options?.timeoutMs);
  return new BrowserRealtimeConnection(socket);
};

export const unsupportedBrowserToken = async (): Promise<never> => {
  throw new UnsupportedFeatureError("This realtime model does not support browser session tokens.");
};

export const encodeAudioFrame = (frame: AudioFrame): string => {
  if (typeof frame.data === "string") {
    return frame.data;
  }
  const bytes = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
  return Buffer.from(bytes).toString("base64");
};

export const toolResultPayload = (result: ToolExecutionResult): Record<string, unknown> =>
  result.isError
    ? {
        error: result.error ?? { message: "Tool execution failed." }
      }
    : {
        output: result.output ?? null
      };
