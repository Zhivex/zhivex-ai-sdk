import type {
  AgentStreamEvent,
  GeneratedMedia,
  GenerateTextOutput,
  JsonValue,
  ModelMessage,
  StreamTextResult,
  UIMessage,
  UIMessageChunk,
  UIMessageGeneratedMedia
} from "./types.js";
import { serializeJsonValue } from "./messages.js";
import { createSecureId } from "#secure-id";

const randomId = () => createSecureId("msg");

export interface UIMessageStreamOptions {
  messageId?: string;
  includeAgentRunFinish?: boolean;
}

const toJsonSafeMetadata = (
  metadata: Record<string, unknown> | undefined
): Record<string, JsonValue> | undefined => {
  if (!metadata) {
    return undefined;
  }

  try {
    const serialized = serializeJsonValue(metadata);
    return typeof serialized === "object" && serialized !== null && !Array.isArray(serialized)
      ? serialized
      : undefined;
  } catch {
    return undefined;
  }
};

const toBase64 = (data: Uint8Array): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }

  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const toUIMessageGeneratedMedia = (media: GeneratedMedia): UIMessageGeneratedMedia => ({
  data: media.data ? toBase64(media.data) : undefined,
  encoding: media.data ? "base64" : undefined,
  uri: media.uri,
  mediaType: media.mediaType,
  text: media.text,
  providerMetadata: toJsonSafeMetadata(media.providerMetadata)
});

export const toUIMessage = (message: ModelMessage, id: string = randomId()): UIMessage => ({
  id,
  role: message.role,
  parts: message.parts
});

export const toUIMessages = (messages: ModelMessage[]): UIMessage[] => messages.map((message) => toUIMessage(message));

export const fromUIMessage = (message: UIMessage): ModelMessage => ({
  role: message.role,
  parts: message.parts
});

export const fromUIMessages = (messages: UIMessage[]): ModelMessage[] => messages.map(fromUIMessage);

export const serializeUIMessage = (message: UIMessage): string => JSON.stringify(message);
export const deserializeUIMessage = (value: string): UIMessage => JSON.parse(value) as UIMessage;

export const toUIMessageStream = (
  source: StreamTextResult | { eventStream: AsyncIterable<AgentStreamEvent> } | AsyncIterable<AgentStreamEvent>,
  messageIdOrOptions: string | UIMessageStreamOptions = {}
): AsyncIterable<UIMessageChunk> => {
  const options = typeof messageIdOrOptions === "string"
    ? { messageId: messageIdOrOptions }
    : messageIdOrOptions;
  const messageId = options.messageId ?? randomId();
  const includeAgentRunFinish = options.includeAgentRunFinish ?? true;
  const eventStream = "eventStream" in source ? source.eventStream : source;

  return (async function* () {
    for await (const event of eventStream) {
      if (event.type === "text-delta") {
        yield {
          type: "text-delta",
          messageId,
          role: "assistant",
          textDelta: event.textDelta
        } satisfies UIMessageChunk;
      }

      if (event.type === "tool-call") {
        yield {
          type: "tool-call",
          messageId,
          role: "assistant",
          toolCall: event.toolCall
        } satisfies UIMessageChunk;
      }

      if (event.type === "tool-result") {
        yield {
          type: "tool-result",
          messageId,
          role: "tool",
          toolResult: event.toolResult
        } satisfies UIMessageChunk;
      }

      if (event.type === "tool-approval-request") {
        yield {
          type: "tool-approval-request",
          messageId,
          role: "assistant",
          approval: event.approval
        } satisfies UIMessageChunk;
      }

      if (event.type === "provider-data") {
        yield {
          type: "provider-data",
          messageId,
          role: "assistant",
          provider: event.provider,
          data: event.data
        } satisfies UIMessageChunk;
      }

      if (event.type === "image-generation") {
        yield {
          type: "image-generation",
          messageId,
          role: "assistant",
          provider: event.provider,
          image: toUIMessageGeneratedMedia(event.image),
          partial: event.partial,
          id: event.id,
          index: event.index,
          providerMetadata: event.providerMetadata
        } satisfies UIMessageChunk;
      }

      if (event.type === "finish") {
        yield {
          type: "finish",
          messageId,
          finishReason: event.finishReason,
          providerFinishReason: event.providerFinishReason,
          usage: event.usage
        } satisfies UIMessageChunk;
      }

      if (event.type === "error") {
        yield {
          type: "error",
          messageId,
          error: {
            message: event.error.message
          }
        } satisfies UIMessageChunk;
      }

      if (event.type === "agent-run-start") {
        yield {
          type: "agent-run-start",
          currentStep: event.currentStep,
          maxSteps: event.maxSteps
        } satisfies UIMessageChunk;
      }

      if (event.type === "agent-step-start") {
        yield {
          type: "agent-step-start",
          stepIndex: event.stepIndex
        } satisfies UIMessageChunk;
      }

      if (event.type === "agent-step-finish") {
        yield {
          type: "agent-step-finish",
          step: event.step
        } satisfies UIMessageChunk;
      }

      if (event.type === "agent-approval-request") {
        yield {
          type: "agent-approval-request",
          approval: event.approval
        } satisfies UIMessageChunk;
      }

      if (event.type === "agent-approval-resolved") {
        yield {
          type: "agent-approval-resolved",
          approval: event.approval
        } satisfies UIMessageChunk;
      }

      if (event.type === "agent-compaction") {
        yield {
          type: "agent-compaction",
          compaction: event.compaction
        } satisfies UIMessageChunk;
      }

      if (event.type === "agent-run-finish" && includeAgentRunFinish) {
        yield {
          type: "agent-run-finish",
          status: event.status,
          state: event.state
        } satisfies UIMessageChunk;
      }
    }
  })();
};

export const collectUIMessage = (result: GenerateTextOutput, messageId: string = randomId()): UIMessage =>
  toUIMessage(result.messages.at(-1) ?? { role: "assistant", parts: [] }, messageId);
