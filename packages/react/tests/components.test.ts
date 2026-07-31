import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  Message,
  MessageList,
  ZhivexChat,
  type ChatController,
  type MessageListProps,
  type MessagePartRendererProps
} from "../src/components.js";
import type { ChatMessage } from "../src/types.js";

const message: ChatMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [
    { type: "text", text: "Hello" },
    {
      type: "tool-call",
      toolCall: {
        id: "call-1",
        name: "weather",
        input: { city: "Madrid" }
      }
    }
  ],
  createdAt: 1,
  status: "complete"
};

describe("@zhivex-ai/react components", () => {
  it("renders the complete accessible chat shell on the server", () => {
    const controller: ChatController = {
      state: {
        messages: [message],
        status: "ready",
        pendingApprovals: [],
        activity: []
      },
      input: "",
      setInput: vi.fn(),
      send: vi.fn(async () => undefined),
      stop: vi.fn(),
      reload: vi.fn(async () => undefined),
      resolveApproval: vi.fn(async () => undefined)
    };

    const html = renderToStaticMarkup(
      createElement(ZhivexChat, {
        controller,
        header: createElement("strong", null, "Support")
      })
    );

    expect(html).toContain('aria-label="AI chat"');
    expect(html).toContain('role="log"');
    expect(html).toContain("Support");
    expect(html).toContain("Hello");
    expect(html).toContain("weather");
    expect(html).toContain('aria-label="Message"');
  });

  it("supports custom content-part renderers", () => {
    const CustomText = ({
      part
    }: MessagePartRendererProps<{ type: "text"; text: string }>) =>
      createElement("mark", null, part.text.toUpperCase());

    const html = renderToStaticMarkup(
      createElement(Message, {
        message,
        renderers: {
          text: CustomText
        }
      })
    );

    expect(html).toContain("<mark>HELLO</mark>");
    expect(html).not.toContain('class="zhivex-message__text">Hello');
  });

  it("passes provider and id together for the default approval handler", async () => {
    const approval = {
      provider: "provider-b",
      id: "shared-id",
      name: "write-file",
      arguments: "{}",
      rawData: {}
    };
    const resolveApproval = vi.fn(async () => undefined);
    const controller: ChatController = {
      state: {
        messages: [],
        status: "ready",
        pendingApprovals: [approval],
        activity: []
      },
      input: "",
      setInput: vi.fn(),
      send: vi.fn(async () => undefined),
      stop: vi.fn(),
      reload: vi.fn(async () => undefined),
      resolveApproval
    };

    const tree = ZhivexChat({ controller });
    expect(isValidElement(tree)).toBe(true);
    const messageList = Children.toArray(
      (tree as { props: { children: unknown } }).props.children
    ).find(
      (child) => isValidElement(child) && child.type === MessageList
    );
    expect(isValidElement(messageList)).toBe(true);
    const onApproval = (
      messageList as { props: MessageListProps }
    ).props.onApproval;
    await onApproval?.(approval, true);

    expect(resolveApproval).toHaveBeenCalledWith(
      "shared-id",
      true,
      undefined,
      "provider-b"
    );
  });

  it("requires remote-media opt in, blocks private hosts, and applies no-referrer", () => {
    const mediaMessage: ChatMessage = {
      id: "assistant-media",
      role: "assistant",
      createdAt: 1,
      status: "complete",
      parts: [
        {
          type: "image",
          image: "https://cdn.example.com/image.png",
          mediaType: "image/png"
        },
        {
          type: "image",
          image: "http://127.0.0.1:8080/private.png",
          mediaType: "image/png"
        },
        {
          type: "image",
          image: "https://user:secret@cdn.example.com/credentialed.png",
          mediaType: "image/png"
        }
      ]
    };

    const html = renderToStaticMarkup(
      createElement(Message, { message: mediaMessage })
    );
    expect(html).not.toContain("cdn.example.com");
    expect(html).not.toContain("127.0.0.1");

    const publicOptIn = renderToStaticMarkup(
      createElement(Message, {
        message: mediaMessage,
        mediaUrlPolicy: { allowRemote: true }
      })
    );
    expect(publicOptIn).toContain(
      'src="https://cdn.example.com/image.png"'
    );
    expect(publicOptIn).toContain('referrerPolicy="no-referrer"');
    expect(publicOptIn).not.toContain("127.0.0.1");
    expect(publicOptIn).not.toContain("credentialed.png");

    const privateOptIn = renderToStaticMarkup(
      createElement(Message, {
        message: mediaMessage,
        mediaUrlPolicy: {
          allowRemote: true,
          allowPrivateNetwork: true
        }
      })
    );
    expect(privateOptIn).toContain(
      'src="http://127.0.0.1:8080/private.png"'
    );
    expect(privateOptIn).not.toContain("credentialed.png");
  });
});
