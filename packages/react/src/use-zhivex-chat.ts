"use client";

import type {
  AgentApprovalResponse,
  ContentPart,
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
import { selectPendingApproval } from "./approval.js";
import { createFetchChatTransport } from "./transport.js";
import { ChatBusyError } from "./types.js";
import type {
  ChatAction,
  ChatInputMessage,
  ChatInputPart,
  ChatMessage,
  ChatMessagesUpdate,
  ChatResetOptions,
  ChatSendInput,
  ChatState,
  ChatStreamChunk,
  ChatTransport,
  UseZhivexChatOptions,
  UseZhivexChatResult
} from "./types.js";

let fallbackId = 0;
const DEFAULT_STREAM_BATCH_MS = 16;

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

const isChatInputMessage = (input: ChatSendInput): input is ChatInputMessage =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  "parts" in input;

const toInputParts = (input: ChatSendInput): readonly ChatInputPart[] => {
  if (typeof input === "string") {
    return [{ type: "text", text: input }];
  }
  return isChatInputMessage(input) ? input.parts : input;
};

const hasInputContent = (parts: readonly ContentPart[]): boolean =>
  parts.some((part) => part.type !== "text" || part.text.trim().length > 0);

const createUserMessage = (input: ChatSendInput): ChatMessage => {
  const details = isChatInputMessage(input) ? input : undefined;
  return {
    id: details?.id ?? createMessageId(),
    role: "user",
    parts: [...toInputParts(input)],
    createdAt: details?.createdAt ?? Date.now(),
    status: "pending",
    metadata: details?.metadata
  };
};

interface ActiveRequest {
  controller: AbortController;
  sessionId?: string;
  flushPending?: () => void;
  discardPending?: () => void;
}

interface RunRequest {
  messages: readonly ChatMessage[];
  message?: ChatMessage;
  approvals?: readonly AgentApprovalResponse[];
}

export const useZhivexChat = (
  options: UseZhivexChatOptions = {}
): UseZhivexChatResult => {
  const controlledSessionId =
    options.sessionId === null ? undefined : options.sessionId;
  const [state, dispatch] = useReducer(
    chatReducer,
    undefined,
    (): ChatState =>
      createInitialChatState({
        messages: normalizeInitialMessages(options.initialMessages),
        sessionId:
          options.sessionId === undefined
            ? options.initialSessionId
            : controlledSessionId
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
    onFinish: options.onFinish,
    onSessionChange: options.onSessionChange
  });
  callbackRef.current = {
    onError: options.onError,
    onFinish: options.onFinish,
    onSessionChange: options.onSessionChange
  };
  const metadataRef = useRef<Record<string, JsonValue> | undefined>(
    options.metadata
  );
  metadataRef.current = options.metadata;
  const activityLimitRef = useRef(options.activityLimit);
  activityLimitRef.current = options.activityLimit;
  const streamBatchMsRef = useRef(options.streamBatchMs);
  streamBatchMsRef.current = options.streamBatchMs;
  const controlledSessionRef = useRef<{
    enabled: boolean;
    sessionId?: string;
  }>({
    enabled: options.sessionId !== undefined,
    sessionId: controlledSessionId
  });
  controlledSessionRef.current = {
    enabled: options.sessionId !== undefined,
    sessionId: controlledSessionId
  };

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
      const active: ActiveRequest = {
        controller,
        sessionId: stateRef.current.sessionId
      };
      activeRef.current = active;
      commit({ type: "request-start", messages: request.messages });

      let streamReportedError = false;
      let pending:
        | {
            chunks: ChatStreamChunk[];
            timer: ReturnType<typeof setTimeout>;
            promise: Promise<void>;
            resolve: () => void;
          }
        | undefined;

      const isCurrentRequest = () =>
        activeRef.current === active &&
        (!controlledSessionRef.current.enabled ||
          controlledSessionRef.current.sessionId === active.sessionId);

      const applyChunks = (chunks: readonly ChatStreamChunk[]) => {
        if (!isCurrentRequest() || chunks.length === 0) {
          return;
        }
        const previousSessionId = stateRef.current.sessionId;
        const next = commit({
          type: "stream-chunks",
          chunks,
          activityLimit: activityLimitRef.current
        });
        if (
          next.sessionId !== previousSessionId &&
          next.sessionId !== undefined
        ) {
          callbackRef.current.onSessionChange?.(next.sessionId);
        }
        if (next.status === "error" && next.error && !streamReportedError) {
          streamReportedError = true;
          callbackRef.current.onError?.(next.error);
        }
      };

      const flushPending = () => {
        const current = pending;
        if (!current) {
          return;
        }
        pending = undefined;
        clearTimeout(current.timer);
        applyChunks(current.chunks);
        current.resolve();
      };

      const enqueueChunk = (chunk: ChatStreamChunk) => {
        if (pending) {
          pending.chunks.push(chunk);
          return;
        }
        let resolve: () => void = () => {};
        const promise = new Promise<void>((done) => {
          resolve = () => done();
        });
        const configured = streamBatchMsRef.current;
        const delay =
          configured === undefined ||
          !Number.isFinite(configured) ||
          configured < 0
            ? DEFAULT_STREAM_BATCH_MS
            : configured;
        if (delay === 0) {
          applyChunks([chunk]);
          return;
        }
        const timer = setTimeout(flushPending, delay);
        pending = {
          chunks: [chunk],
          timer,
          promise,
          resolve
        };
      };

      const discardPending = () => {
        const current = pending;
        pending = undefined;
        if (current) {
          clearTimeout(current.timer);
          current.resolve();
        }
      };
      active.flushPending = flushPending;
      active.discardPending = discardPending;

      try {
        for await (const chunk of transportRef.current.send({
          message: request.message,
          messages: request.messages,
          sessionId: active.sessionId,
          approvals: request.approvals,
          metadata: metadataRef.current,
          signal: controller.signal
        })) {
          if (!isCurrentRequest()) {
            return;
          }
          enqueueChunk(chunk);
          if (chunk.type === "error" || chunk.type === "session-finish") {
            flushPending();
          }
        }

        if (!isCurrentRequest()) {
          return;
        }
        const pendingPromise = pending?.promise;
        flushPending();
        await pendingPromise;
        if (!isCurrentRequest()) {
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
        controller.abort(normalized);
        commit({ type: "request-error", error: normalized });
        callbackRef.current.onError?.(normalized);
      } finally {
        discardPending();
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

  const sendMessage = useCallback(
    async (input: ChatSendInput): Promise<void> => {
      if (activeRef.current) {
        throw new ChatBusyError("send");
      }
      const parts = toInputParts(input);
      if (!hasInputContent(parts)) {
        return;
      }

      const message = createUserMessage(input);
      const messages = [...stateRef.current.messages, message];
      setInput("");
      await runRequest({ messages, message });
    },
    [runRequest, setInput]
  );

  const send = useCallback(
    async (value?: string): Promise<void> => {
      if (activeRef.current) {
        return;
      }
      const text = value ?? inputRef.current;
      await sendMessage(text);
    },
    [sendMessage]
  );

  const stop = useCallback(() => {
    const active = activeRef.current;
    if (!active) {
      return;
    }
    active.flushPending?.();
    activeRef.current = undefined;
    active.controller.abort();
    const next = commit({ type: "request-stop" });
    callbackRef.current.onFinish?.(next);
  }, [commit]);

  const reload = useCallback(async (): Promise<void> => {
    if (activeRef.current) {
      throw new ChatBusyError("reload");
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
      .map((message, index) => ({
        ...message,
        parts: [...message.parts],
        status: index === userIndex ? ("pending" as const) : message.status
      }));
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
        active.discardPending?.();
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

  const reset = useCallback(
    (resetOptions: ChatResetOptions = {}) => {
      const active = activeRef.current;
      if (active) {
        activeRef.current = undefined;
        active.discardPending?.();
        active.controller.abort();
      }
      setInput("");
      const previousSessionId = stateRef.current.sessionId;
      const nextSessionId = resetOptions.sessionId;
      commit({
        type: "reset",
        messages: normalizeInitialMessages(resetOptions.messages),
        sessionId: nextSessionId
      });
      if (previousSessionId !== nextSessionId) {
        callbackRef.current.onSessionChange?.(nextSessionId);
      }
    },
    [commit, setInput]
  );

  const resolveApproval = useCallback(
    async (
      approvalRequestId: string,
      approve: boolean,
      reason?: string,
      provider?: string
    ): Promise<void> => {
      if (activeRef.current) {
        throw new ChatBusyError("approval");
      }
      const pending = selectPendingApproval(
        stateRef.current.pendingApprovals,
        approvalRequestId,
        provider
      );
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
      active?.discardPending?.();
      active?.controller.abort();
    },
    []
  );

  useEffect(() => {
    if (options.sessionId === undefined) {
      return;
    }
    const nextSessionId =
      options.sessionId === null ? undefined : options.sessionId;
    const active = activeRef.current;
    if (active && active.sessionId !== nextSessionId) {
      activeRef.current = undefined;
      active.discardPending?.();
      active.controller.abort();
      const next = commit({ type: "request-stop" });
      callbackRef.current.onFinish?.(next);
    }
    if (stateRef.current.sessionId !== nextSessionId) {
      commit({ type: "set-session", sessionId: nextSessionId });
    }
  }, [commit, options.sessionId, state.sessionId]);

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
    sendMessage,
    stop,
    canReload: transportRef.current.supportsReload === true,
    reload,
    setMessages,
    reset,
    resolveApproval
  };
};
