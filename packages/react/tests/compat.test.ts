import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/ai-sdk-ui-v7/zhivex-stream.json";
import {
  AISDKUICompatibilityError,
  createAISDKUIChatTransport,
  decodeZhivexApprovalId,
  encodeZhivexApprovalId,
  fromAISDKUIMessage,
  parseAISDKUIMessageRequest,
  toAISDKUIMessage,
  toAISDKUIMessageStream,
  toAISDKUIMessageStreamResponse
} from "../src/compat.js";
import type { ChatStreamChunk } from "../src/types.js";

const encoder = new TextEncoder();

const chunksFrom = async function* <T>(values: readonly T[]): AsyncGenerator<T> {
  yield* values;
};

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
};

const nativeSSE = (chunks: readonly ChatStreamChunk[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.close();
      }
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

describe("AI SDK UI v7 compatibility", () => {
  it("keeps the pinned golden stream fixture compatible", async () => {
    expect(fixture.supportedVersions).toEqual({
      ai: "7.0.79",
      "@ai-sdk/react": "4.0.82"
    });
    await expect(
      collect(
        toAISDKUIMessageStream(
          chunksFrom(fixture.zhivexChunks as ChatStreamChunk[])
        )
      )
    ).resolves.toEqual(fixture.expectedAIChunks);
  });

  it("round-trips text, files, reasoning, tools, outputs, and metadata", () => {
    const source: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      metadata: { trace: "public-trace" },
      parts: [
        { type: "reasoning", text: "Reason safely", state: "done" },
        {
          type: "dynamic-tool",
          toolName: "get_weather",
          toolCallId: "call-1",
          state: "output-available",
          input: { city: "Buenos Aires" },
          output: { temperatureC: 22 }
        },
        {
          type: "file",
          url: "https://cdn.example.com/report.pdf",
          mediaType: "application/pdf",
          filename: "report.pdf"
        },
        { type: "text", text: "Done", state: "done" }
      ]
    };

    const zhivex = fromAISDKUIMessage(source);
    const restored = toAISDKUIMessage(zhivex, source.id);

    expect(restored).toMatchObject({
      id: source.id,
      role: "assistant",
      metadata: { trace: "public-trace" },
      parts: [
        { type: "reasoning", text: "Reason safely" },
        {
          type: "dynamic-tool",
          toolName: "get_weather",
          toolCallId: "call-1",
          state: "output-available",
          input: { city: "Buenos Aires" },
          output: { temperatureC: 22 }
        },
        {
          type: "file",
          url: "https://cdn.example.com/report.pdf",
          mediaType: "application/pdf",
          filename: "report.pdf"
        },
        { type: "text", text: "Done" }
      ]
    });
  });

  it("preserves unknown parts explicitly or rejects them fail closed", () => {
    const message = {
      id: "assistant-unknown",
      role: "assistant",
      parts: [{ type: "source-url", sourceId: "source-1", url: "https://example.com" }]
    } satisfies UIMessage;

    expect(fromAISDKUIMessage(message).parts).toEqual([
      {
        type: "provider-data",
        provider: "ai-sdk",
        data: {
          type: "ui-part",
          part: { type: "source-url", sourceId: "source-1", url: "https://example.com" }
        }
      }
    ]);
    expect(() => fromAISDKUIMessage(message, { unsupportedParts: "error" }))
      .toThrowError(AISDKUICompatibilityError);
  });

  it("exposes only safe stream errors by default and degrades unknown events without payloads", async () => {
    const chunks = await collect(toAISDKUIMessageStream(chunksFrom([
      { type: "future-event", secret: "provider-key" },
      {
        type: "error",
        messageId: "assistant-error",
        error: { message: "stack trace and provider-key" }
      }
    ] as ChatStreamChunk[])));

    expect(chunks).toContainEqual({
      type: "data-zhivex-event",
      data: { sourceType: "future-event", degraded: true }
    });
    expect(chunks).toContainEqual({ type: "error", errorText: "Chat request failed." });
    expect(JSON.stringify(chunks)).not.toContain("provider-key");
    expect(JSON.stringify(chunks)).not.toContain("stack trace");
  });

  it("emits the AI SDK v1 SSE protocol and can be reduced by readUIMessageStream", async () => {
    const response = toAISDKUIMessageStreamResponse(chunksFrom([
      {
        type: "text-delta",
        messageId: "assistant-response",
        role: "assistant",
        textDelta: "Hello"
      },
      { type: "finish", messageId: "assistant-response", finishReason: "stop" }
    ] satisfies ChatStreamChunk[]));

    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    expect(text).toContain('data: {"type":"text-start"');
    expect(text).toContain("data: [DONE]");

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start", messageId: "assistant-response" });
        controller.enqueue({ type: "text-start", id: "text-1" });
        controller.enqueue({ type: "text-delta", id: "text-1", delta: "Hello" });
        controller.enqueue({ type: "text-end", id: "text-1" });
        controller.enqueue({ type: "finish", finishReason: "stop" });
        controller.close();
      }
    });
    const states = await Array.fromAsync(readUIMessageStream({ stream }));
    expect(states.at(-1)).toMatchObject({
      id: "assistant-response",
      role: "assistant",
      parts: [{ type: "text", text: "Hello", state: "done" }]
    });
  });

  it("round-trips fragmented inputs and multiple tools after the AI SDK reducer assembles them", async () => {
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start", messageId: "assistant-tools" });
        controller.enqueue({
          type: "tool-input-start",
          toolCallId: "call-1",
          toolName: "weather",
          dynamic: true
        });
        controller.enqueue({ type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: '{"city":' });
        controller.enqueue({ type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: '"Buenos Aires"}' });
        controller.enqueue({
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "weather",
          input: { city: "Buenos Aires" },
          dynamic: true
        });
        controller.enqueue({
          type: "tool-output-available",
          toolCallId: "call-1",
          output: { temperatureC: 22 },
          dynamic: true
        });
        controller.enqueue({
          type: "tool-input-available",
          toolCallId: "call-2",
          toolName: "clock",
          input: { zone: "America/Argentina/Buenos_Aires" },
          dynamic: true
        });
        controller.enqueue({
          type: "tool-output-error",
          toolCallId: "call-2",
          errorText: "Clock unavailable",
          dynamic: true
        });
        controller.enqueue({ type: "finish", finishReason: "tool-calls" });
        controller.close();
      }
    });

    const messages = await Array.fromAsync(readUIMessageStream({ stream }));
    const converted = fromAISDKUIMessage(messages.at(-1)!);
    expect(converted.parts).toEqual([
      {
        type: "tool-call",
        toolCall: { id: "call-1", name: "weather", input: { city: "Buenos Aires" } }
      },
      {
        type: "tool-result",
        toolResult: {
          toolCallId: "call-1",
          toolName: "weather",
          output: { temperatureC: 22 },
          isError: false
        }
      },
      {
        type: "tool-call",
        toolCall: {
          id: "call-2",
          name: "clock",
          input: { zone: "America/Argentina/Buenos_Aires" }
        }
      },
      {
        type: "tool-result",
        toolResult: {
          toolCallId: "call-2",
          toolName: "clock",
          error: { message: "Clock unavailable" },
          isError: true
        }
      }
    ]);
  });

  it("bounds and validates default useChat request bodies", async () => {
    const body = {
      id: "chat-1",
      trigger: "submit-message",
      messages: [
        { id: "user-1", role: "user", parts: [{ type: "text", text: "Hello" }] }
      ]
    };
    const parsed = await parseAISDKUIMessageRequest(new Request("https://example.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));
    expect(parsed).toMatchObject({
      chatId: "chat-1",
      trigger: "submit-message",
      modelMessages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }]
    });

    await expect(parseAISDKUIMessageRequest(new Request("https://example.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }), { maxBytes: 10 })).rejects.toMatchObject({ code: "request_too_large" });
  });

  it("uses the bounded native transport, rejects redirects, and maps approval identity", async () => {
    const approvalId = encodeZhivexApprovalId("openai", "approval-1");
    expect(decodeZhivexApprovalId(approvalId)).toEqual({
      provider: "openai",
      approvalRequestId: "approval-1"
    });

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({
        message: {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }]
        },
        sessionId: "chat-1"
      });
      return nativeSSE([
        {
          type: "text-delta",
          messageId: "assistant-1",
          role: "assistant",
          textDelta: "Hi"
        },
        { type: "finish", messageId: "assistant-1", finishReason: "stop" }
      ]);
    });
    const transport = createAISDKUIChatTransport({ fetch: fetchMock });
    const stream = await transport.sendMessages({
      chatId: "chat-1",
      trigger: "submit-message",
      messageId: undefined,
      messages: [
        { id: "user-1", role: "user", parts: [{ type: "text", text: "Hello" }] }
      ],
      abortSignal: new AbortController().signal
    });
    const values: UIMessageChunk[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      values.push(value);
    }
    expect(values).toContainEqual({ type: "text-delta", id: "assistant-1:text:1", delta: "Hi" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects non-idempotent regeneration by default", async () => {
    const transport = createAISDKUIChatTransport();
    await expect(transport.sendMessages({
      chatId: "chat-regenerate",
      trigger: "regenerate-message",
      messageId: "assistant-old",
      messages: [{ id: "user-old", role: "user", parts: [{ type: "text", text: "Again" }] }],
      abortSignal: new AbortController().signal
    })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("propagates client abort to the native fetch signal", async () => {
    let fetchSignal: AbortSignal | null = null;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            fetchSignal?.addEventListener("abort", () => {
              controller.error(fetchSignal?.reason);
            }, { once: true });
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    });
    const controller = new AbortController();
    const transport = createAISDKUIChatTransport({ fetch: fetchMock });
    const stream = await transport.sendMessages({
      chatId: "chat-abort",
      trigger: "submit-message",
      messageId: undefined,
      messages: [{ id: "user-abort", role: "user", parts: [{ type: "text", text: "Stop" }] }],
      abortSignal: controller.signal
    });
    const reader = stream.getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new DOMException("Stopped", "AbortError"));
    await pending.catch(() => undefined);
    expect(fetchSignal?.aborted).toBe(true);
    await reader.cancel().catch(() => undefined);
  });

  it("turns idle timeouts into a safe AI SDK stream error", async () => {
    const transport = createAISDKUIChatTransport({
      streamIdleTimeoutMs: 5,
      requestTimeoutMs: 100,
      fetch: async () => new Response(
        new ReadableStream<Uint8Array>({ start() {} }),
        { headers: { "content-type": "text/event-stream" } }
      )
    });
    const stream = await transport.sendMessages({
      chatId: "chat-idle",
      trigger: "submit-message",
      messageId: undefined,
      messages: [{ id: "user-idle", role: "user", parts: [{ type: "text", text: "Wait" }] }],
      abortSignal: new AbortController().signal
    });
    const values: UIMessageChunk[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      values.push(value);
    }
    expect(values).toContainEqual({ type: "error", errorText: "Chat request failed." });
    expect(JSON.stringify(values)).not.toContain("idle for more than");
  });
});
