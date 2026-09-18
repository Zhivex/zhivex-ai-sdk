import type {
  AgentApprovalRequest,
  AgentApprovalResponse,
  AgentStatus,
  FinishReason,
  JsonValue,
  MessageRole,
  TokenUsage
} from "./common.js";
import type {
  ContentPart,
  ToolCall,
  ToolExecutionResult
} from "./messages.js";
import type {
  AgentRunUpdateEvent
} from "./agents.js";
import type {
  AgentCompactionRecord,
  AgentRunState,
  AgentStep
} from "./agent-state.js";

export interface UIMessage {
  id: string;
  role: MessageRole;
  parts: ContentPart[];
}

export interface UIMessageTextChunk {
  type: "text-delta";
  messageId: string;
  role: "assistant";
  textDelta: string;
}

export interface UIMessageToolCallChunk {
  type: "tool-call";
  messageId: string;
  role: "assistant";
  toolCall: ToolCall;
}

export interface UIMessageToolResultChunk {
  type: "tool-result";
  messageId: string;
  role: "tool";
  toolResult: ToolExecutionResult;
}

export interface UIMessageToolApprovalRequestChunk {
  type: "tool-approval-request";
  messageId: string;
  role: "assistant";
  approval: AgentApprovalRequest;
}

export interface UIMessageProviderDataChunk {
  type: "provider-data";
  messageId: string;
  role: "assistant";
  provider: string;
  data: JsonValue;
}

export interface UIMessageGeneratedMedia {
  data?: string;
  encoding?: "base64";
  uri?: string;
  mediaType: string;
  text?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface UIMessageImageGenerationChunk {
  type: "image-generation";
  messageId: string;
  role: "assistant";
  provider: string;
  image: UIMessageGeneratedMedia;
  partial: boolean;
  id?: string;
  index?: number;
  providerMetadata?: Record<string, JsonValue>;
}

export interface UIMessageFinishChunk {
  type: "finish";
  messageId: string;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
}

export interface UIMessageErrorChunk {
  type: "error";
  messageId: string;
  error: {
    message: string;
  };
}

export interface UIAgentRunStartChunk {
  type: "agent-run-start";
  currentStep: number;
  maxSteps: number;
}

export interface UIAgentStepStartChunk {
  type: "agent-step-start";
  stepIndex: number;
}

export interface UIAgentStepFinishChunk {
  type: "agent-step-finish";
  step: AgentStep;
}

export interface UIAgentApprovalRequestChunk {
  type: "agent-approval-request";
  approval: AgentApprovalRequest;
}

export interface UIAgentApprovalResolvedChunk {
  type: "agent-approval-resolved";
  approval: AgentApprovalResponse;
}

export interface UIAgentCompactionChunk {
  type: "agent-compaction";
  compaction: AgentCompactionRecord;
}

export interface UIAgentRunFinishChunk {
  type: "agent-run-finish";
  status: AgentStatus;
  state: AgentRunState;
}

export interface UISessionFinishChunk {
  type: "session-finish";
  sessionId: string;
  status: AgentStatus;
}

export type UIMessageChunk =
  | AgentRunUpdateEvent
  | UIMessageTextChunk
  | UIMessageToolCallChunk
  | UIMessageToolResultChunk
  | UIMessageToolApprovalRequestChunk
  | UIMessageProviderDataChunk
  | UIMessageImageGenerationChunk
  | UIMessageFinishChunk
  | UIMessageErrorChunk
  | UIAgentRunStartChunk
  | UIAgentStepStartChunk
  | UIAgentStepFinishChunk
  | UIAgentApprovalRequestChunk
  | UIAgentApprovalResolvedChunk
  | UIAgentCompactionChunk
  | UIAgentRunFinishChunk
  | UISessionFinishChunk;
