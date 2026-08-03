import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentCompactionRecord,
  AgentStatus,
  AgentStep,
  ContentPart,
  JsonValue,
  TokenUsage,
  UIMessage,
  UIMessageChunk
} from "@zhivex-ai/core";

export type ChatMessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "stopped"
  | "error";
export type ChatStatus = "ready" | "submitting" | "streaming" | "error";

export interface ChatMessage extends UIMessage {
  createdAt: number;
  status: ChatMessageStatus;
  metadata?: Record<string, JsonValue>;
}

export type ChatActivity =
  | {
      type: "run-start";
      currentStep: number;
      maxSteps: number;
    }
  | {
      type: "step-start";
      stepIndex: number;
    }
  | {
      type: "step-finish";
      step: AgentStep;
    }
  | {
      type: "approval-request";
      approval: AgentApprovalRequest;
    }
  | {
      type: "approval-resolved";
      approval: AgentApprovalResponse;
    }
  | {
      type: "compaction";
      compaction: AgentCompactionRecord;
    }
  | {
      type: "run-finish";
      status: AgentStatus;
    }
  | {
      type: "session-finish";
      sessionId: string;
      status: AgentStatus;
    };

export interface ChatState {
  messages: ChatMessage[];
  status: ChatStatus;
  error?: Error;
  sessionId?: string;
  usage?: TokenUsage;
  pendingApprovals: AgentApprovalRequest[];
  activity: ChatActivity[];
}

export class ChatBusyError extends Error {
  readonly code = "chat_busy" as const;
  readonly operation: "send" | "reload" | "approval";

  constructor(operation: "send" | "reload" | "approval") {
    super(`Cannot ${operation} while another chat request is active.`);
    this.name = "ChatBusyError";
    this.operation = operation;
  }
}

export interface UnknownUIMessageChunk {
  type: string;
  [key: string]: unknown;
}

export type ChatStreamChunk = UIMessageChunk | UnknownUIMessageChunk;

export interface ChatTransportRequest {
  /** Latest user message for the default stateless request contract. */
  message?: ChatMessage;
  /** Full client snapshot for transports whose server does not own history. */
  messages: readonly ChatMessage[];
  sessionId?: string;
  approvals?: readonly AgentApprovalResponse[];
  metadata?: Record<string, JsonValue>;
  signal: AbortSignal;
}

export interface ChatTransport {
  /**
   * Explicit opt-in for replaying the last user message. Durable Runner
   * transports should leave this disabled to avoid duplicating session history.
   */
  readonly supportsReload?: boolean;
  send(request: ChatTransportRequest): AsyncIterable<ChatStreamChunk>;
}

export interface ChatRequestBody {
  message?: UIMessage;
  sessionId?: string;
  approvals?: readonly AgentApprovalResponse[];
  metadata?: Record<string, JsonValue>;
}

export type ChatRequestBodyBuilder = (
  request: ChatTransportRequest
) => unknown | Promise<unknown>;

export type ChatHeaders =
  | HeadersInit
  | ((request: ChatTransportRequest) => HeadersInit | Promise<HeadersInit>);

export interface ChatTransportErrorContext {
  endpoint: string;
  status: number;
  statusText?: string;
  /** Bounded diagnostic response text. It is never public by default. */
  responseBody?: string;
  /** Safe default message that never contains the response body. */
  defaultMessage: string;
}

export type ChatTransportErrorFormatter = (
  context: ChatTransportErrorContext
) => string | undefined | Promise<string | undefined>;

export interface FetchChatTransportOptions {
  endpoint?: string;
  headers?: ChatHeaders;
  buildRequestBody?: ChatRequestBodyBuilder;
  fetch?: typeof globalThis.fetch;
  credentials?: RequestCredentials;
  /** Redirects are rejected by default so request bodies cannot cross an unexpected origin. */
  redirect?: RequestRedirect;
  /** Maximum decoded characters retained for one SSE event. Defaults to 1 MiB. */
  maxEventChars?: number;
  /** Maximum undecoded line buffer size. Defaults to 2 MiB. */
  maxBufferChars?: number;
  /** Maximum decoded characters across the whole SSE response. Defaults to 16 MiB. */
  maxStreamChars?: number;
  /** Maximum decoded SSE events per response. Defaults to 10,000. */
  maxStreamEvents?: number;
  /** Maximum bytes retained from an HTTP error or non-SSE response. Defaults to 8 KiB. */
  maxErrorBodyBytes?: number;
  /** Explicitly customize public messages for non-successful HTTP responses. */
  formatError?: ChatTransportErrorFormatter;
  /** Total request lifetime. Defaults to 120 seconds; set false to disable. */
  requestTimeoutMs?: number | false;
  /** Maximum wait between response body chunks. Defaults to 30 seconds; set false to disable. */
  streamIdleTimeoutMs?: number | false;
  /** Opt in only when the endpoint implements idempotent regeneration. */
  supportsReload?: boolean;
}

export type ChatMessagesUpdate =
  | readonly ChatMessage[]
  | ((messages: readonly ChatMessage[]) => readonly ChatMessage[]);

export type ChatInputPart = Extract<
  ContentPart,
  { type: "text" | "image" | "audio" | "file" }
>;

export interface ChatInputMessage {
  id?: string;
  parts: readonly ChatInputPart[];
  createdAt?: number;
  metadata?: Record<string, JsonValue>;
}

export type ChatSendInput =
  | string
  | readonly ChatInputPart[]
  | ChatInputMessage;

export interface ChatResetOptions {
  messages?: readonly (UIMessage | ChatMessage)[];
  sessionId?: string;
}

export interface UseZhivexChatOptions {
  transport?: ChatTransport;
  endpoint?: string;
  initialMessages?: readonly (UIMessage | ChatMessage)[];
  initialSessionId?: string;
  /** Controlled session id. Pass null to explicitly clear it. */
  sessionId?: string | null;
  metadata?: Record<string, JsonValue>;
  /** Maximum lifecycle entries retained for the active request. Defaults to 200. */
  activityLimit?: number;
  /** Stream batching window in milliseconds. Defaults to 16; use 0 for immediate updates. */
  streamBatchMs?: number;
  onError?: (error: Error) => void;
  onFinish?: (state: ChatState) => void;
  onSessionChange?: (sessionId: string | undefined) => void;
}

export interface UseZhivexChatResult {
  state: ChatState;
  messages: ChatMessage[];
  status: ChatStatus;
  error?: Error;
  sessionId?: string;
  usage?: TokenUsage;
  pendingApprovals: AgentApprovalRequest[];
  activity: ChatActivity[];
  input: string;
  setInput: (value: string) => void;
  send: (input?: string) => Promise<void>;
  sendMessage: (input: ChatSendInput) => Promise<void>;
  stop: () => void;
  canReload: boolean;
  reload: () => Promise<void>;
  setMessages: (update: ChatMessagesUpdate) => void;
  reset: (options?: ChatResetOptions) => void;
  resolveApproval: (
    approvalRequestId: string,
    approve: boolean,
    reason?: string,
    provider?: string
  ) => Promise<void>;
}

export type ChatAction =
  | {
      type: "request-start";
      message?: ChatMessage;
      messages?: readonly ChatMessage[];
    }
  | {
      type: "stream-chunk";
      chunk: ChatStreamChunk;
      now?: number;
      activityLimit?: number;
    }
  | {
      type: "stream-chunks";
      chunks: readonly ChatStreamChunk[];
      now?: number;
      activityLimit?: number;
    }
  | {
      type: "request-finish";
    }
  | {
      type: "request-stop";
    }
  | {
      type: "request-error";
      error: Error;
    }
  | {
      type: "set-messages";
      messages: readonly ChatMessage[];
    }
  | {
      type: "set-session";
      sessionId?: string;
    }
  | {
      type: "reset";
      messages?: readonly ChatMessage[];
      sessionId?: string;
    };
