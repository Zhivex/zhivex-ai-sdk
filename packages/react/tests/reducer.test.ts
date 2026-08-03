import { describe, expect, it } from "vitest";
import {
  applyUIMessageChunk,
  chatReducer,
  createInitialChatState
} from "../src/reducer.js";
import { selectPendingApproval } from "../src/approval.js";
import type { ChatMessage, ChatStreamChunk } from "../src/types.js";

const userMessage: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }],
  createdAt: 1,
  status: "pending"
};

describe("chat reducer", () => {
  it("folds text, tool, provider, image, and finish chunks into one message", () => {
    let state = createInitialChatState({ messages: [userMessage] });
    state = applyUIMessageChunk(state, {
      type: "text-delta",
      messageId: "assistant-1",
      role: "assistant",
      textDelta: "Hel"
    });
    state = applyUIMessageChunk(state, {
      type: "text-delta",
      messageId: "assistant-1",
      role: "assistant",
      textDelta: "lo"
    });
    state = applyUIMessageChunk(state, {
      type: "tool-call",
      messageId: "assistant-1",
      role: "assistant",
      toolCall: { id: "call-1", name: "weather", input: { city: "BA" } }
    });
    state = applyUIMessageChunk(state, {
      type: "tool-result",
      messageId: "assistant-1",
      role: "tool",
      toolResult: {
        toolCallId: "call-1",
        toolName: "weather",
        output: { temperature: 18 },
        isError: false
      }
    });
    state = applyUIMessageChunk(state, {
      type: "provider-data",
      messageId: "assistant-1",
      role: "assistant",
      provider: "test",
      data: { trace: "trace-1" }
    });
    state = applyUIMessageChunk(state, {
      type: "image-generation",
      messageId: "assistant-1",
      role: "assistant",
      provider: "test",
      image: {
        data: "aGVsbG8=",
        encoding: "base64",
        mediaType: "image/png"
      },
      partial: false,
      id: "image-1"
    });
    state = applyUIMessageChunk(state, {
      type: "finish",
      messageId: "assistant-1",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }
    });

    const assistant = state.messages[1]!;
    expect(assistant.parts[0]).toEqual({ type: "text", text: "Hello" });
    expect(assistant.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "tool-result",
      "provider-data",
      "image"
    ]);
    expect(assistant.parts[4]).toMatchObject({
      type: "image",
      image: "data:image/png;base64,aGVsbG8=",
      mediaType: "image/png"
    });
    expect(assistant.status).toBe("complete");
    expect(assistant.metadata).toMatchObject({ finishReason: "stop" });
    expect(state.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6
    });
  });

  it("replaces a partial generated image with the final image", () => {
    let state = createInitialChatState();
    const imageChunk = {
      type: "image-generation",
      messageId: "assistant-1",
      role: "assistant",
      provider: "test",
      image: { uri: "https://example.com/partial.png", mediaType: "image/png" },
      partial: true,
      index: 0
    } as const;
    state = applyUIMessageChunk(state, imageChunk);
    state = applyUIMessageChunk(state, {
      ...imageChunk,
      image: { uri: "https://example.com/final.png", mediaType: "image/png" },
      partial: false
    });

    expect(state.messages[0]?.parts).toHaveLength(1);
    expect(state.messages[0]?.parts[0]).toMatchObject({
      type: "image",
      image: "https://example.com/final.png"
    });
  });

  it("tracks approvals, lifecycle activity, and the runner session", () => {
    const approval = {
      provider: "test",
      id: "approval-1",
      name: "delete-file",
      arguments: "{}",
      rawData: {}
    };
    let state = createInitialChatState();
    state = applyUIMessageChunk(state, {
      type: "agent-run-start",
      currentStep: 0,
      maxSteps: 4
    });
    state = applyUIMessageChunk(state, {
      type: "agent-approval-request",
      approval
    });
    state = applyUIMessageChunk(state, {
      type: "agent-approval-resolved",
      approval: {
        provider: "test",
        approvalRequestId: "approval-1",
        approve: true
      }
    });
    state = applyUIMessageChunk(state, {
      type: "session-finish",
      sessionId: "session-1",
      status: "completed"
    });

    expect(state.pendingApprovals).toEqual([]);
    expect(state.activity.map((activity) => activity.type)).toEqual([
      "run-start",
      "approval-request",
      "approval-resolved",
      "session-finish"
    ]);
    expect(state.sessionId).toBe("session-1");
    expect(state.status).toBe("ready");
  });

  it("keeps the same approval id isolated by provider", () => {
    let state = createInitialChatState();
    state = applyUIMessageChunk(state, {
      type: "agent-approval-request",
      approval: {
        provider: "provider-a",
        id: "shared-id",
        name: "safe-action",
        arguments: "{}",
        rawData: {}
      }
    });
    state = applyUIMessageChunk(state, {
      type: "agent-approval-request",
      approval: {
        provider: "provider-b",
        id: "shared-id",
        name: "other-action",
        arguments: "{}",
        rawData: {}
      }
    });

    expect(state.status).toBe("streaming");
    expect(state.pendingApprovals).toMatchObject([
      { provider: "provider-a", id: "shared-id" },
      { provider: "provider-b", id: "shared-id" }
    ]);
    expect(() =>
      selectPendingApproval(state.pendingApprovals, "shared-id")
    ).toThrow("ambiguous");
    expect(
      selectPendingApproval(
        state.pendingApprovals,
        "shared-id",
        "provider-b"
      ).provider
    ).toBe("provider-b");
  });

  it("ignores malformed or duplicate terminal agent state", () => {
    const state = createInitialChatState();
    const malformed = applyUIMessageChunk(state, {
      type: "agent-run-finish",
      status: "completed",
      state: { pendingApprovals: "not-an-array" }
    } as ChatStreamChunk);
    const duplicate = applyUIMessageChunk(state, {
      type: "agent-run-finish",
      status: "completed",
      state: {
        pendingApprovals: [
          {
            provider: "provider-a",
            id: "shared-id",
            name: "first",
            arguments: "{}",
            rawData: {}
          },
          {
            provider: "provider-a",
            id: "shared-id",
            name: "second",
            arguments: "{}",
            rawData: {}
          }
        ]
      }
    } as ChatStreamChunk);

    expect(malformed).toBe(state);
    expect(duplicate).toBe(state);
  });

  it("ignores unknown and malformed chunks without changing state", () => {
    const state = createInitialChatState();
    const unknown = applyUIMessageChunk(state, {
      type: "future-event",
      value: true
    });
    const malformed = applyUIMessageChunk(state, {
      type: "text-delta",
      textDelta: 42
    } as ChatStreamChunk);

    expect(unknown).toBe(state);
    expect(malformed).toBe(state);
  });

  it("preserves stream errors when the transport completes", () => {
    const started = chatReducer(createInitialChatState(), {
      type: "request-start"
    });
    const failed = applyUIMessageChunk(started, {
      type: "error",
      messageId: "assistant-1",
      error: { message: "boom" }
    });
    const finished = chatReducer(failed, { type: "request-finish" });

    expect(finished).toBe(failed);
    expect(finished.status).toBe("error");
    expect(finished.error?.message).toBe("boom");
  });

  it("marks partial messages as stopped instead of complete when aborted", () => {
    const started = chatReducer(createInitialChatState(), {
      type: "request-start",
      messages: [userMessage]
    });
    const streaming = applyUIMessageChunk(started, {
      type: "text-delta",
      messageId: "assistant-1",
      role: "assistant",
      textDelta: "Partial"
    });
    const stopped = chatReducer(streaming, { type: "request-stop" });

    expect(stopped.status).toBe("ready");
    expect(stopped.messages[0]?.status).toBe("stopped");
    expect(stopped.messages[1]).toMatchObject({
      status: "stopped",
      parts: [{ type: "text", text: "Partial" }]
    });
  });

  it("treats cancelled runner sessions as stopped", () => {
    let state = createInitialChatState({
      messages: [{ ...userMessage, status: "streaming" }]
    });
    state = applyUIMessageChunk(state, {
      type: "session-finish",
      sessionId: "session-1",
      status: "cancelled"
    });

    expect(state.status).toBe("ready");
    expect(state.messages[0]?.status).toBe("stopped");
    expect(state.sessionId).toBe("session-1");
  });

  it("batches chunks, bounds activity, and resets per-request telemetry", () => {
    let state = chatReducer(createInitialChatState(), {
      type: "stream-chunks",
      chunks: [
        { type: "agent-step-start", stepIndex: 0 },
        { type: "agent-step-start", stepIndex: 1 },
        { type: "agent-step-start", stepIndex: 2 }
      ],
      activityLimit: 2
    });

    expect(state.activity).toEqual([
      { type: "step-start", stepIndex: 1 },
      { type: "step-start", stepIndex: 2 }
    ]);

    state = applyUIMessageChunk(state, {
      type: "finish",
      messageId: "assistant-1",
      usage: { totalTokens: 4 }
    });
    const restarted = chatReducer(state, {
      type: "request-start",
      messages: [userMessage]
    });

    expect(restarted.activity).toEqual([]);
    expect(restarted.usage).toBeUndefined();
  });
});
