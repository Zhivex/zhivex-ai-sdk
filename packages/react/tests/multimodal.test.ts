// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessagePart, Composer, AgentRunsPanel } from "../src/components.js";
import { getChatAttachmentAccept, validateChatInputParts } from "../src/input-capabilities.js";
import { useZhivexChat } from "../src/use-zhivex-chat.js";
import { createInitialChatState, chatReducer } from "../src/reducer.js";
import type { UseZhivexChatResult } from "../src/types.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const capabilities = { vision: true, audioInput: true, files: true, inputMediaTypes: ["image/*", "audio/*", "video/*"] };

describe("model-aware multimodal UI", () => {
  it("uses the explicit model allowlist rather than treating files as arbitrary documents", () => {
    expect(getChatAttachmentAccept(capabilities)).toBe("image/*,audio/*,video/*");
    expect(() => validateChatInputParts([{ type: "file", mediaType: "video/mp4", data: "https://cdn.example/clip.mp4" }], capabilities)).not.toThrow();
    expect(() => validateChatInputParts([{ type: "file", mediaType: "application/pdf", data: "x" }], capabilities)).toThrow("application/pdf");
    expect(() => validateChatInputParts([{ type: "audio", mediaType: "audio/mpeg", data: "x" }], { vision: false, audioInput: false, files: false })).toThrow();
  });
  it("rejects programmatic sends before transport or draft mutation", async () => {
    const send = vi.fn(async function* () {});
    let chat!: UseZhivexChatResult;
    const root = createRoot(document.createElement("div"));
    function App() { chat = useZhivexChat({ transport: { send }, inputCapabilities: capabilities }); return null; }
    await act(async () => root.render(createElement(App)));
    await act(async () => chat.setInput("keep draft"));
    await expect(chat.sendMessageWithResult([{ type: "file", mediaType: "application/pdf", data: "x" }])).rejects.toThrow();
    expect(send).not.toHaveBeenCalled(); expect(chat.input).toBe("keep draft"); expect(chat.messages).toHaveLength(0);
    await act(async () => root.unmount());
  });
  it("renders video under the same URL policy as other media", () => {
    const props = { part: { type: "file" as const, data: "https://cdn.example/clip.mp4", mediaType: "video/mp4", filename: "clip.mp4" } };
    expect(renderToStaticMarkup(createElement(MessagePart, props))).not.toContain("<video");
    expect(renderToStaticMarkup(createElement(MessagePart, { ...props, mediaUrlPolicy: { allowRemote: true, allowUrl: url => url.hostname === "cdn.example" } }))).toContain("<video");
  });
  it("hides attachments for text-only models", () => {
    const html = renderToStaticMarkup(createElement(Composer, { value: "", onValueChange() {}, onSend() {}, onSendMessage() {}, inputCapabilities: { vision: false, files: false, audioInput: false } }));
    expect(html).not.toContain('type="file"');
  });
  it("keeps concurrent runs separate, sanitizes updates and renders cyclic input without recursion", () => {
    let state = createInitialChatState();
    for (const runId of ["a", "b", "a"]) state = chatReducer(state, { type: "stream-chunk", chunk: { type: "agent-run-update", run: { runId, parentRunId: runId === "a" ? "b" : "a", name: "same agent", status: "running", currentStep: 1, maxSteps: 3, secret: "not for UI" } } });
    expect(state.runs).toHaveLength(2); expect(JSON.stringify(state.runs)).not.toContain("secret");
    const html = renderToStaticMarkup(createElement(AgentRunsPanel, { runs: state.runs! }));
    expect(html.match(/data-run-id=/g)).toHaveLength(2);
    expect(chatReducer(state, { type: "reset" }).runs).toBeUndefined();
  });
});
it("completes an earlier tool card after approval and keeps the resumed text in an assistant message", () => {
  let state = createInitialChatState();
  state = chatReducer(state, { type: "stream-chunk", chunk: { type: "tool-call", messageId: "before-approval", role: "assistant", toolCall: { id: "call", name: "lookup", input: {} } } });
  state = chatReducer(state, { type: "stream-chunk", chunk: { type: "tool-result", messageId: "after-approval", role: "tool", toolResult: { toolCallId: "call", toolName: "lookup", output: "found", isError: false } } });
  state = chatReducer(state, { type: "stream-chunk", chunk: { type: "text-delta", messageId: "after-approval", role: "assistant", textDelta: "Answer" } });
  expect(state.messages[0]!.parts.map(part => part.type)).toEqual(["tool-call", "tool-result"]);
  expect(state.messages[1]).toMatchObject({ role: "assistant", parts: [{ type: "text", text: "Answer" }] });
});
