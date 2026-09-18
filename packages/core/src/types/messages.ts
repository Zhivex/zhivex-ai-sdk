import type {
  JsonValue,
  MessageRole
} from "./common.js";

export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
  providerMetadata?: Record<string, JsonValue>;
}

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  output?: JsonValue;
  error?: {
    message: string;
    code?: "TOOL_INPUT_VALIDATION_ERROR" | "TOOL_NOT_REGISTERED" | "TOOL_BATCH_NOT_EXECUTED";
    issues?: Array<{ code: string; path: Array<string | number> }>;
  };
  isError: boolean;
  providerMetadata?: Record<string, JsonValue>;
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      toolName: string;
    };

export interface TextPart {
  type: "text";
  text: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface ImagePart {
  type: "image";
  image: string;
  mediaType?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface AudioPart {
  type: "audio";
  data: string | Uint8Array | ArrayBuffer;
  mediaType: string;
  filename?: string;
  format?: string;
  transcript?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface FilePart {
  type: "file";
  data: string;
  mediaType: string;
  filename?: string;
  providerMetadata?: Record<string, JsonValue>;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCall: ToolCall;
}

export interface ToolResultPart {
  type: "tool-result";
  toolResult: ToolExecutionResult;
}

export interface ProviderDataPart {
  type: "provider-data";
  provider: string;
  data: JsonValue;
}

export type ContentPart = TextPart | ImagePart | AudioPart | FilePart | ToolCallPart | ToolResultPart | ProviderDataPart;

export interface ModelMessage {
  role: MessageRole;
  parts: ContentPart[];
}

export type GenerateInputSource =
  | {
      prompt: string;
      messages?: never;
    }
  | {
      prompt?: never;
      messages: ModelMessage[];
    }
  | {
      prompt?: undefined;
      messages?: undefined;
    };
