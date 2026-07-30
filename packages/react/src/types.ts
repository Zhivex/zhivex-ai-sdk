import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentCompactionRecord,
  AgentStatus,
  AgentStep,
  JsonValue,
  TokenUsage,
  UIMessage,
  UIMessageChunk
} from "@zhivex-ai/core";

export type ChatMessageStatus = "pending" | "streaming" | "complete" | "error";
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

export interface FetchChatTransportOptions {
  endpoint?: string;
  headers?: ChatHeaders;
  buildRequestBody?: ChatRequestBodyBuilder;
  fetch?: typeof globalThis.fetch;
  credentials?: RequestCredentials;
  /** Maximum decoded characters retained for one SSE event. Defaults to 1 MiB. */
  maxEventChars?: number;
  /** Maximum undecoded line buffer size. Defaults to 2 MiB. */
  maxBufferChars?: number;
  /** Opt in only when the endpoint implements idempotent regeneration. */
  supportsReload?: boolean;
}

export type ChatMessagesUpdate =
  | readonly ChatMessage[]
  | ((messages: readonly ChatMessage[]) => readonly ChatMessage[]);

export interface UseZhivexChatOptions {
  transport?: ChatTransport;
  endpoint?: string;
  initialMessages?: readonly (UIMessage | ChatMessage)[];
  initialSessionId?: string;
  metadata?: Record<string, JsonValue>;
  onError?: (error: Error) => void;
  onFinish?: (state: ChatState) => void;
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
  stop: () => void;
  canReload: boolean;
  reload: () => Promise<void>;
  setMessages: (update: ChatMessagesUpdate) => void;
  resolveApproval: (
    approvalRequestId: string,
    approve: boolean,
    reason?: string
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
    };
