import type {
  AgentApprovalRequest,
  FinishReason,
  JsonValue,
  PartialJsonValue,
  TokenUsage
} from "./common.js";
import type {
  ModelMessage,
  ToolCall,
  ToolExecutionResult
} from "./messages.js";
import type {
  GeneratedMedia
} from "./media-data.js";

export interface StreamTextDeltaEvent {
  type: "text-delta";
  textDelta: string;
}

export interface StreamToolCallEvent {
  type: "tool-call";
  toolCall: ToolCall;
}

export interface StreamToolResultEvent {
  type: "tool-result";
  toolResult: ToolExecutionResult;
}

export interface StreamToolApprovalRequestEvent {
  type: "tool-approval-request";
  approval: AgentApprovalRequest;
}

export interface StreamProviderDataEvent {
  type: "provider-data";
  provider: string;
  data: JsonValue;
}

export interface StreamImageGenerationEvent {
  type: "image-generation";
  provider: string;
  image: GeneratedMedia;
  partial: boolean;
  id?: string;
  index?: number;
  providerMetadata?: Record<string, JsonValue>;
}

export interface StreamFinishEvent {
  type: "finish";
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
}

export interface StreamErrorEvent {
  type: "error";
  error: Error;
}

export type StreamEvent =
  | StreamTextDeltaEvent
  | StreamToolCallEvent
  | StreamToolResultEvent
  | StreamToolApprovalRequestEvent
  | StreamProviderDataEvent
  | StreamImageGenerationEvent
  | StreamFinishEvent
  | StreamErrorEvent;

export interface StreamObjectDeltaEvent {
  type: "object-delta";
  textDelta: string;
  partialText: string;
}

export interface StreamObjectPartialEvent<TObject = PartialJsonValue> {
  type: "object-partial";
  partialObject: TObject;
}

export interface StreamObjectCompleteEvent<TObject = JsonValue> {
  type: "object-complete";
  object: TObject;
}

export type ObjectStreamEvent<TObject = JsonValue, TPartialObject = PartialJsonValue> =
  | StreamEvent
  | StreamObjectDeltaEvent
  | StreamObjectPartialEvent<TPartialObject>
  | StreamObjectCompleteEvent<TObject>;

export interface GenerateResult {
  message?: ModelMessage;
  messages?: ModelMessage[];
  text?: string;
  audio?: GeneratedMedia[];
  images?: GeneratedMedia[];
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  rawResponse?: unknown;
}
