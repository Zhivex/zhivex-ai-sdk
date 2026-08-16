import { BoundedReplayBroadcast, StreamBufferOverflowError } from "./bounded-broadcast.js";
import { ConfigurationError, ConflictError, UnsupportedFeatureError, ValidationError } from "./errors.js";
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
  /** When provided, initialization waits for this provider acknowledgement before the session becomes usable. */
  isReadyPayload?: (payload: Record<string, unknown>) => boolean;
  buildAudioPayloads: RealtimePayloadBuilder<AudioFrame>;
  buildMediaPayloads?: RealtimePayloadBuilder<MediaFrame>;
  buildTextPayloads: RealtimePayloadBuilder<string>;
  buildToolResultPayloads: RealtimePayloadBuilder<ToolExecutionResult>;
  buildUpdatePayloads: RealtimePayloadBuilder<RealtimeSessionConfig>;
  buildInitialPayloads?: RealtimePayloadBuilder<RealtimeSessionConfig>;
  buildClosePayloads?: RealtimePayloadBuilder<RealtimeSessionConfig>;
}

type CallbackRealtimeSessionState = "new" | "initializing" | "handshaking" | "open" | "closing" | "closed";

interface RealtimeTerminationOptions {
  reason: string;
  error?: unknown;
  errorEvent?: RealtimeErrorEvent;
  endEvent?: RealtimeSessionEndedEvent;
  sendClosePayloads?: boolean;
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const canonicalRealtimeValue = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRealtimeValue).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalRealtimeValue((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

const realtimeToolCallFingerprint = (event: Extract<RealtimeEvent, { type: "realtime-tool-call" }>) =>
  `${JSON.stringify(event.toolCall.name)}:${canonicalRealtimeValue(event.toolCall.input)}`;

export class CallbackRealtimeSession implements RealtimeSession {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  config: RealtimeSessionConfig;

  private readonly connection: RealtimeConnection;
  private readonly callbacks: RealtimeSessionCallbacks;
  private readonly initializationTimeoutMs?: number;
  private readonly broadcast = new BoundedReplayBroadcast<RealtimeEvent>();
  private readonly seenToolCalls = new Map<string, string>();
  private state: CallbackRealtimeSessionState = "new";
  private initializationPromise?: Promise<void>;
  private terminationPromise?: Promise<void>;
  private terminationError?: Error;
  private readyPromise?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private ready = false;
  private ended = false;

  constructor(options: {
    provider: string;
    modelId: string;
    capabilities: ModelCapabilities;
    config: RealtimeSessionConfig;
    connection: RealtimeConnection;
    callbacks: RealtimeSessionCallbacks;
    /** Optional deadline for a provider setup acknowledgement after the transport opens. */
    initializationTimeoutMs?: number;
  }) {
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.capabilities = options.capabilities;
    this.config = options.config;
    this.connection = options.connection;
    this.callbacks = options.callbacks;
    if (
      options.initializationTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.initializationTimeoutMs) || options.initializationTimeoutMs <= 0)
    ) {
      throw new ConfigurationError("Realtime initialization timeout must be a positive safe integer.");
    }
    this.initializationTimeoutMs = options.initializationTimeoutMs;
    if (this.callbacks.isReadyPayload) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
    }
  }

  initialize(): Promise<void> {
    if (this.state === "open") {
      return Promise.resolve();
    }
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    if (this.state !== "new") {
      return Promise.reject(new ConfigurationError("Realtime session is already closing or closed."));
    }

    this.state = "initializing";
    this.initializationPromise = this.start();
    return this.initializationPromise;
  }

  async sendAudio(frame: AudioFrame) {
    this.assertOpen();
    await this.sendBuiltPayloads(() => this.callbacks.buildAudioPayloads(frame, this.config));
  }

  async sendMedia(frame: MediaFrame) {
    this.assertOpen();
    if (frame.mediaType.startsWith("audio/")) {
      await this.sendBuiltPayloads(() => this.callbacks.buildAudioPayloads(frame, this.config));
      return;
    }

    if (!this.callbacks.buildMediaPayloads) {
      throw new UnsupportedFeatureError(
        `Realtime media input is not supported for provider "${this.provider}" with media type "${frame.mediaType}".`
      );
    }

    await this.sendBuiltPayloads(() => this.callbacks.buildMediaPayloads!(frame, this.config));
  }

  async sendText(text: string) {
    this.assertOpen();
    await this.sendBuiltPayloads(() => this.callbacks.buildTextPayloads(text, this.config));
  }

  async sendToolResult(result: ToolExecutionResult) {
    this.assertOpen();
    const payloads = this.callbacks.buildToolResultPayloads(result, this.config);
    try {
      await this.sendPayloads(payloads);
      await this.broadcast.publish({
        type: "realtime-tool-result",
        toolResult: result
      });
    } catch (error) {
      await this.terminate({ reason: "error", error });
      throw error;
    }
  }

  async update(config: Partial<RealtimeSessionConfig>) {
    this.assertOpen();
    const nextConfig = {
      ...this.config,
      ...config
    };
    await this.sendBuiltPayloads(() => this.callbacks.buildUpdatePayloads(nextConfig, nextConfig));
    this.config = nextConfig;
  }

  eventStream() {
    return this.broadcast.stream();
  }

  async close() {
    if (this.state === "closed") {
      return;
    }
    const initiatedTermination = !this.terminationPromise;
    const sendClosePayloads = this.state === "open";
    await this.terminate({
      reason: "client-close",
      sendClosePayloads
    });
    if (initiatedTermination && this.terminationError) {
      throw this.terminationError;
    }
  }

  private async start() {
    try {
      if (this.callbacks.buildInitialPayloads) {
        await this.sendPayloads(this.callbacks.buildInitialPayloads(this.config, this.config));
      }
      if (this.state !== "initializing") {
        throw new ConfigurationError("Realtime session was closed during initialization.");
      }
      if (this.readyPromise) {
        this.state = "handshaking";
        void this.receiveLoop();
        if (this.initializationTimeoutMs === undefined) {
          await this.readyPromise;
        } else {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              this.readyPromise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(
                    `Realtime provider setup timed out after ${this.initializationTimeoutMs}ms.`
                  )),
                  this.initializationTimeoutMs
                );
              })
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        if (this.state !== "handshaking") {
          throw this.terminationError ?? new ConfigurationError("Realtime session was closed during initialization.");
        }
        this.state = "open";
      }
      const event: RealtimeSessionStartedEvent = {
        type: "realtime-start"
      };
      await this.broadcast.publish(event);
      if (!this.readyPromise) {
        if (this.state !== "initializing") {
          throw new ConfigurationError("Realtime session was closed during initialization.");
        }
        this.state = "open";
        void this.receiveLoop();
      }
    } catch (error) {
      if (this.state !== "closing" && this.state !== "closed") {
        await this.terminate({ reason: "error", error });
      }
      throw error;
    }
  }

  private assertOpen() {
    if (this.state !== "open") {
      throw new ConfigurationError("Realtime session is not open.");
    }
  }

  private async sendBuiltPayloads(build: () => Array<Record<string, unknown>>) {
    const payloads = build();
    try {
      await this.sendPayloads(payloads);
    } catch (error) {
      await this.terminate({ reason: "error", error });
      throw error;
    }
  }

  private async sendPayloads(payloads: Array<Record<string, unknown>>) {
    for (const payload of payloads) {
      await this.connection.sendJson(payload);
    }
  }

  private async receiveLoop() {
    try {
      while (this.state === "open" || this.state === "handshaking") {
        const payload = await this.connection.recvJson();
        if (this.state !== "open" && this.state !== "handshaking") {
          return;
        }
        if (payload == null) {
          await this.terminate({ reason: "connection-closed" });
          return;
        }
        const record = (payload ?? {}) as Record<string, unknown>;
        if (!this.ready && this.callbacks.isReadyPayload?.(record)) {
          this.ready = true;
          this.resolveReady?.();
        }
        for (const event of this.callbacks.parseEvent(record)) {
          if (event.type === "realtime-tool-call") {
            const fingerprint = realtimeToolCallFingerprint(event);
            const previous = this.seenToolCalls.get(event.toolCall.id);
            if (previous !== undefined) {
              if (previous !== fingerprint) {
                await this.terminate({
                  reason: "error",
                  error: new ConflictError(
                    `Realtime tool call id "${event.toolCall.id}" was reused with a different payload.`
                  )
                });
                return;
              }
              continue;
            }
            this.seenToolCalls.set(event.toolCall.id, fingerprint);
          }
          if (event.type === "realtime-error") {
            await this.terminate({
              reason: "error",
              errorEvent: event
            });
            return;
          }
          if (event.type === "realtime-end") {
            await this.terminate({
              reason: event.reason ?? "connection-closed",
              endEvent: event
            });
            return;
          }
          if (this.state !== "open" && this.state !== "handshaking") {
            return;
          }
          await this.broadcast.publish(event);
        }
      }
    } catch (error) {
      if (this.state === "closing" || this.state === "closed") {
        return;
      }
      await this.terminate({ reason: "error", error });
    }
  }

  private terminate(options: RealtimeTerminationOptions): Promise<void> {
    if (this.terminationPromise) {
      return this.terminationPromise;
    }
    this.state = "closing";
    this.terminationPromise = this.finishTermination(options);
    return this.terminationPromise;
  }

  private async finishTermination(options: RealtimeTerminationOptions) {
    let errorEvent = options.errorEvent;
    let failure = options.error === undefined ? undefined : asError(options.error);

    if (options.sendClosePayloads && this.callbacks.buildClosePayloads) {
      try {
        await this.sendPayloads(this.callbacks.buildClosePayloads(this.config, this.config));
      } catch (error) {
        failure = asError(error);
      }
    }

    try {
      await this.connection.close();
    } catch (error) {
      failure ??= asError(error);
    }

    if (!errorEvent && failure) {
      errorEvent = {
        type: "realtime-error",
        error: failure,
        message: failure.message
      };
    }

    if (!this.ready && this.readyPromise) {
      const readinessError = failure ?? errorEvent?.error ?? new ConfigurationError(
        `Realtime session ended before provider "${this.provider}" acknowledged setup.`
      );
      this.rejectReady?.(asError(readinessError));
    }

    const terminalEvents: RealtimeEvent[] = [];
    if (errorEvent) {
      terminalEvents.push(errorEvent);
    }
    if (!this.ended) {
      this.ended = true;
      terminalEvents.push(options.endEvent ?? {
        type: "realtime-end",
        reason: errorEvent ? "error" : options.reason,
        ...(errorEvent
          ? {
              providerMetadata: {
                message: errorEvent.message ?? errorEvent.error?.message ?? ""
              }
            }
          : {})
      });
    }

    try {
      for (const event of terminalEvents) {
        await this.broadcast.publish(event, { terminal: true });
      }
    } catch (error) {
      const publishFailure = asError(error);
      failure ??= publishFailure;
      if (!this.broadcast.isClosed) {
        this.broadcast.fail(publishFailure);
      }
    } finally {
      this.broadcast.close();
      this.state = "closed";
    }

    this.terminationError = failure;
  }
}

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
}

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

class BrowserRealtimeConnection implements RealtimeConnection {
  private readonly socket: WebSocketLike;
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private queueFailure?: Error;
  private readonly maxIncomingFrameBytes: number;
  private readonly signal?: AbortSignal;
  private readonly onAbort: () => void;

  constructor(socket: WebSocketLike, maxIncomingFrameBytes: number, signal?: AbortSignal) {
    this.socket = socket;
    this.maxIncomingFrameBytes = maxIncomingFrameBytes;
    this.signal = signal;
    this.onAbort = () => {
      this.fail(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The realtime connection was aborted.", "AbortError")
      );
    };
    socket.onmessage = (event) => {
      if (this.closed) {
        return;
      }
      const value = event.data;
      if (incomingFrameBytes(value) > this.maxIncomingFrameBytes) {
        this.fail(new ValidationError(
          `Realtime frame exceeds the ${this.maxIncomingFrameBytes}-byte limit.`
        ));
        return;
      }
      if (this.waiters.length > 0) {
        this.waiters.shift()!.resolve(value);
      } else {
        if (this.queue.length >= 256) {
          this.fail(new StreamBufferOverflowError(256));
          return;
        }
        this.queue.push(value);
      }
    };
    socket.onclose = (event) => {
      if (
        !this.closed &&
        ((typeof event.code === "number" && event.code !== 1_000) || event.wasClean === false)
      ) {
        const details = [
          typeof event.code === "number" ? `code ${event.code}` : undefined,
          event.reason?.trim() || undefined
        ].filter(Boolean).join(": ");
        this.fail(new Error(`Realtime WebSocket closed unexpectedly${details ? ` (${details})` : ""}.`));
        return;
      }
      this.finish();
    };
    socket.onerror = () => {
      this.fail(new Error("Realtime WebSocket connection failed."));
    };
    if (signal?.aborted) {
      this.onAbort();
    } else {
      signal?.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  async sendJson(payload: Record<string, unknown>) {
    if (this.queueFailure) {
      throw this.queueFailure;
    }
    if (this.closed) {
      throw new Error("Realtime connection is closed.");
    }
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      const failure = asError(error);
      this.fail(failure);
      throw failure;
    }
  }

  async recvJson() {
    if (this.queueFailure) {
      throw this.queueFailure;
    }
    if (this.queue.length > 0) {
      return this.parseFrame(this.queue.shift());
    }

    if (this.closed) {
      return undefined;
    }

    const next = await new Promise<unknown>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (this.queueFailure) {
      throw this.queueFailure;
    }
    return this.parseFrame(next);
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.finish();
    try {
      this.socket.close();
    } catch (error) {
      const failure = asError(error);
      this.queueFailure = failure;
      throw failure;
    }
  }

  private async parseFrame(value: unknown) {
    try {
      return await parseIncoming(value, this.maxIncomingFrameBytes);
    } catch (error) {
      const failure = asError(error);
      this.fail(failure);
      throw failure;
    }
  }

  private finish() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cleanupSignal();
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve(undefined);
    }
  }

  private fail(error: Error) {
    if (this.queueFailure || this.closed) {
      return;
    }
    this.queueFailure = error;
    this.closed = true;
    this.queue.length = 0;
    this.cleanupSignal();
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(error);
    }
    try {
      this.socket.close();
    } catch {
      // The original transport error remains the actionable failure.
    }
  }

  private cleanupSignal() {
    this.signal?.removeEventListener("abort", this.onAbort);
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
    socket.onclose = () => {
      fail("Realtime connection closed before opening.");
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
  if (
    options?.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new ConfigurationError(
      'The realtime "timeoutMs" option must be a positive safe integer.'
    );
  }
  const socket = new WebSocketCtor(url, options?.subprotocols);
  await waitForOpen(socket, options?.signal, options?.timeoutMs);
  return new BrowserRealtimeConnection(socket, maxIncomingFrameBytes, options?.signal);
};

export const unsupportedBrowserToken = async (): Promise<never> => {
  throw new UnsupportedFeatureError("This realtime model does not support browser session tokens.");
};

const encodeRealtimeFrameData = (data: string | Uint8Array | ArrayBuffer): string => {
  if (typeof data === "string") {
    return data;
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunks: string[] = [];
  const inputChunkBytes = 12 * 1024;
  for (let chunkStart = 0; chunkStart < bytes.length; chunkStart += inputChunkBytes) {
    const chunkEnd = Math.min(chunkStart + inputChunkBytes, bytes.length);
    let encodedChunk = "";
    for (let index = chunkStart; index < chunkEnd; index += 3) {
      const first = bytes[index] ?? 0;
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
      encodedChunk += alphabet[(value >>> 18) & 0x3f]!;
      encodedChunk += alphabet[(value >>> 12) & 0x3f]!;
      encodedChunk += second === undefined ? "=" : alphabet[(value >>> 6) & 0x3f]!;
      encodedChunk += third === undefined ? "=" : alphabet[value & 0x3f]!;
    }
    chunks.push(encodedChunk);
  }
  return chunks.join("");
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
