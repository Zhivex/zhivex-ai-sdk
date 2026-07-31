import { describe, expect, it, vi } from "vitest";
import {
  ChatStreamParseError,
  ChatTransportError,
  createFetchChatTransport,
  parseChatEventStream,
  prepareChatRequestBody
} from "../src/transport.js";
import type {
  ChatMessage,
  ChatStreamChunk,
  ChatTransportRequest
} from "../src/types.js";

const encoder = new TextEncoder();

const streamFrom = (chunks: readonly string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });

const collect = async (
  iterable: AsyncIterable<ChatStreamChunk>
): Promise<ChatStreamChunk[]> => {
  const values: ChatStreamChunk[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
};

const messages: ChatMessage[] = [
  {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Old answer" }],
    createdAt: 1,
    status: "complete"
  },
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "New question" }],
    createdAt: 2,
    status: "pending"
  }
];

const request = (
  overrides: Partial<ChatTransportRequest> = {}
): ChatTransportRequest => ({
  message: messages[1],
  messages,
  sessionId: "session-1",
  signal: new AbortController().signal,
  ...overrides
});

describe("chat SSE transport", () => {
  it("parses fragmented CRLF and multiline SSE events", async () => {
    const stream = streamFrom([
      "event: text-delta\r",
      '\ndata: {"messageId":"assistant-2",\r\n',
      'data: "role":"assistant",\r\n',
      'data: "textDelta":"Hello"}\r\n\r',
      "\n"
    ]);

    await expect(collect(parseChatEventStream(stream))).resolves.toEqual([
      {
        type: "text-delta",
        messageId: "assistant-2",
        role: "assistant",
        textDelta: "Hello"
      }
    ]);
  });

  it("ignores comments and the done sentinel", async () => {
    const stream = streamFrom([
      ": keepalive\n\n",
      'data: {"type":"finish","messageId":"assistant-1"}\n\n',
      "data: [DONE]\n\n"
    ]);

    await expect(collect(parseChatEventStream(stream))).resolves.toEqual([
      { type: "finish", messageId: "assistant-1" }
    ]);
  });

  it("reports invalid JSON with event context", async () => {
    const stream = streamFrom(["event: text-delta\ndata: nope\n\n"]);

    await expect(collect(parseChatEventStream(stream))).rejects.toBeInstanceOf(
      ChatStreamParseError
    );
  });

  it("cancels the underlying stream after a parse failure", async () => {
    let cancelled = false;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode("data: nope\n\n"));
        }
      },
      cancel() {
        cancelled = true;
      }
    });

    await expect(collect(parseChatEventStream(stream))).rejects.toBeInstanceOf(
      ChatStreamParseError
    );
    expect(cancelled).toBe(true);
  });

  it("bounds unterminated lines and complete event payloads", async () => {
    await expect(
      collect(
        parseChatEventStream(streamFrom(["123456789"]), {
          maxBufferChars: 8
        })
      )
    ).rejects.toThrow("buffer limit");

    await expect(
      collect(
        parseChatEventStream(streamFrom(["data: 123456789\n\n"]), {
          maxEventChars: 8
        })
      )
    ).rejects.toThrow("event exceeded");

    await expect(
      collect(
        parseChatEventStream(
          streamFrom([
            'data: {"type":"finish"}\n\n',
            'data: {"type":"finish"}\n\n'
          ]),
          { maxStreamEvents: 1 }
        )
      )
    ).rejects.toThrow("event response limit");

    await expect(
      collect(
        parseChatEventStream(
          streamFrom(['data: {"type":"finish"}\n\n']),
          { maxStreamChars: 8 }
        )
      )
    ).rejects.toThrow("character response limit");
  });

  it("sends only the latest message by default", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        message: {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "New question" }]
        },
        sessionId: "session-1"
      });
      expect(body).not.toHaveProperty("messages");
      expect(init?.redirect).toBe("error");
      return new Response(
        'event: finish\ndata: {"type":"finish","messageId":"assistant-2"}\n\n',
        {
          headers: { "content-type": "text/event-stream" }
        }
      );
    });
    const transport = createFetchChatTransport({ fetch: fetchMock });

    await expect(collect(transport.send(request()))).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("omits the message when resuming an approval", () => {
    expect(
      prepareChatRequestBody(
        request({
          approvals: [
            {
              provider: "test",
              approvalRequestId: "approval-1",
              approve: true
            }
          ]
        })
      )
    ).toEqual({
      message: undefined,
      sessionId: "session-1",
      approvals: [
        {
          provider: "test",
          approvalRequestId: "approval-1",
          approve: true
        }
      ],
      metadata: undefined
    });
  });

  it("includes the bounded response body in HTTP errors", async () => {
    const transport = createFetchChatTransport({
      fetch: async () => new Response("bad request", { status: 400 })
    });

    await expect(collect(transport.send(request()))).rejects.toMatchObject({
      name: "ChatTransportError",
      status: 400,
      responseBody: "bad request"
    } satisfies Partial<ChatTransportError>);
  });

  it("reads HTTP diagnostics incrementally and cancels at the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("1234567890".repeat(100)));
      },
      cancel() {
        cancelled = true;
      }
    });
    const transport = createFetchChatTransport({
      fetch: async () => new Response(body, { status: 500 }),
      maxErrorBodyBytes: 8
    });

    await expect(collect(transport.send(request()))).rejects.toMatchObject({
      responseBody: "12345678\n...[truncated]"
    });
    expect(cancelled).toBe(true);
  });

  it("rejects successful responses with the wrong content type", async () => {
    const transport = createFetchChatTransport({
      fetch: async () =>
        Response.json({ error: "not a stream" }, { status: 200 })
    });

    await expect(collect(transport.send(request()))).rejects.toMatchObject({
      name: "ChatTransportError",
      status: 200,
      responseBody: '{"error":"not a stream"}'
    } satisfies Partial<ChatTransportError>);
  });

  it("aborts requests that exceed the total timeout", async () => {
    const transport = createFetchChatTransport({
      requestTimeoutMs: 10,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectWithAbort = () =>
            reject(
              signal?.reason ?? new DOMException("Aborted", "AbortError")
            );
          if (signal?.aborted) {
            rejectWithAbort();
          } else {
            signal?.addEventListener("abort", rejectWithAbort, { once: true });
          }
        })
    });

    await expect(collect(transport.send(request()))).rejects.toThrow(
      "total timeout"
    );
  });

  it("cancels streams that exceed the idle timeout", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"text-delta","messageId":"assistant-1","role":"assistant","textDelta":"hi"}\n\n'
          )
        );
      },
      cancel() {
        cancelled = true;
      }
    });
    const transport = createFetchChatTransport({
      requestTimeoutMs: false,
      streamIdleTimeoutMs: 10,
      fetch: async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" }
        })
    });

    await expect(collect(transport.send(request()))).rejects.toThrow("idle");
    expect(cancelled).toBe(true);
  });
});
