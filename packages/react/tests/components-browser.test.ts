// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApprovalCard,
  MessageList,
  ZhivexChat,
  type ChatController
} from "../src/components.js";
import type { ChatMessage } from "../src/types.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const containers: HTMLElement[] = [];

const message = (id: string, text: string): ChatMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
  createdAt: Number(id.replace(/\D/g, "")) || 1,
  status: "complete"
});

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  document.body.replaceChildren();
});

describe("@zhivex-ai/react browser components", () => {
  it("passes provider and id through the default approval handler", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
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

    await act(async () => {
      root.render(createElement(ZhivexChat, { controller }));
    });
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve"
    );
    await act(async () => {
      approve?.click();
      await Promise.resolve();
    });

    expect(resolveApproval).toHaveBeenCalledWith(
      "shared-id",
      true,
      undefined,
      "provider-b"
    );
    await act(async () => root.unmount());
  });

  it("announces only a newly completed assistant response", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const render = async (
      messages: readonly ChatMessage[],
      status: "ready" | "streaming" | "error"
    ) => {
      await act(async () => {
        root.render(createElement(MessageList, { messages, status }));
      });
    };
    const historical = message("assistant-1", "Historical");
    const liveRegion = () =>
      container.querySelector<HTMLElement>(".zhivex-sr-only");

    await render([historical], "ready");
    expect(liveRegion()?.textContent).toBe("");

    await render(
      [
        historical,
        {
          ...message("assistant-2", "Failed response"),
          status: "streaming"
        }
      ],
      "streaming"
    );
    await render(
      [
        historical,
        {
          ...message("assistant-2", "Failed response"),
          status: "error"
        }
      ],
      "error"
    );
    expect(liveRegion()?.textContent).toBe("");

    await render(
      [
        historical,
        {
          ...message("assistant-3", "Fresh response"),
          status: "streaming"
        }
      ],
      "streaming"
    );
    await render(
      [historical, message("assistant-3", "Fresh response")],
      "ready"
    );

    expect(liveRegion()?.textContent).toBe(
      "Assistant response: Fresh response"
    );

    const firstRepeatedAnnouncement =
      liveRegion()?.querySelector("span") ?? null;
    await render(
      [
        historical,
        message("assistant-3", "Fresh response"),
        {
          ...message("assistant-4", "Fresh response"),
          status: "streaming"
        }
      ],
      "streaming"
    );
    await render(
      [
        historical,
        message("assistant-3", "Fresh response"),
        message("assistant-4", "Fresh response")
      ],
      "ready"
    );

    expect(liveRegion()?.textContent).toBe(
      "Assistant response: Fresh response"
    );
    expect(liveRegion()?.querySelector("span")).not.toBe(
      firstRepeatedAnnouncement
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("follows new messages until the user scrolls away and then offers a jump control", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const render = async (messages: readonly ChatMessage[]) => {
      await act(async () => {
        root.render(
          createElement(MessageList, {
            messages,
            autoFollowThreshold: 50
          })
        );
      });
    };

    await render([message("assistant-1", "One")]);
    const list = container.querySelector<HTMLElement>(".zhivex-message-list");
    if (!list) {
      throw new Error("Message list did not render.");
    }
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 }
    });

    await render([
      message("assistant-1", "One"),
      message("assistant-2", "Two")
    ]);
    expect(list.scrollTop).toBe(1_000);

    await act(async () => {
      list.scrollTop = 500;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await render([
      message("assistant-1", "One"),
      message("assistant-2", "Two"),
      message("assistant-3", "Three")
    ]);

    expect(list.scrollTop).toBe(500);
    const jump = container.querySelector<HTMLButtonElement>(
      ".zhivex-jump-to-latest"
    );
    expect(jump?.textContent).toBe("Jump to latest message");

    await act(async () => {
      jump?.click();
    });
    expect(list.scrollTop).toBe(1_000);

    await act(async () => {
      root.unmount();
    });
  });

  it("surfaces approval callback failures and reports them to the caller", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const onDecisionError = vi.fn();

    await act(async () => {
      root.render(
        createElement(ApprovalCard, {
          approval: {
            provider: "test",
            id: "approval-1",
            name: "delete-record",
            arguments: "{}",
            rawData: {}
          },
          onDecision: async () => {
            throw new Error("network failed");
          },
          onDecisionError
        })
      );
    });
    const buttons = [...container.querySelectorAll("button")];
    const approve = buttons.find((button) => button.textContent === "Approve");

    await act(async () => {
      approve?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be submitted"
    );
    expect(onDecisionError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "network failed" }),
      expect.objectContaining({ id: "approval-1" }),
      true
    );

    await act(async () => {
      root.unmount();
    });
  });
});
