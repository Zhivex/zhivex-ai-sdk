import { ParseError, ProviderHTTPError } from "./errors.js";
import type { StreamTextResult, UIMessageChunk } from "./types.js";
import { toUIMessageStream } from "./ui.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export async function* streamSSE(
  response: Response
): AsyncGenerator<{ event?: string; data: string }, void, undefined> {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Streaming request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  if (!response.body) {
    throw new ParseError("Streaming response did not include a body.");
  }

  let buffer = "";
  const reader = response.body.getReader();

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

  while (true) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

    while (true) {
      const separatorMatch = buffer.match(/\r?\n\r?\n/);
      if (!separatorMatch) {
        break;
      }

      const separatorIndex = separatorMatch.index ?? 0;
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + separatorMatch[0].length);
      const parsed = parseEvent(rawEvent);
      if (parsed) {
        yield parsed;
      }
    }

    if (done) {
      const parsed = parseEvent(buffer);
      if (parsed) {
        yield parsed;
      }
      break;
    }
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
  source: StreamTextResult | AsyncIterable<UIMessageChunk>,
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
