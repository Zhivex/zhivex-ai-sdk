import { ParseError, ProviderHTTPError } from "./errors.js";
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

  let buffer = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const cancelForLimit = async (message: string): Promise<never> => {
    await reader.cancel(message).catch(() => {});
    throw new ParseError(message);
  };

  const parseEvent = (rawEvent: string) => {
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    const data = dataLines.join("\n");
    return data.length ? { event, data } : undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      while (true) {
        const separatorMatch = buffer.match(/\r?\n\r?\n/);
        if (!separatorMatch) {
          if (buffer.length > maxBufferChars) {
            await cancelForLimit(`SSE buffer exceeded ${maxBufferChars} characters before an event separator.`);
          }
          break;
        }

        const separatorIndex = separatorMatch.index ?? 0;
        if (separatorIndex > maxEventChars) {
          await cancelForLimit(`SSE event exceeded ${maxEventChars} characters.`);
        }

        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + separatorMatch[0].length);
        const parsed = parseEvent(rawEvent);
        if (parsed) {
          yield parsed;
        }
      }

      if (done) {
        if (buffer.length > maxEventChars) {
          await cancelForLimit(`SSE event exceeded ${maxEventChars} characters.`);
        }

        const parsed = parseEvent(buffer);
        if (parsed) {
          yield parsed;
        }
        break;
      }
    }
  } finally {
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

export const toSSEStream = <TValue>(
  source: AsyncIterable<TValue>,
  options: {
    event?: string | ((value: TValue) => string | undefined);
  } = {}
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const value of source) {
          const eventName = typeof options.event === "function" ? options.event(value) : options.event;
          const eventLine = eventName ? `event: ${eventName}\n` : "";
          controller.enqueue(encoder.encode(`${eventLine}${normalizeSSEData(value)}\n\n`));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });

export const toSSEResponse = <TValue>(
  source: AsyncIterable<TValue>,
  options: ResponseInit & {
    event?: string | ((value: TValue) => string | undefined);
  } = {}
): Response => {
  const { event, headers, ...init } = options;
  return new Response(toSSEStream(source, { event }), {
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
  new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of result.textStream) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });

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
  init: ResponseInit & { messageId?: string } = {}
): Response => {
  const { messageId, headers, ...rest } = init;
  const uiStream =
    "eventStream" in source ? toUIMessageStream(source, messageId) : source;

  return toSSEResponse(uiStream, {
    ...rest,
    headers,
    event: (chunk) => chunk.type
  });
};

export const toUIAgentStreamResponse = (
  source: AgentStreamResult | AsyncIterable<UIMessageChunk>,
  init: ResponseInit & { messageId?: string } = {}
): Response => toUIMessageStreamResponse(source, init);
