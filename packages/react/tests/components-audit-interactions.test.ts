// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, Message, MessageActions, ProviderDataDetails, ToolCallCard, ToolResultCard, ZhivexChat, type ChatController } from "../src/components.js";
import type { ChatMessage } from "../src/types.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const mount = async (element: ReturnType<typeof createElement>) => {
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node); roots.push(root);
  await act(async () => root.render(element));
  return { root, node };
};
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers();
});
const message: ChatMessage = { id: "a", role: "assistant", parts: [{ type: "text", text: "Answer" }], status: "complete", createdAt: 1 };
const button = (node: HTMLElement, text: string) => [...node.querySelectorAll("button")].find(item => item.textContent?.trim() === text)!;

describe("chat UI interaction audit", () => {
  it("copies only message text, handles clipboard failures and clears feedback after its deadline", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn(async () => {}), onCopyError = vi.fn(), onRetry = vi.fn(async () => {});
    const { node, root } = await mount(createElement(MessageActions, { message, onCopy, onCopyError, onRetry }));
    await act(async () => button(node, "Copy").click());
    expect(onCopy).toHaveBeenCalledWith(message, "Answer");
    expect(button(node, "Copied")).toBeDefined();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(button(node, "Copy")).toBeDefined();
    await act(async () => button(node, "Retry").click());
    expect(onRetry).toHaveBeenCalledWith(message);
    onCopy.mockRejectedValueOnce(new Error("clipboard denied"));
    await act(async () => button(node, "Copy").click());
    expect(onCopyError).toHaveBeenCalledWith(expect.objectContaining({ message: "clipboard denied" }), message);
    await act(async () => button(node, "Copy").click());
    await act(async () => root.render(createElement("div")));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders tool/provider content as escaped text and cleans binary audio URLs on replacement", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audio-preview");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const dangerous = '<img src=x onerror="alert(1)">';
    const call = { type: "tool-call" as const, toolCall: { id: "t", name: "lookup", input: { query: dangerous } } };
    const result = { type: "tool-result" as const, toolResult: { toolCallId: "t", toolName: "lookup", output: null, isError: true, error: { message: dangerous } } };
    const { node, root } = await mount(createElement("div", null,
      createElement(ToolCallCard, { part: call }), createElement(ToolResultCard, { part: result }),
      createElement(ProviderDataDetails, { part: { type: "provider-data", provider: "test", data: { unsafe: dangerous } } }),
      createElement(Message, { message: { ...message, parts: [{ type: "audio", mediaType: "audio/pcm", data: new Uint8Array([0, 0]) }, call] }, renderers: { "tool-call": props => createElement(ToolCallCard, { part: props.part }) } })
    ));
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toContain(dangerous);
    expect(node.querySelector("audio")?.getAttribute("src")).toBe("blob:audio-preview");
    expect(createUrl).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement("div")));
    expect(revokeUrl).toHaveBeenCalledWith("blob:audio-preview");
  });

  it("retains a failed pasted attachment for retry and sends it once ready", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ type: "file", data: "https://files.example/a.txt", mediaType: "text/plain" });
    const onAttachmentError = vi.fn(), onSendMessage = vi.fn(async () => ({ status: "completed" as const }));
    const { node } = await mount(createElement(Composer, { value: "", onValueChange: vi.fn(), onSend: vi.fn(), onSendMessage, uploadAttachment: upload, onAttachmentError }));
    const textarea = node.querySelector("textarea")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new File(["text"], "a.txt", { type: "text/plain" })] } });
    await act(async () => textarea.dispatchEvent(paste));
    expect(onAttachmentError).toHaveBeenCalledTimes(1);
    expect(node.textContent).toContain("a.txt");
    await act(async () => button(node, "Retry").click());
    expect(upload).toHaveBeenCalledTimes(2);
    const sendButton = node.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(sendButton.disabled).toBe(false);
    await act(async () => sendButton.click());
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(onSendMessage.mock.calls[0]?.[0]).toEqual([{ type: "file", data: "https://files.example/a.txt", mediaType: "text/plain" }]);
    expect(node.textContent).not.toContain("a.txt");
  });

  it("accepts drops, removes selected attachments and opens the picker without submitting", async () => {
    const onSend = vi.fn(), onSendMessage = vi.fn(), onDrop = vi.fn(), onDragOver = vi.fn();
    const { node } = await mount(createElement(Composer, { value: "draft", onValueChange: vi.fn(), onSend, onSendMessage,
      uploadAttachment: async () => ({ type: "file", data: "data:text/plain;base64,eA==", mediaType: "text/plain" }), onDrop, onDragOver }));
    const form = node.querySelector("form")!;
    const drag = new Event("dragover", { bubbles: true, cancelable: true });
    await act(async () => form.dispatchEvent(drag));
    expect(drag.defaultPrevented).toBe(true);
    expect(onDragOver).toHaveBeenCalled();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["x"], "drop.txt", { type: "text/plain" })] } });
    await act(async () => form.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(true);
    expect(onDrop).toHaveBeenCalled();
    const remove = node.querySelector<HTMLButtonElement>('[aria-label*="Remove"]')!;
    await act(async () => remove.click());
    expect(node.textContent).not.toContain("drop.txt");
    const picker = node.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(picker, "click");
    const attach = node.querySelector<HTMLButtonElement>('[aria-label*="Attach"]')!;
    await act(async () => attach.click());
    expect(click).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("routes stop and retry to the controller without resending a message", async () => {
    const stop = vi.fn();
    const { node, root } = await mount(createElement(Composer, { value: "", onValueChange: vi.fn(), onSend: vi.fn(), onStop: stop, status: "streaming" }));
    await act(async () => node.querySelector<HTMLButtonElement>("button")!.click());
    expect(stop).toHaveBeenCalledTimes(1);
    const reload = vi.fn(async () => {}), sendMessageWithResult = vi.fn(async () => ({ status: "completed" as const }));
    const controller = { state: { messages: [message], status: "ready", pendingApprovals: [], activity: [] }, input: "retry input", setInput: vi.fn(), send: vi.fn(), stop,
      reload, canReload: true, resolveApproval: vi.fn(), sendMessageWithResult } as unknown as ChatController;
    await act(async () => root.render(createElement(ZhivexChat, { controller })));
    await act(async () => button(node, "Retry").click());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(controller.send).not.toHaveBeenCalled();
    await act(async () => node.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(sendMessageWithResult).toHaveBeenCalledWith("retry input");
  });
});
