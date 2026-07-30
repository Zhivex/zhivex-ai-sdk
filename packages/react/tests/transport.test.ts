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
});
