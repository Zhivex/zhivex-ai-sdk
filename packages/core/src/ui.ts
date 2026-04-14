import type {
  AgentStreamEvent,
  GenerateTextOutput,
  ModelMessage,
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
  source: StreamTextResult | { eventStream: AsyncIterable<AgentStreamEvent> } | AsyncIterable<AgentStreamEvent>,
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

      if (event.type === "provider-data") {
        yield {
          type: "provider-data",
          messageId,
          role: "assistant",
          provider: event.provider,
          data: event.data
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

      if (event.type === "agent-run-finish") {
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
