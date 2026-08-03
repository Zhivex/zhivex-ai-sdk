import type { UIMessage } from "@zhivex-ai/core";
import type {
  ChatRequestBody,
  ChatStreamChunk,
  ChatTransport,
  ChatTransportRequest,
  FetchChatTransportOptions
} from "./types.js";

const DEFAULT_ENDPOINT = "/api/chat";
const DEFAULT_MAX_EVENT_CHARS = 1024 * 1024;
const DEFAULT_MAX_BUFFER_CHARS = 2 * 1024 * 1024;
const DEFAULT_MAX_STREAM_CHARS = 16 * 1024 * 1024;
const DEFAULT_MAX_STREAM_EVENTS = 10_000;
const DEFAULT_MAX_ERROR_BODY_BYTES = 8 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

const positiveSafeInteger = (
  name: string,
  value: number | false | undefined,
  defaultValue: number
): number | false => {
  const normalized = value ?? defaultValue;
  if (normalized === false) {
    return false;
  }
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new RangeError(`${name} must be a positive safe integer or false.`);
  }
  return normalized;
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ??
  new DOMException("The chat request was aborted.", "AbortError");

const awaitWithSignal = <T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> => {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
};

const createRequestControl = (
  parentSignal: AbortSignal,
  timeoutMs: number | false
) => {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(abortReason(parentSignal));
  if (parentSignal.aborted) {
    onParentAbort();
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer =
    timeoutMs === false
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort(
            new ChatTransportError(
              `Chat request exceeded the ${timeoutMs}ms total timeout.`,
              { code: "request_timeout", timeoutMs }
            )
          );
        }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    timeoutError: () =>
      new ChatTransportError(
        `Chat request exceeded the ${timeoutMs}ms total timeout.`,
        { code: "request_timeout", timeoutMs: timeoutMs || undefined }
      ),
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  };
};

const toUIMessage = (message: ChatTransportRequest["message"]): UIMessage | undefined =>
  message
    ? {
        id: message.id,
        role: message.role,
        parts: message.parts
      }
    : undefined;

export const prepareChatRequestBody = (
  request: ChatTransportRequest
): ChatRequestBody => {
  const hasApprovals = (request.approvals?.length ?? 0) > 0;
  return {
    message: hasApprovals
      ? undefined
      : toUIMessage(request.message ?? request.messages.at(-1)),
    sessionId: request.sessionId,
    approvals: request.approvals,
    metadata: request.metadata
  };
};

export type ChatTransportErrorCode =
  | "http_error"
  | "invalid_response"
  | "network_error"
  | "request_timeout"
  | "stream_idle_timeout";

export class ChatTransportError extends Error {
  readonly code?: ChatTransportErrorCode;
  readonly status?: number;
  readonly statusText?: string;
  readonly responseBody?: string;
  readonly timeoutMs?: number;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      code?: ChatTransportErrorCode;
      status?: number;
      statusText?: string;
      responseBody?: string;
      timeoutMs?: number;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ChatTransportError";
    this.code = options.code;
    this.status = options.status;
    this.statusText = options.statusText;
    this.responseBody = options.responseBody;
    this.timeoutMs = options.timeoutMs;
  }
}

export class ChatStreamParseError extends ChatTransportError {
  readonly event?: string;
  readonly data: string;

  constructor(data: string, event: string | undefined, cause: unknown) {
    super(
      event
        ? `Invalid JSON in "${event}" chat stream event.`
        : "Invalid JSON in chat stream event.",
      { cause, code: "invalid_response" }
    );
    this.name = "ChatStreamParseError";
    this.event = event;
    this.data = data;
  }
}

const readSSELines = async function* (
  stream: ReadableStream<Uint8Array>,
  maxBufferChars: number,
  idleTimeoutMs: number | false
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  const read = async () => {
    if (idleTimeoutMs === false) {
      return reader.read();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ChatTransportError(
                  `Chat stream was idle for more than ${idleTimeoutMs}ms.`,
                  {
                    code: "stream_idle_timeout",
                    timeoutMs: idleTimeoutMs
                  }
                )
              ),
            idleTimeoutMs
          );
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  try {
    let done = false;
    while (!done) {
      const result = await read();
      done = result.done;
      if (done) {
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(result.value, { stream: true });
      }

      while (buffer.length > 0) {
        let separator = -1;
        for (let index = 0; index < buffer.length; index += 1) {
          if (buffer[index] === "\r" || buffer[index] === "\n") {
            separator = index;
            break;
          }
        }
        if (separator === -1) {
          break;
        }

        const character = buffer[separator];
        if (character === "\r" && separator === buffer.length - 1 && !done) {
          break;
        }
        const separatorLength =
          character === "\r" && buffer[separator + 1] === "\n" ? 2 : 1;
        const line = buffer.slice(0, separator);
        buffer = buffer.slice(separator + separatorLength);
        yield line;
      }

      if (buffer.length > maxBufferChars) {
        throw new ChatTransportError(
          `Chat stream line exceeded the ${maxBufferChars} character buffer limit.`
        );
      }
    }
    if (buffer.length > 0) {
      yield buffer;
    }
    completed = true;
  } finally {
    if (!completed) {
      try {
        await reader.cancel(
          new DOMException("Chat stream consumption ended early.", "AbortError")
        );
      } catch {
        // Preserve the original parser, timeout, or consumer error.
      }
    }
    reader.releaseLock();
  }
};

const decodeEvent = (
  dataLines: readonly string[],
  event: string | undefined
): ChatStreamChunk | undefined => {
  if (dataLines.length === 0) {
    return undefined;
  }
  const data = dataLines.join("\n");
  if (data.trim() === "[DONE]") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new ChatStreamParseError(data, event, error);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.type === "string") {
    return record as ChatStreamChunk;
  }
  if (event) {
    return { ...record, type: event } as ChatStreamChunk;
  }
  return undefined;
};

export const parseChatEventStream = async function* (
  stream: ReadableStream<Uint8Array>,
  options: {
    maxEventChars?: number;
    maxBufferChars?: number;
    maxStreamChars?: number;
    maxStreamEvents?: number;
    idleTimeoutMs?: number | false;
  } = {}
): AsyncGenerator<ChatStreamChunk> {
  const maxEventChars = options.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;
  const maxBufferChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  const maxStreamChars =
    options.maxStreamChars ?? DEFAULT_MAX_STREAM_CHARS;
  const maxStreamEvents =
    options.maxStreamEvents ?? DEFAULT_MAX_STREAM_EVENTS;
  const idleTimeoutMs = positiveSafeInteger(
    "idleTimeoutMs",
    options.idleTimeoutMs,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS
  );
  if (!Number.isSafeInteger(maxEventChars) || maxEventChars <= 0) {
    throw new RangeError("maxEventChars must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxBufferChars) || maxBufferChars <= 0) {
    throw new RangeError("maxBufferChars must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxStreamChars) || maxStreamChars <= 0) {
    throw new RangeError("maxStreamChars must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxStreamEvents) || maxStreamEvents <= 0) {
    throw new RangeError("maxStreamEvents must be a positive safe integer.");
  }

  let dataLines: string[] = [];
  let event: string | undefined;
  let eventChars = 0;
  let streamChars = 0;
  let streamEvents = 0;

  for await (const line of readSSELines(stream, maxBufferChars, idleTimeoutMs)) {
    streamChars += line.length + 1;
    if (streamChars > maxStreamChars) {
      throw new ChatTransportError(
        `Chat stream exceeded the ${maxStreamChars} character response limit.`
      );
    }
    if (line === "") {
      const chunk = decodeEvent(dataLines, event);
      dataLines = [];
      event = undefined;
      eventChars = 0;
      if (chunk) {
        streamEvents += 1;
        if (streamEvents > maxStreamEvents) {
          throw new ChatTransportError(
            `Chat stream exceeded the ${maxStreamEvents} event response limit.`
          );
        }
        yield chunk;
      }
      continue;
    }
    if (line.startsWith(":")) {
      continue;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      eventChars += value.length + (dataLines.length === 0 ? 0 : 1);
      if (eventChars > maxEventChars) {
        throw new ChatTransportError(
          `Chat stream event exceeded the ${maxEventChars} character limit.`
        );
      }
      dataLines.push(value);
    } else if (field === "event") {
      event = value;
    }
  }

  const finalChunk = decodeEvent(dataLines, event);
  if (finalChunk) {
    streamEvents += 1;
    if (streamEvents > maxStreamEvents) {
      throw new ChatTransportError(
        `Chat stream exceeded the ${maxStreamEvents} event response limit.`
      );
    }
    yield finalChunk;
  }
};

const readResponseTextWithLimit = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string | undefined> => {
  if (!response.body) {
    return undefined;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  let completed = false;
  let truncated = false;

  try {
    for (;;) {
      if (receivedBytes >= maxBytes) {
        truncated = true;
        break;
      }
      const read = reader.read();
      const result = signal ? await awaitWithSignal(read, signal) : await read;
      if (result.done) {
        completed = true;
        text += decoder.decode();
        break;
      }

      const remaining = maxBytes - receivedBytes;
      const selected =
        result.value.byteLength <= remaining
          ? result.value
          : result.value.subarray(0, remaining);
      receivedBytes += selected.byteLength;
      text += decoder.decode(selected, { stream: true });
      if (selected.byteLength < result.value.byteLength) {
        truncated = true;
        break;
      }
    }
  } catch {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    return text || undefined;
  } finally {
    if (!completed) {
      try {
        await reader.cancel(
          new DOMException("Chat response body limit reached.", "AbortError")
        );
      } catch {
        // A bounded diagnostic body is best-effort.
      }
    }
    reader.releaseLock();
  }

  return truncated ? `${text}\n...[truncated]` : text;
};

const responseError = async (
  response: Response,
  maxErrorBodyBytes: number,
  endpoint: string,
  signal: AbortSignal,
  formatter: FetchChatTransportOptions["formatError"]
): Promise<ChatTransportError> => {
  const responseBody = await readResponseTextWithLimit(
    response,
    maxErrorBodyBytes,
    signal
  );
  const statusText = response.statusText || undefined;
  const defaultMessage = `Chat request failed with ${response.status} ${
    statusText ?? "HTTP error"
  }.`;
  let message = defaultMessage;
  let formatterError: unknown;
  if (formatter) {
    try {
      const formatted = await awaitWithSignal(
        Promise.resolve().then(() =>
          formatter({
            endpoint,
            status: response.status,
            statusText,
            responseBody,
            defaultMessage
          })
        ),
        signal
      );
      if (typeof formatted === "string" && formatted.trim().length > 0) {
        message = formatted;
      }
    } catch (error) {
      if (signal.aborted) {
        throw abortReason(signal);
      }
      formatterError = error;
    }
  }
  return new ChatTransportError(message, {
    cause: formatterError,
    code: "http_error",
    status: response.status,
    statusText: response.statusText,
    responseBody
  });
};

export class FetchChatTransport implements ChatTransport {
  readonly endpoint: string;
  readonly supportsReload: boolean;
  private readonly options: FetchChatTransportOptions;

  constructor(options: FetchChatTransportOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.supportsReload = options.supportsReload ?? false;
    this.options = options;
  }

  async *send(request: ChatTransportRequest): AsyncGenerator<ChatStreamChunk> {
    const maxErrorBodyBytes = positiveSafeInteger(
      "maxErrorBodyBytes",
      this.options.maxErrorBodyBytes,
      DEFAULT_MAX_ERROR_BODY_BYTES
    );
    const requestTimeoutMs = positiveSafeInteger(
      "requestTimeoutMs",
      this.options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    const streamIdleTimeoutMs = positiveSafeInteger(
      "streamIdleTimeoutMs",
      this.options.streamIdleTimeoutMs,
      DEFAULT_STREAM_IDLE_TIMEOUT_MS
    );
    if (maxErrorBodyBytes === false) {
      throw new RangeError("maxErrorBodyBytes cannot be false.");
    }
    const control = createRequestControl(request.signal, requestTimeoutMs);
    let completed = false;

    try {
      const fetchImplementation = this.options.fetch ?? globalThis.fetch;
      if (!fetchImplementation) {
        throw new ChatTransportError(
          "No fetch implementation is available for the chat transport."
        );
      }

      const managedRequest: ChatTransportRequest = {
        ...request,
        signal: control.signal
      };
      const configuredHeaders = await awaitWithSignal(
        Promise.resolve().then(() =>
          typeof this.options.headers === "function"
            ? this.options.headers(managedRequest)
            : this.options.headers
        ),
        control.signal
      );
      const headers = new Headers(configuredHeaders);
      if (!headers.has("accept")) {
        headers.set("accept", "text/event-stream");
      }
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      const buildRequestBody =
        this.options.buildRequestBody ?? prepareChatRequestBody;
      const body = await awaitWithSignal(
        Promise.resolve().then(() => buildRequestBody(managedRequest)),
        control.signal
      );

      let response: Response;
      try {
        response = await awaitWithSignal(
          Promise.resolve(
            fetchImplementation(this.endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: control.signal,
              credentials: this.options.credentials,
              redirect: this.options.redirect ?? "error"
            })
          ),
          control.signal
        );
      } catch (error) {
        if (request.signal.aborted) {
          throw error;
        }
        if (control.timedOut()) {
          throw control.timeoutError();
        }
        throw new ChatTransportError("Unable to reach the chat endpoint.", {
          cause: error,
          code: "network_error"
        });
      }

      if (!response.ok) {
        throw await responseError(
          response,
          maxErrorBodyBytes,
          this.endpoint,
          control.signal,
          this.options.formatError
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        const responseBody = await readResponseTextWithLimit(
          response,
          maxErrorBodyBytes,
          control.signal
        );
        throw new ChatTransportError(
          `Chat endpoint returned "${contentType || "unknown"}" instead of text/event-stream.`,
          {
            code: "invalid_response",
            status: response.status,
            statusText: response.statusText,
            responseBody
          }
        );
      }
      if (!response.body) {
        throw new ChatTransportError(
          "The chat endpoint returned an empty response.",
          {
            code: "invalid_response",
            status: response.status,
            statusText: response.statusText
          }
        );
      }

      yield* parseChatEventStream(response.body, {
        maxEventChars: this.options.maxEventChars,
        maxBufferChars: this.options.maxBufferChars,
        maxStreamChars: this.options.maxStreamChars,
        maxStreamEvents: this.options.maxStreamEvents,
        idleTimeoutMs: streamIdleTimeoutMs
      });
      completed = true;
    } catch (error) {
      if (request.signal.aborted) {
        throw error;
      }
      if (control.timedOut()) {
        throw control.timeoutError();
      }
      throw error;
    } finally {
      if (!completed) {
        control.abort(
          new DOMException("Chat transport consumption ended.", "AbortError")
        );
      }
      control.dispose();
    }
  }
}

export const createFetchChatTransport = (
  options: FetchChatTransportOptions = {}
): ChatTransport => new FetchChatTransport(options);
