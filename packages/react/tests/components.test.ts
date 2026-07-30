import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  Message,
  ZhivexChat,
  type ChatController,
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
});
