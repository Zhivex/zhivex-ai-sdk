"use client";

import type {
  AgentApprovalResponse,
  JsonValue,
  UIMessage
} from "@zhivex-ai/core";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState
} from "react";
import {
  chatReducer,
  createInitialChatState
} from "./reducer.js";
import { createFetchChatTransport } from "./transport.js";
import type {
  ChatAction,
  ChatMessage,
  ChatMessagesUpdate,
  ChatState,
  ChatTransport,
  UseZhivexChatOptions,
  UseZhivexChatResult
} from "./types.js";

let fallbackId = 0;

const createMessageId = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `msg_${globalThis.crypto.randomUUID()}`;
  }
  fallbackId += 1;
  return `msg_${Date.now().toString(36)}_${fallbackId.toString(36)}`;
};

const isChatMessage = (message: UIMessage | ChatMessage): message is ChatMessage =>
  typeof (message as Partial<ChatMessage>).createdAt === "number" &&
  typeof (message as Partial<ChatMessage>).status === "string";

const normalizeInitialMessages = (
  messages: readonly (UIMessage | ChatMessage)[] | undefined
): ChatMessage[] => {
  const now = Date.now();
  return (messages ?? []).map((message, index) =>
    isChatMessage(message)
      ? { ...message, parts: [...message.parts] }
      : {
          ...message,
          parts: [...message.parts],
          createdAt: now + index,
          status: "complete"
        }
  );
};

const createUserMessage = (text: string): ChatMessage => ({
  id: createMessageId(),
  role: "user",
  parts: [{ type: "text", text }],
  createdAt: Date.now(),
  status: "pending"
});

interface ActiveRequest {
  controller: AbortController;
}

interface RunRequest {
  messages: readonly ChatMessage[];
  message?: ChatMessage;
  approvals?: readonly AgentApprovalResponse[];
}

export const useZhivexChat = (
  options: UseZhivexChatOptions = {}
): UseZhivexChatResult => {
  const [state, dispatch] = useReducer(
    chatReducer,
    undefined,
    (): ChatState =>
      createInitialChatState({
        messages: normalizeInitialMessages(options.initialMessages),
        sessionId: options.initialSessionId
      })
  );
  const [input, setInputState] = useState("");

  const stateRef = useRef(state);
  stateRef.current = state;
  const inputRef = useRef(input);
  inputRef.current = input;
  const activeRef = useRef<ActiveRequest | undefined>(undefined);
  const callbackRef = useRef({
    onError: options.onError,
    onFinish: options.onFinish
  });
  callbackRef.current = {
    onError: options.onError,
    onFinish: options.onFinish
  };
  const metadataRef = useRef<Record<string, JsonValue> | undefined>(
    options.metadata
  );
  metadataRef.current = options.metadata;

  const defaultTransportRef = useRef<
    { endpoint: string; transport: ChatTransport } | undefined
  >(undefined);
  const endpoint = options.endpoint ?? "/api/chat";
  if (
    !defaultTransportRef.current ||
    defaultTransportRef.current.endpoint !== endpoint
  ) {
    defaultTransportRef.current = {
      endpoint,
      transport: createFetchChatTransport({ endpoint })
    };
  }
  const transportRef = useRef<ChatTransport>(
    options.transport ?? defaultTransportRef.current.transport
  );
  transportRef.current =
    options.transport ?? defaultTransportRef.current.transport;

  const commit = useCallback((action: ChatAction): ChatState => {
    const next = chatReducer(stateRef.current, action);
    stateRef.current = next;
    dispatch(action);
    return next;
  }, []);

  const runRequest = useCallback(
    async (request: RunRequest): Promise<void> => {
      if (activeRef.current) {
        return;
      }

      const controller = new AbortController();
      const active: ActiveRequest = { controller };
      activeRef.current = active;
      commit({ type: "request-start", messages: request.messages });

      let streamReportedError = false;
      try {
        for await (const chunk of transportRef.current.send({
          message: request.message,
          messages: request.messages,
          sessionId: stateRef.current.sessionId,
          approvals: request.approvals,
          metadata: metadataRef.current,
          signal: controller.signal
        })) {
          if (activeRef.current !== active) {
            return;
          }
          const next = commit({ type: "stream-chunk", chunk });
          if (next.status === "error" && next.error && !streamReportedError) {
            streamReportedError = true;
            callbackRef.current.onError?.(next.error);
          }
        }

        if (activeRef.current !== active) {
          return;
        }
        const next = commit({ type: "request-finish" });
        callbackRef.current.onFinish?.(next);
      } catch (error) {
        if (controller.signal.aborted) {
          if (activeRef.current === active) {
            const next = commit({ type: "request-stop" });
            callbackRef.current.onFinish?.(next);
          }
          return;
        }
        if (activeRef.current !== active) {
          return;
        }
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        commit({ type: "request-error", error: normalized });
        callbackRef.current.onError?.(normalized);
      } finally {
        if (activeRef.current === active) {
          activeRef.current = undefined;
        }
      }
    },
    [commit]
  );

  const setInput = useCallback((value: string) => {
    inputRef.current = value;
    setInputState(value);
  }, []);

  const send = useCallback(
    async (value?: string): Promise<void> => {
      if (activeRef.current) {
        return;
      }
      const text = value ?? inputRef.current;
      if (text.trim().length === 0) {
        return;
      }

      const message = createUserMessage(text);
      const messages = [...stateRef.current.messages, message];
      setInput("");
      await runRequest({ messages, message });
    },
    [runRequest, setInput]
  );

  const stop = useCallback(() => {
    const active = activeRef.current;
    if (!active) {
      return;
    }
    active.controller.abort();
    commit({ type: "request-stop" });
  }, [commit]);

  const reload = useCallback(async (): Promise<void> => {
    if (activeRef.current) {
      return;
    }
    if (transportRef.current.supportsReload !== true) {
      throw new Error(
        "Reload is disabled for this transport because replaying the last message can duplicate durable session history."
      );
    }
    const messages = stateRef.current.messages;
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        userIndex = index;
        break;
      }
    }
    if (userIndex === -1) {
      return;
    }

    const nextMessages = messages
      .slice(0, userIndex + 1)
      .map((message) => ({ ...message, parts: [...message.parts] }));
    await runRequest({
      messages: nextMessages,
      message: nextMessages[userIndex]
    });
  }, [runRequest]);

  const setMessages = useCallback(
    (update: ChatMessagesUpdate) => {
      if (activeRef.current) {
        const active = activeRef.current;
        activeRef.current = undefined;
        active.controller.abort();
      }
      const next =
        typeof update === "function"
          ? update(stateRef.current.messages)
          : update;
      commit({ type: "set-messages", messages: next });
    },
    [commit]
  );

  const resolveApproval = useCallback(
    async (
      approvalRequestId: string,
      approve: boolean,
      reason?: string
    ): Promise<void> => {
      if (activeRef.current) {
        return;
      }
      const pending = stateRef.current.pendingApprovals.find(
        (approval) => approval.id === approvalRequestId
      );
      if (!pending) {
        throw new Error(`Unknown approval request "${approvalRequestId}".`);
      }
      const approval: AgentApprovalResponse = {
        provider: pending.provider,
        approvalRequestId,
        approve,
        reason
      };
      await runRequest({
        messages: stateRef.current.messages,
        approvals: [approval]
      });
    },
    [runRequest]
  );

  useEffect(
    () => () => {
      const active = activeRef.current;
      activeRef.current = undefined;
      active?.controller.abort();
    },
    []
  );

  return {
    state,
    messages: state.messages,
    status: state.status,
    error: state.error,
    sessionId: state.sessionId,
    usage: state.usage,
    pendingApprovals: state.pendingApprovals,
    activity: state.activity,
    input,
    setInput,
    send,
    stop,
    canReload: transportRef.current.supportsReload === true,
    reload,
    setMessages,
    resolveApproval
  };
};
