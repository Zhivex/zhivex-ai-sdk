import { UnsupportedFeatureError } from "./errors.js";
import type {
  ContentPart,
  FinishReason,
  GenerateResult,
  JsonValue,
  LanguageModel,
  ModelMessage,
  StreamEvent,
  ToolCall,
  ToolExecutionResult
} from "./types.js";

export const textPart = (text: string): ContentPart => ({ type: "text", text });

export const toolCallPart = (toolCall: ToolCall): ContentPart => ({
  type: "tool-call",
  toolCall
});

export const toolResultPart = (toolResult: ToolExecutionResult): ContentPart => ({
  type: "tool-result",
  toolResult
});

export const createTextMessage = (role: ModelMessage["role"], text: string): ModelMessage => ({
  role,
  parts: [textPart(text)]
});

export const getTextFromParts = (parts: ContentPart[]): string =>
  parts
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");

export const getTextFromMessages = (messages: ModelMessage[]): string =>
  messages
    .filter((message) => message.role === "assistant")
    .map((message) => getTextFromParts(message.parts))
    .join("");

export const serializeJsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const normalizeFinishReason = (reason: string | undefined | null): FinishReason | undefined => {
  if (!reason) {
    return undefined;
  }

  switch (reason.toLowerCase()) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "tool_use":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    case "error":
      return "error";
    default:
      return "unknown";
  }
};

export const resultMessages = (result: GenerateResult): ModelMessage[] => {
  if (result.messages?.length) {
    return result.messages;
  }
  if (result.message) {
    return [result.message];
  }
  if (result.text) {
    return [createTextMessage("assistant", result.text)];
  }
  return [];
};

export const validateMessageParts = (model: LanguageModel, messages: ModelMessage[]) => {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "image" && !model.capabilities.vision) {
        throw new UnsupportedFeatureError(
          `Model "${model.provider}/${model.modelId}" does not support image inputs.`
        );
      }

      if (part.type === "file" && !model.capabilities.files) {
        throw new UnsupportedFeatureError(
          `Model "${model.provider}/${model.modelId}" does not support file inputs.`
        );
      }

      if (part.type === "tool-call" || part.type === "tool-result") {
        if (!model.capabilities.tools) {
          throw new UnsupportedFeatureError(
            `Model "${model.provider}/${model.modelId}" does not support tool calling.`
          );
        }
      }
    }
  }
};

export const getToolCallsFromEvents = (events: StreamEvent[]): ToolCall[] =>
  events
    .filter((event): event is Extract<StreamEvent, { type: "tool-call" }> => event.type === "tool-call")
    .map((event) => event.toolCall);
