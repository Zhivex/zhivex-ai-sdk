import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentStatus,
  ContentPart,
  JsonValue,
  MessageRole,
  TokenUsage,
  ToolCall,
  ToolExecutionResult
} from "@zhivex-ai/core";
import type {
  ChatAction,
  ChatMessage,
  ChatState,
  ChatStreamChunk
} from "./types.js";
import { approvalKey } from "./approval.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isMessageRole = (value: unknown): value is MessageRole =>
  value === "system" || value === "user" || value === "assistant" || value === "tool";

const isAgentStatus = (value: unknown): value is AgentStatus =>
  value === "queued" ||
  value === "running" ||
  value === "completed" ||
  value === "suspended" ||
  value === "waiting_approval" ||
  value === "cancel_requested" ||
  value === "failed" ||
  value === "cancelled" ||
  value === "timed_out";

const isToolCall = (value: unknown): value is ToolCall =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.name) &&
  "input" in value;

const isToolResult = (value: unknown): value is ToolExecutionResult =>
  isRecord(value) &&
  isString(value.toolCallId) &&
  isString(value.toolName) &&
  typeof value.isError === "boolean";

const isApprovalRequest = (value: unknown): value is AgentApprovalRequest =>
  isRecord(value) &&
  isString(value.provider) &&
  isString(value.id) &&
  isString(value.name) &&
  isString(value.arguments) &&
  "rawData" in value;

const isApprovalResponse = (value: unknown): value is AgentApprovalResponse =>
  isRecord(value) &&
  isString(value.provider) &&
  isString(value.approvalRequestId) &&
  typeof value.approve === "boolean";

const toTokenUsage = (value: unknown): TokenUsage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage: TokenUsage = {};
  const numericKeys = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens"
  ] as const;
  for (const key of numericKeys) {
    if (isNumber(value[key])) {
      usage[key] = value[key];
    }
  }
  if (value.speed === "standard" || value.speed === "fast") {
    usage.speed = value.speed;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
};

const toError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value;
  }
  if (isRecord(value) && isString(value.message)) {
    return new Error(value.message);
  }
  return new Error("The chat request failed.");
};

const upsertApproval = (
  approvals: readonly AgentApprovalRequest[],
  approval: AgentApprovalRequest
): AgentApprovalRequest[] => {
  const key = approvalKey(approval);
  const index = approvals.findIndex((candidate) => approvalKey(candidate) === key);
  if (index === -1) {
    return [...approvals, approval];
  }
  const next = [...approvals];
  next[index] = approval;
  return next;
};

const appendApproval = (
  state: ChatState,
  approval: AgentApprovalRequest
): ChatState => {
  return {
    ...state,
    pendingApprovals: upsertApproval(state.pendingApprovals, approval),
    activity: [...state.activity, { type: "approval-request", approval }],
    status: "streaming"
  };
};

const parseTerminalPendingApprovals = (
  state: Record<string, unknown>
): { valid: true; value?: AgentApprovalRequest[] } | { valid: false } => {
  if (!("pendingApprovals" in state)) {
    return { valid: true };
  }
  if (
    !Array.isArray(state.pendingApprovals) ||
    !state.pendingApprovals.every(isApprovalRequest)
  ) {
    return { valid: false };
  }

  const keys = new Set<string>();
  for (const approval of state.pendingApprovals) {
    const key = approvalKey(approval);
    if (keys.has(key)) {
      return { valid: false };
    }
    keys.add(key);
  }
  return {
    valid: true,
    value: state.pendingApprovals.map((approval) => ({ ...approval }))
  };
};

const mergeUsage = (
  current: TokenUsage | undefined,
  incoming: TokenUsage | undefined
): TokenUsage | undefined => {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return { ...incoming };
  }

  const sum = (left: number | undefined, right: number | undefined) =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);

  return {
    inputTokens: sum(current.inputTokens, incoming.inputTokens),
    cachedInputTokens: sum(current.cachedInputTokens, incoming.cachedInputTokens),
    cacheWriteTokens: sum(current.cacheWriteTokens, incoming.cacheWriteTokens),
    outputTokens: sum(current.outputTokens, incoming.outputTokens),
    reasoningTokens: sum(current.reasoningTokens, incoming.reasoningTokens),
    totalTokens: sum(current.totalTokens, incoming.totalTokens),
    speed: incoming.speed ?? current.speed
  };
};

const normalizeMessage = (
  message: ChatMessage,
  status: ChatMessage["status"] = message.status
): ChatMessage => ({
  ...message,
  parts: [...message.parts],
  status
});

const updateMessage = (
  messages: readonly ChatMessage[],
  messageId: string,
  role: MessageRole,
  now: number,
  update: (message: ChatMessage) => ChatMessage
): ChatMessage[] => {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index === -1) {
    return [
      ...messages,
      update({
        id: messageId,
        role,
        parts: [],
        createdAt: now,
        status: "streaming"
      })
    ];
  }

  const next = [...messages];
  next[index] = update(messages[index]!);
  return next;
};

const appendPart = (
  messages: readonly ChatMessage[],
  messageId: string,
  role: MessageRole,
  part: ContentPart,
  now: number
) =>
  updateMessage(messages, messageId, role, now, (message) => ({
    ...message,
    parts: [...message.parts, part],
    status: "streaming"
  }));

const appendText = (
  messages: readonly ChatMessage[],
  messageId: string,
  role: MessageRole,
  textDelta: string,
  now: number
) =>
  updateMessage(messages, messageId, role, now, (message) => {
    const parts = [...message.parts];
    const last = parts.at(-1);
    if (last?.type === "text") {
      parts[parts.length - 1] = {
        ...last,
        text: `${last.text}${textDelta}`
      };
    } else {
      parts.push({ type: "text", text: textDelta });
    }
    return { ...message, parts, status: "streaming" };
  });

const generatedImageSource = (image: Record<string, unknown>): string | undefined => {
  if (isString(image.uri) && image.uri.length > 0) {
    return image.uri;
  }
  if (isString(image.data) && image.data.length > 0 && isString(image.mediaType)) {
    return `data:${image.mediaType};base64,${image.data}`;
  }
  return undefined;
};

const generatedImageMarker = (
  provider: string,
  partial: boolean,
  id: string | undefined,
  index: number | undefined
): Record<string, JsonValue> => ({
  provider,
  partial,
  ...(id === undefined ? {} : { id }),
  ...(index === undefined ? {} : { index })
});

const generatedImageMatches = (
  part: ContentPart,
  provider: string,
  id: string | undefined,
  index: number | undefined
): boolean => {
  if (part.type !== "image" || !part.providerMetadata) {
    return false;
  }
  const marker = part.providerMetadata.zhivexImageGeneration;
  if (!isRecord(marker) || marker.provider !== provider) {
    return false;
  }
  if (id !== undefined) {
    return marker.id === id;
  }
  if (index !== undefined) {
    return marker.index === index;
  }
  return marker.partial === true;
};

const appendGeneratedImage = (
  messages: ChatMessage[],
  chunk: Record<string, unknown>,
  now: number
): ChatMessage[] => {
  if (
    !isString(chunk.messageId) ||
    !isString(chunk.provider) ||
    !isRecord(chunk.image)
  ) {
    return messages;
  }
  const source = generatedImageSource(chunk.image);
  if (!source) {
    return messages;
  }

  const id = isString(chunk.id) ? chunk.id : undefined;
  const index = isNumber(chunk.index) ? chunk.index : undefined;
  const partial = chunk.partial === true;
  const mediaType = isString(chunk.image.mediaType) ? chunk.image.mediaType : undefined;
  const imageMetadata = isRecord(chunk.image.providerMetadata)
    ? (chunk.image.providerMetadata as Record<string, JsonValue>)
    : {};
  const eventMetadata = isRecord(chunk.providerMetadata)
    ? (chunk.providerMetadata as Record<string, JsonValue>)
    : {};
  const part: ContentPart = {
    type: "image",
    image: source,
    mediaType,
    providerMetadata: {
      ...imageMetadata,
      ...eventMetadata,
      zhivexImageGeneration: generatedImageMarker(
        chunk.provider,
        partial,
        id,
        index
      )
    }
  };

  return updateMessage(messages, chunk.messageId, "assistant", now, (message) => {
    const parts = [...message.parts];
    const existing = parts.findIndex((candidate) =>
      generatedImageMatches(candidate, chunk.provider as string, id, index)
    );
    if (existing === -1) {
      parts.push(part);
    } else {
      parts[existing] = part;
    }
    return { ...message, parts, status: "streaming" };
  });
};

const finishMessage = (
  messages: readonly ChatMessage[],
  chunk: Record<string, unknown>
): ChatMessage[] => {
  if (!isString(chunk.messageId)) {
    return [...messages];
  }
  return messages.map((message) =>
    message.id === chunk.messageId
      ? {
          ...message,
          status: "complete" as const,
          metadata: {
            ...message.metadata,
            ...(isString(chunk.finishReason)
              ? { finishReason: chunk.finishReason }
              : {}),
            ...(isString(chunk.providerFinishReason)
              ? { providerFinishReason: chunk.providerFinishReason }
              : {})
          }
        }
      : message
  );
};

const failMessage = (
  messages: readonly ChatMessage[],
  messageId: unknown
): ChatMessage[] =>
  messages.map((message) =>
    isString(messageId) && message.id === messageId
      ? { ...message, status: "error" as const }
      : message
  );

const settleMessages = (
  messages: readonly ChatMessage[],
  status: "complete" | "error"
): ChatMessage[] =>
  messages.map((message) =>
    message.status === "pending" || message.status === "streaming"
      ? { ...message, status }
      : message
  );

const terminalStatusIsError = (status: unknown) =>
  status === "failed" || status === "timed_out";

export const createInitialChatState = (
  options: {
    messages?: readonly ChatMessage[];
    sessionId?: string;
  } = {}
): ChatState => ({
  messages: (options.messages ?? []).map((message) => normalizeMessage(message)),
  status: "ready",
  sessionId: options.sessionId,
  pendingApprovals: [],
  activity: []
});

export const applyUIMessageChunk = (
  state: ChatState,
  chunk: ChatStreamChunk,
  now: number = Date.now()
): ChatState => {
  if (!isRecord(chunk) || !isString(chunk.type)) {
    return state;
  }

  if (chunk.type === "text-delta") {
    if (
      !isString(chunk.messageId) ||
      !isString(chunk.textDelta) ||
      !isMessageRole(chunk.role)
    ) {
      return state;
    }
    return {
      ...state,
      messages: appendText(
        state.messages,
        chunk.messageId,
        chunk.role,
        chunk.textDelta,
        now
      ),
      status: "streaming",
      error: undefined
    };
  }

  if (chunk.type === "tool-call") {
    if (
      !isString(chunk.messageId) ||
      !isMessageRole(chunk.role) ||
      !isToolCall(chunk.toolCall)
    ) {
      return state;
    }
    return {
      ...state,
      messages: appendPart(
        state.messages,
        chunk.messageId,
        chunk.role,
        { type: "tool-call", toolCall: chunk.toolCall },
        now
      ),
      status: "streaming"
    };
  }

  if (chunk.type === "tool-result") {
    if (
      !isString(chunk.messageId) ||
      !isMessageRole(chunk.role) ||
      !isToolResult(chunk.toolResult)
    ) {
      return state;
    }
    return {
      ...state,
      messages: appendPart(
        state.messages,
        chunk.messageId,
        chunk.role,
        { type: "tool-result", toolResult: chunk.toolResult },
        now
      ),
      status: "streaming"
    };
  }

  if (chunk.type === "provider-data") {
    if (
      !isString(chunk.messageId) ||
      !isMessageRole(chunk.role) ||
      !isString(chunk.provider)
    ) {
      return state;
    }
    return {
      ...state,
      messages: appendPart(
        state.messages,
        chunk.messageId,
        chunk.role,
        {
          type: "provider-data",
          provider: chunk.provider,
          data: chunk.data as JsonValue
        },
        now
      ),
      status: "streaming"
    };
  }

  if (chunk.type === "image-generation") {
    const messages = appendGeneratedImage(state.messages, chunk, now);
    return messages === state.messages
      ? state
      : { ...state, messages, status: "streaming" };
  }

  if (chunk.type === "tool-approval-request") {
    if (!isApprovalRequest(chunk.approval)) {
      return state;
    }
    return appendApproval(state, chunk.approval);
  }

  if (chunk.type === "finish") {
    const usage = toTokenUsage(chunk.usage);
    return {
      ...state,
      messages: finishMessage(state.messages, chunk),
      usage: mergeUsage(state.usage, usage)
    };
  }

  if (chunk.type === "error") {
    const error = toError(chunk.error);
    return {
      ...state,
      messages: failMessage(state.messages, chunk.messageId),
      status: "error",
      error
    };
  }

  if (chunk.type === "agent-run-start") {
    if (!isNumber(chunk.currentStep) || !isNumber(chunk.maxSteps)) {
      return state;
    }
    return {
      ...state,
      activity: [
        ...state.activity,
        {
          type: "run-start",
          currentStep: chunk.currentStep,
          maxSteps: chunk.maxSteps
        }
      ],
      status: "streaming"
    };
  }

  if (chunk.type === "agent-step-start") {
    if (!isNumber(chunk.stepIndex)) {
      return state;
    }
    return {
      ...state,
      activity: [
        ...state.activity,
        { type: "step-start", stepIndex: chunk.stepIndex }
      ],
      status: "streaming"
    };
  }

  if (chunk.type === "agent-step-finish") {
    if (!isRecord(chunk.step)) {
      return state;
    }
    return {
      ...state,
      activity: [
        ...state.activity,
        { type: "step-finish", step: chunk.step as never }
      ],
      status: "streaming"
    };
  }

  if (chunk.type === "agent-approval-request") {
    if (!isApprovalRequest(chunk.approval)) {
      return state;
    }
    return appendApproval(state, chunk.approval);
  }

  if (chunk.type === "agent-approval-resolved") {
    if (!isApprovalResponse(chunk.approval)) {
      return state;
    }
    const approval = chunk.approval;
    const approvalRequestId = approval.approvalRequestId;
    const provider = approval.provider;
    return {
      ...state,
      pendingApprovals: state.pendingApprovals.filter(
        (pending) =>
          pending.id !== approvalRequestId ||
          pending.provider !== provider
      ),
      activity: [...state.activity, { type: "approval-resolved", approval }],
      status: "streaming"
    };
  }

  if (chunk.type === "agent-compaction") {
    if (!isRecord(chunk.compaction)) {
      return state;
    }
    return {
      ...state,
      activity: [
        ...state.activity,
        { type: "compaction", compaction: chunk.compaction as never }
      ],
      status: "streaming"
    };
  }

  if (chunk.type === "agent-run-finish") {
    if (!isAgentStatus(chunk.status)) {
      return state;
    }
    const runState = isRecord(chunk.state) ? chunk.state : undefined;
    const parsedApprovals = runState
      ? parseTerminalPendingApprovals(runState)
      : { valid: true as const, value: undefined };
    if (!parsedApprovals.valid) {
      return state;
    }
    if (
      runState &&
      "usage" in runState &&
      runState.usage !== undefined &&
      !isRecord(runState.usage)
    ) {
      return state;
    }
    const error =
      runState && "error" in runState && runState.error
        ? toError(runState.error)
        : state.error;
    const usage =
      runState && "usage" in runState
        ? toTokenUsage(runState.usage)
        : state.usage;
    const failed = terminalStatusIsError(chunk.status);
    return {
      ...state,
      messages: settleMessages(state.messages, failed ? "error" : "complete"),
      status: failed ? "error" : "ready",
      error: failed ? error ?? new Error(`Agent run ${chunk.status}.`) : undefined,
      usage,
      pendingApprovals: parsedApprovals.value ?? state.pendingApprovals,
      activity: [
        ...state.activity,
        { type: "run-finish", status: chunk.status }
      ]
    };
  }

  if (chunk.type === "session-finish") {
    if (!isString(chunk.sessionId) || !isAgentStatus(chunk.status)) {
      return state;
    }
    const failed = terminalStatusIsError(chunk.status);
    return {
      ...state,
      messages: settleMessages(state.messages, failed ? "error" : "complete"),
      sessionId: chunk.sessionId,
      status: failed ? "error" : "ready",
      error: failed
        ? state.error ?? new Error(`Agent session ${chunk.status}.`)
        : undefined,
      activity: [
        ...state.activity,
        {
          type: "session-finish",
          sessionId: chunk.sessionId,
          status: chunk.status
        }
      ]
    };
  }

  return state;
};

export const chatReducer = (state: ChatState, action: ChatAction): ChatState => {
  if (action.type === "request-start") {
    const messages = action.messages
      ? action.messages.map((message) => normalizeMessage(message))
      : action.message
        ? [...state.messages, normalizeMessage(action.message, "pending")]
        : state.messages;
    return {
      ...state,
      messages,
      status: "submitting",
      error: undefined
    };
  }

  if (action.type === "stream-chunk") {
    return applyUIMessageChunk(state, action.chunk, action.now);
  }

  if (action.type === "request-finish" || action.type === "request-stop") {
    if (action.type === "request-finish" && state.status === "error") {
      return state;
    }
    return {
      ...state,
      messages: settleMessages(state.messages, "complete"),
      status: "ready",
      error: undefined
    };
  }

  if (action.type === "request-error") {
    return {
      ...state,
      messages: settleMessages(state.messages, "error"),
      status: "error",
      error: action.error
    };
  }

  if (action.type === "set-messages") {
    return {
      ...state,
      messages: action.messages.map((message) => normalizeMessage(message)),
      error: undefined,
      status: "ready"
    };
  }

  return state;
};
