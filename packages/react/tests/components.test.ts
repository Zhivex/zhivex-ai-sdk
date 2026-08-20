import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ActivityPanel,
  ChatRoot,
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
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-relevant="additions"');
    expect(html).not.toContain('aria-relevant="additions text"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).not.toContain("Assistant response: Hello");
    expect(html).toContain("Support");
    expect(html).toContain("Hello");
    expect(html).toContain("weather");
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain('data-slot="message-actions"');
  });

  it("supports explicit themes and density modes", () => {
    const html = renderToStaticMarkup(
      createElement(ChatRoot, {
        density: "compact",
        theme: "dark",
        children: "Chat"
      })
    );

    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-density="compact"');
  });

  it("renders structured run progress instead of only a busy indicator", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityPanel, {
        status: "streaming",
        activity: [
          { type: "run-start", currentStep: 1, maxSteps: 4 },
          { type: "step-start", stepIndex: 2 }
        ]
      })
    );

    expect(html).toContain("Step 2 of 4");
    expect(html).toContain('data-slot="activity-panel"');
    expect(html).toContain('aria-label="Run activity"');
  });

  it("groups matching tool calls and results into one execution card", () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: {
          ...message,
          parts: [
            message.parts[1]!,
            {
              type: "tool-result",
              toolResult: {
                toolCallId: "call-1",
                toolName: "weather",
                output: { temperature: 22 },
                isError: false
              }
            }
          ]
        }
      })
    );

    expect(html.match(/data-slot="tool-execution"/g)).toHaveLength(1);
    expect(html).toContain("Completed");
    expect(html).toContain("temperature");
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
          image: "https://127.0.0.1.nip.io/aliased-private.png",
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
    expect(publicOptIn).not.toContain("cdn.example.com");

    const allowlistedPublicOptIn = renderToStaticMarkup(
      createElement(Message, {
        message: mediaMessage,
        mediaUrlPolicy: {
          allowRemote: true,
          allowUrl: (url) => url.hostname === "cdn.example.com"
        }
      })
    );
    expect(allowlistedPublicOptIn).toContain(
      'src="https://cdn.example.com/image.png"'
    );
    expect(allowlistedPublicOptIn).toContain('referrerPolicy="no-referrer"');
    expect(allowlistedPublicOptIn).not.toContain("127.0.0.1");
    expect(allowlistedPublicOptIn).not.toContain("credentialed.png");

    const privateOptIn = renderToStaticMarkup(
      createElement(Message, {
        message: mediaMessage,
        mediaUrlPolicy: {
          allowRemote: true,
          allowPrivateNetwork: true,
          allowUrl: (url) => url.hostname === "127.0.0.1"
        }
      })
    );
    expect(privateOptIn).toContain(
      'src="http://127.0.0.1:8080/private.png"'
    );
    expect(privateOptIn).not.toContain("credentialed.png");
  });

  it("uses application-provided image alt text and contextual file link labels", () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        getImageAlt: () => "Quarterly revenue chart",
        message: {
          id: "assistant-media-labels",
          role: "assistant",
          createdAt: 1,
          status: "complete",
          parts: [
            {
              type: "image",
              image:
                "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
              mediaType: "image/gif"
            },
            {
              type: "file",
              data: "data:text/plain;base64,aGVsbG8=",
              filename: "memo.txt",
              mediaType: "text/plain"
            }
          ]
        }
      })
    );

    expect(html).toContain('alt="Quarterly revenue chart"');
    expect(html).toContain('aria-label="Open file: memo.txt"');
  });

  it("hides technical errors by default and reveals them only when requested", () => {
    const controller: ChatController = {
      state: {
        messages: [],
        status: "error",
        error: new Error("internal trace id 123"),
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

    const safeHtml = renderToStaticMarkup(
      createElement(ZhivexChat, { controller })
    );
    expect(safeHtml).toContain(
      "Something went wrong while generating the response."
    );
    expect(safeHtml).not.toContain("internal trace id 123");

    const detailedHtml = renderToStaticMarkup(
      createElement(ZhivexChat, { controller, showErrorDetails: true })
    );
    expect(detailedHtml).toContain("internal trace id 123");
  });
});
