import { describe, expect, it } from "vitest";
import { applyUIMessageChunk, createInitialChatState } from "../src/reducer.js";
import * as react from "../src/index.js";
import * as hooks from "../src/hooks.js";
import * as headless from "../src/headless.js";

const HISTORICAL_EXPORTS = [
  "useZhivexChat",
  "createFetchChatTransport",
  "prepareChatRequestBody",
  "parseChatEventStream",
  "chatReducer",
  "applyUIMessageChunk",
  "ZhivexChat",
  "MessageList",
  "Composer",
  "ChatBusyError"
] as const;

describe("@zhivex-ai/react backward compatibility", () => {
  it("keeps the existing public exports and adds the new hooks beside them", () => {
    for (const name of HISTORICAL_EXPORTS) {
      expect(react[name]).toBeTypeOf("function");
    }
    expect(hooks.useZhivexChat).toBe(react.useZhivexChat);
    expect(hooks.useObject).toBeTypeOf("function");
    expect(hooks.useApproval).toBeTypeOf("function");
    expect(react.useObject).toBe(hooks.useObject);
    expect(react.useApproval).toBe(hooks.useApproval);
    expect(headless).not.toHaveProperty("useObject");
    expect(headless).not.toHaveProperty("useApproval");
    expect(headless.chatReducer).toBe(react.chatReducer);
  });

  it("still reduces text and approval chunks and ignores unknown events", () => {
    let state = createInitialChatState();
    state = applyUIMessageChunk(state, {
      type: "text-delta",
      messageId: "m1",
      role: "assistant",
      textDelta: "Hello"
    });
    state = applyUIMessageChunk(state, {
      type: "agent-approval-request",
      approval: {
        provider: "zhivex",
        id: "approval-1",
        name: "deploy",
        arguments: "{}",
        rawData: {}
      }
    });
    const afterUnknown = applyUIMessageChunk(state, {
      type: "zhivex.approval.pause",
      approvalToken: "must-not-enter-chat-state"
    } as never);
    expect(afterUnknown).toBe(state);
    expect(state.pendingApprovals).toEqual([{
      provider: "zhivex",
      id: "approval-1",
      name: "deploy",
      arguments: "{}",
      rawData: {}
    }]);
    expect(JSON.stringify(state)).not.toContain("must-not-enter-chat-state");
    const text = state.messages.flatMap((message) => message.parts).find((part) => part.type === "text");
    expect(text).toMatchObject({ text: "Hello" });
  });
});
