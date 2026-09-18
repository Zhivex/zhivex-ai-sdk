// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApprovalCard,
  Composer,
  MessageList,
  ZhivexChat,
  type ChatController
} from "../src/components.js";
import type { ChatMessage, UseZhivexChatResult } from "../src/types.js";
import { useZhivexChat } from "../src/use-zhivex-chat.js";

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
      "Assistant response"
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
      "Assistant response"
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

  it("collects and validates an approval rejection reason", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const onDecision = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        createElement(ApprovalCard, {
          approval: {
            provider: "test",
            id: "approval-reason",
            name: "delete-record",
            arguments: "{}",
            rawData: {}
          },
          onDecision,
          reasonRequired: true
        })
      );
    });

    const reject = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reject"
    );
    await act(async () => reject?.click());
    expect(onDecision).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Add a reason before rejecting this action."
    );

    const reason = container.querySelector("textarea");
    await act(async () => {
      if (!reason) throw new Error("Reason input did not render.");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setter?.call(reason, "The destination is incorrect.");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      reject?.click();
      await Promise.resolve();
    });

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval-reason" }),
      false,
      "The destination is incorrect."
    );
    await act(async () => root.unmount());
  });

  it("adds bounded file attachments and sends them through sendMessage", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const sendMessage = vi.fn(async () => undefined);
    const controller: ChatController = {
      state: {
        messages: [],
        status: "ready",
        pendingApprovals: [],
        activity: []
      },
      input: "",
      setInput: vi.fn(),
      send: vi.fn(async () => undefined),
      sendMessage,
      stop: vi.fn(),
      reload: vi.fn(async () => undefined),
      resolveApproval: vi.fn(async () => undefined)
    };

    await act(async () => {
      root.render(createElement(ZhivexChat, { controller }));
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["hello"], "memo.txt", { type: "text/plain" });
    if (!input) throw new Error("Attachment input did not render.");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file]
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.textContent).toContain("memo.txt");
    const send = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Send"
    );
    expect(send?.disabled).toBe(false);
    await act(async () => {
      send?.click();
      await Promise.resolve();
    });

    expect(sendMessage).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "file",
        filename: "memo.txt",
        mediaType: "text/plain"
      })
    ]);
    await act(async () => root.unmount());
  });

  it.each(["error", "stopped"] as const)("keeps the hook draft and attachments together after %s", async (status) => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const root = createRoot(container);
    let chat!: UseZhivexChatResult;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    function Chat() {
      chat = useZhivexChat({ transport: {
        async *send() {
          await gate;
          throw new Error("offline");
        }
      } });
      return createElement(ZhivexChat, { controller: chat });
    }
    await act(async () => root.render(createElement(Chat)));
    await act(async () => chat.setInput("Please review"));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File(["data"], "review.txt")] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(chat.input).toBe("");
    await act(async () => {
      if (status === "stopped") chat.stop();
      release();
    });
    expect(chat.input).toBe("Please review");
    expect(container.querySelector("textarea")?.value).toBe("Please review");
    expect(container.textContent).toContain("review.txt");
    await act(async () => root.unmount());
  });

  it.each(["error", "stopped"] as const)("retains attachments on %s and clears only submitted files on success", async (status) => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const root = createRoot(container);
    const error = new Error("offline");
    const onSendError = vi.fn();
    let complete!: (result: { status: "completed" }) => void;
    const onSendMessage = vi.fn()
      .mockResolvedValueOnce(status === "error" ? { status, error } : { status })
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await act(async () => root.render(createElement(Composer, {
      value: "draft", onValueChange: vi.fn(), onSend: vi.fn(), onSendMessage, onSendError
    })));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const addFile = async (name: string) => {
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["data"], name)] });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    const submit = () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await addFile("original.txt");
    await act(async () => { submit(); });
    expect(container.textContent).toContain("original.txt");
    expect(onSendError).toHaveBeenCalledTimes(status === "error" ? 1 : 0);
    await act(async () => { submit(); submit(); });
    expect(onSendMessage).toHaveBeenCalledTimes(2);
    await addFile("new.txt");
    await act(async () => complete({ status: "completed" }));
    expect(container.textContent).not.toContain("original.txt");
    expect(container.textContent).toContain("new.txt");
    await act(async () => root.unmount());
  });

  it("fills the composer from a starter prompt and retries only when supported", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const setInput = vi.fn();
    const reload = vi.fn(async () => undefined);
    const controller: ChatController = {
      state: {
        messages: [],
        status: "error",
        error: new Error("internal"),
        pendingApprovals: [],
        activity: []
      },
      input: "",
      setInput,
      send: vi.fn(async () => undefined),
      stop: vi.fn(),
      canReload: true,
      reload,
      resolveApproval: vi.fn(async () => undefined)
    };

    await act(async () => {
      root.render(
        createElement(ZhivexChat, {
          controller,
          starterPrompts: ["Plan a release"]
        })
      );
    });
    const starter = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Plan a release"
    );
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry"
    );
    await act(async () => starter?.click());
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    expect(setInput).toHaveBeenCalledWith("Plan a release");
    expect(reload).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("internal");
    await act(async () => root.unmount());
  });
});
