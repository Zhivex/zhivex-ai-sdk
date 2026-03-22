import type {
  GenerateTextOutput,
  ModelMessage,
  StreamEvent,
  StreamTextResult,
  UIMessage,
  UIMessageChunk
} from "./types.js";

const randomId = () => `msg_${Math.random().toString(36).slice(2, 10)}`;

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
  source: StreamTextResult | AsyncIterable<StreamEvent>,
  messageId: string = randomId()
): AsyncIterable<UIMessageChunk> => {
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
    }
  })();
};

export const collectUIMessage = (result: GenerateTextOutput, messageId: string = randomId()): UIMessage =>
  toUIMessage(result.messages.at(-1) ?? { role: "assistant", parts: [] }, messageId);
