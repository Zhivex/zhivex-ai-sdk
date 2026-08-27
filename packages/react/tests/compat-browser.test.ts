// @vitest-environment happy-dom

import { useChat, type UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAISDKUIChatTransport } from "../src/compat.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const encoder = new TextEncoder();
const roots: Root[] = [];

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for AI SDK useChat state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const nativeResponse = () => new Response(
  new ReadableStream<Uint8Array>({
    start(controller) {
      const chunks = [
        {
          type: "provider-data",
          messageId: "assistant-browser",
          role: "assistant",
          provider: "deepseek",
          data: { type: "reasoning_content", reasoningContent: "Check first." }
        },
        {
          type: "tool-call",
          messageId: "assistant-browser",
          role: "assistant",
          toolCall: {
            id: "call-browser",
            name: "lookup",
            input: { query: "status" }
          }
        },
        {
          type: "tool-result",
          messageId: "assistant-browser",
          role: "tool",
          toolResult: {
            toolCallId: "call-browser",
            toolName: "lookup",
            output: { status: "ok" },
            isError: false
          }
        },
        {
          type: "text-delta",
          messageId: "assistant-browser",
          role: "assistant",
          textDelta: "Ready"
        },
        { type: "finish", messageId: "assistant-browser", finishReason: "stop" }
      ];
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`)
        );
      }
      controller.close();
    }
  }),
  { headers: { "content-type": "text/event-stream" } }
);

interface HarnessProps {
  onRender: (chat: UseChatHelpers<UIMessage>) => void;
}

const Harness = ({ onRender }: HarnessProps) => {
  const chat = useChat({
    id: "fixture-chat",
    transport: createAISDKUIChatTransport({
      fetch: vi.fn(async () => nativeResponse())
    })
  });
  onRender(chat);
  return null;
};

afterEach(async () => {
  const mounted = roots.splice(0);
  await act(async () => {
    for (const root of mounted) root.unmount();
  });
  document.body.replaceChildren();
});

describe("AI SDK React useChat compatibility", () => {
  it("consumes a Zhivex Runner-style stream without replacing the AI SDK reducer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    let current: UseChatHelpers<UIMessage> | undefined;

    await act(async () => {
      root.render(createElement(Harness, { onRender: (chat) => { current = chat; } }));
    });
    if (!current) throw new Error("useChat did not render.");

    await act(async () => {
      await current!.sendMessage({ text: "Hello" });
    });
    await waitFor(() => current?.status === "ready" && current.messages.length === 2);

    const assistant = current.messages.at(-1);
    expect(assistant).toMatchObject({
      id: "assistant-browser",
      role: "assistant"
    });
    expect(assistant?.parts).toEqual([
      { type: "reasoning", id: "assistant-browser:reasoning:1", text: "Check first.", state: "done" },
      {
        type: "dynamic-tool",
        toolName: "lookup",
        toolCallId: "call-browser",
        state: "output-available",
        input: { query: "status" },
        output: { status: "ok" },
        preliminary: undefined,
        providerExecuted: undefined,
        title: undefined
      },
      { type: "text", text: "Ready", state: "done" }
    ]);
  });
});
