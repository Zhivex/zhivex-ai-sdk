import { ParseError, ProviderHTTPError } from "./errors.js";
import type { RunnerStreamResult } from "./runner.js";
import type { AgentStreamResult, StreamTextResult, UIMessageChunk } from "./types.js";
import { toUIMessageStream } from "./ui.js";

const encoder = new TextEncoder();

const DEFAULT_SSE_MAX_EVENT_CHARS = 1024 * 1024;
const DEFAULT_SSE_ERROR_BODY_MAX_CHARS = 64 * 1024;

export interface StreamSSEOptions {
  maxBufferChars?: number;
  maxEventChars?: number;
  maxErrorBodyChars?: number;
}

const normalizePositiveLimit = (value: number | undefined, fallback: number) => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
};

const appendTruncationNotice = (body: string, omittedChars: number) =>
  `${body}\n...[truncated after receiving ${omittedChars} additional characters]`;

const readBoundedResponseText = async (response: Response, maxChars: number) => {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const errorDecoder = new TextDecoder();
  let body = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      const chunk = done ? errorDecoder.decode() : errorDecoder.decode(value, { stream: true });
      if (chunk) {
        const remainingChars = maxChars - body.length;
        if (remainingChars <= 0) {
          await reader.cancel("Provider error response body exceeded maximum size.").catch(() => {});
          return appendTruncationNotice(body, chunk.length);
        }

        if (chunk.length > remainingChars) {
          await reader.cancel("Provider error response body exceeded maximum size.").catch(() => {});
          return appendTruncationNotice(body + chunk.slice(0, remainingChars), chunk.length - remainingChars);
        }

        body += chunk;
      }

      if (done) {
        return body;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

export async function* streamSSE(
  response: Response,
  options: StreamSSEOptions = {}
): AsyncGenerator<{ event?: string; data: string }, void, undefined> {
  const maxEventChars = normalizePositiveLimit(options.maxEventChars, DEFAULT_SSE_MAX_EVENT_CHARS);
  const maxBufferChars = normalizePositiveLimit(options.maxBufferChars, maxEventChars);
  const maxErrorBodyChars = normalizePositiveLimit(options.maxErrorBodyChars, DEFAULT_SSE_ERROR_BODY_MAX_CHARS);

  if (!response.ok) {
    const body = await readBoundedResponseText(response, maxErrorBodyChars);
    throw new ProviderHTTPError(`Streaming request failed with status ${response.status}.`, response.status, {
      responseBody: body,
      responseBodyMaxChars: maxErrorBodyChars
    });
  }

  if (!response.body) {
    throw new ParseError("Streaming response did not include a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let event: string | undefined;
  let dataLines: string[] = [];
  let eventChars = 0;
  let skipLF = false;
  let readDone = false;
  let cancelled = false;

  const cancelForLimit = async (message: string): Promise<never> => {
    cancelled = true;
    await reader.cancel(message).catch(() => {});
    throw new ParseError(message);
  };

  // WHATWG SSE is line-oriented: CR, LF and CRLF are all line endings.
  // A CRLF pair may straddle reads; EOF never dispatches a pending event.
  const processLine = () => {
    if (line === "") {
      const parsed = dataLines.length ? { event, data: dataLines.join("\n") } : undefined;
      event = undefined;
      dataLines = [];
      eventChars = 0;
      return parsed;
    }
    eventChars += line.length + 1;
    if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }
    return undefined;
  };

  try {
    while (!readDone) {
      const { done, value } = await reader.read();
      readDone = done;
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (const character of chunk) {
        if (skipLF) {
          skipLF = false;
          if (character === "\n") continue;
        }
        if (character === "\r" || character === "\n") {
          skipLF = character === "\r";
          const parsed = processLine();
          line = "";
          if (parsed) yield parsed;
        } else {
          line += character;
        }
        if (eventChars + line.length > maxEventChars) {
          await cancelForLimit(`SSE event exceeded ${maxEventChars} characters.`);
        }
        if (eventChars + line.length > maxBufferChars) {
          await cancelForLimit(`SSE buffer exceeded ${maxBufferChars} characters before an event separator.`);
        }
      }
    }
  } finally {
    // A provider can stop on [DONE], reject JSON, or a caller can cancel early.
    // Releasing the lock alone leaves the HTTP body and its producer running.
    if (!readDone && !cancelled) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const normalizeSSEData = (value: unknown) => {
  const payload = typeof value === "string" ? value : JSON.stringify(value);
  return payload
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
};

// A cancelled consumer must not wait for an uncooperative pending next().
// The explicit hook lets sources abort pending I/O before iterator cleanup.
const iterableReadableStream = <T>(
  source: AsyncIterable<T>,
  encode: (value: T) => Uint8Array,
  onCancel?: (reason: unknown) => void | Promise<void>
): ReadableStream<Uint8Array> => {
  const iterator = source[Symbol.asyncIterator]();
  let stopped = false;
  const cleanup = (reason: unknown) => {
    if (stopped) return;
    stopped = true;
    try { void Promise.resolve(onCancel?.(reason)).catch(() => {}); } catch { /* Continue iterator cleanup. */ }
    try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Preserve the original failure. */ }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await iterator.next();
        if (stopped) return;
        if (item.done) {
          stopped = true;
          controller.close();
        } else {
          controller.enqueue(encode(item.value));
        }
      } catch (error) {
        if (!stopped) {
          cleanup(error);
          controller.error(error);
        }
      }
    },
    cancel: cleanup
  });
};

export const toSSEStream = <TValue>(
  source: AsyncIterable<TValue>,
  options: {
    event?: string | ((value: TValue) => string | undefined);
    /** Abort source I/O when the HTTP consumer cancels or encoding fails. */
    onCancel?: (reason: unknown) => void | Promise<void>;
  } = {}
): ReadableStream<Uint8Array> => iterableReadableStream(source, value => {
  const eventName = typeof options.event === "function" ? options.event(value) : options.event;
  const eventLine = eventName ? `event: ${eventName}\n` : "";
  return encoder.encode(`${eventLine}${normalizeSSEData(value)}\n\n`);
}, options.onCancel);

export const toSSEResponse = <TValue>(
  source: AsyncIterable<TValue>,
  options: ResponseInit & {
    event?: string | ((value: TValue) => string | undefined);
    onCancel?: (reason: unknown) => void | Promise<void>;
  } = {}
): Response => {
  const { event, onCancel, headers, ...init } = options;
  return new Response(toSSEStream(source, { event, onCancel }), {
    ...init,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...Object.fromEntries(new Headers(headers).entries())
    }
  });
};

export const toTextReadableStream = (result: StreamTextResult): ReadableStream<Uint8Array> =>
  iterableReadableStream(result.textStream, chunk => encoder.encode(chunk), reason => result.cancel?.(reason));

export const toTextStreamResponse = (result: StreamTextResult, init: ResponseInit = {}): Response =>
  new Response(toTextReadableStream(result), {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...Object.fromEntries(new Headers(init.headers).entries())
    }
  });

export const toUIMessageStreamResponse = (
  source: StreamTextResult | AgentStreamResult | AsyncIterable<UIMessageChunk>,
  init: ResponseInit & { messageId?: string; onCancel?: (reason: unknown) => void | Promise<void> } = {}
): Response => {
  const { messageId, onCancel, headers, ...rest } = init;
  const uiStream =
    "eventStream" in source ? toUIMessageStream(source, messageId) : source;

  return toSSEResponse(uiStream, {
    ...rest,
    headers,
    onCancel: reason => Promise.allSettled([
      Promise.resolve().then(() => {
        if ("cancel" in source && typeof source.cancel === "function") return source.cancel(reason);
      }),
      Promise.resolve().then(() => onCancel?.(reason))
    ]).then(() => undefined),
    event: (chunk) => chunk.type
  });
};

export const toUIAgentStreamResponse = (
  source: AgentStreamResult | AsyncIterable<UIMessageChunk>,
  init: ResponseInit & { messageId?: string; onCancel?: (reason: unknown) => void | Promise<void> } = {}
): Response => toUIMessageStreamResponse(source, init);

export const toUIRunnerStreamResponse = (
  source: RunnerStreamResult,
  init: ResponseInit & { messageId?: string; onCancel?: (reason: unknown) => void | Promise<void> } = {}
): Response => {
  const { messageId, ...responseInit } = init;
  const uiStream = (async function* (): AsyncGenerator<UIMessageChunk> {
    let hasStreamError = false;
    let streamError: unknown;
    try {
      for await (const chunk of toUIMessageStream(source.eventStream, {
        messageId,
        includeAgentRunFinish: false
      })) {
        yield chunk;
      }
    } catch (error) {
      hasStreamError = true;
      streamError = error;
    }

    const result = await source.collect();
    if (hasStreamError) {
      throw streamError;
    }

    yield {
      type: "session-finish",
      sessionId: result.session.sessionId,
      status: result.output.status
    };
  })();

  return toUIMessageStreamResponse(uiStream, responseInit);
};
