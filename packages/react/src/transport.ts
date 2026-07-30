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

export class ChatTransportError extends Error {
  readonly status?: number;
  readonly statusText?: string;
  readonly responseBody?: string;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      status?: number;
      statusText?: string;
      responseBody?: string;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ChatTransportError";
    this.status = options.status;
    this.statusText = options.statusText;
    this.responseBody = options.responseBody;
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
      { cause }
    );
    this.name = "ChatStreamParseError";
    this.event = event;
    this.data = data;
  }
}

const readSSELines = async function* (
  stream: ReadableStream<Uint8Array>,
  maxBufferChars: number
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
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
  } finally {
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
  } = {}
): AsyncGenerator<ChatStreamChunk> {
  const maxEventChars = options.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;
  const maxBufferChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  if (!Number.isSafeInteger(maxEventChars) || maxEventChars <= 0) {
    throw new RangeError("maxEventChars must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxBufferChars) || maxBufferChars <= 0) {
    throw new RangeError("maxBufferChars must be a positive safe integer.");
  }

  let dataLines: string[] = [];
  let event: string | undefined;
  let eventChars = 0;

  for await (const line of readSSELines(stream, maxBufferChars)) {
    if (line === "") {
      const chunk = decodeEvent(dataLines, event);
      dataLines = [];
      event = undefined;
      eventChars = 0;
      if (chunk) {
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
    yield finalChunk;
  }
};

const responseError = async (response: Response): Promise<ChatTransportError> => {
  let responseBody: string | undefined;
  try {
    responseBody = (await response.text()).slice(0, 8_192);
  } catch {
    responseBody = undefined;
  }
  const detail = responseBody?.trim();
  return new ChatTransportError(
    `Chat request failed with ${response.status} ${response.statusText || "HTTP error"}${
      detail ? `: ${detail}` : ""
    }`,
    {
      status: response.status,
      statusText: response.statusText,
      responseBody
    }
  );
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
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    if (!fetchImplementation) {
      throw new ChatTransportError(
        "No fetch implementation is available for the chat transport."
      );
    }

    const configuredHeaders =
      typeof this.options.headers === "function"
        ? await this.options.headers(request)
        : this.options.headers;
    const headers = new Headers(configuredHeaders);
    if (!headers.has("accept")) {
      headers.set("accept", "text/event-stream");
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const buildRequestBody =
      this.options.buildRequestBody ?? prepareChatRequestBody;
    const body = await buildRequestBody(request);

    let response: Response;
    try {
      response = await fetchImplementation(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
        credentials: this.options.credentials
      });
    } catch (error) {
      if (request.signal.aborted) {
        throw error;
      }
      throw new ChatTransportError("Unable to reach the chat endpoint.", {
        cause: error
      });
    }

    if (!response.ok) {
      throw await responseError(response);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      let responseBody: string | undefined;
      try {
        responseBody = (await response.text()).slice(0, 8_192);
      } catch {
        responseBody = undefined;
      }
      throw new ChatTransportError(
        `Chat endpoint returned "${contentType || "unknown"}" instead of text/event-stream.`,
        {
          status: response.status,
          statusText: response.statusText,
          responseBody
        }
      );
    }
    if (!response.body) {
      throw new ChatTransportError("The chat endpoint returned an empty response.", {
        status: response.status,
        statusText: response.statusText
      });
    }

    yield* parseChatEventStream(response.body, {
      maxEventChars: this.options.maxEventChars,
      maxBufferChars: this.options.maxBufferChars
    });
  }
}

export const createFetchChatTransport = (
  options: FetchChatTransportOptions = {}
): ChatTransport => new FetchChatTransport(options);
