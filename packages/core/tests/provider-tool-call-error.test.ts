import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createTextMessage,
  generateText,
  ProviderToolCallError,
  streamText,
  tool,
  type GenerateResult,
  type LanguageModel,
  type StreamEvent
} from "../src/index.js";

const capabilities: LanguageModel["capabilities"] = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

const toolCallResult = (): GenerateResult => ({
  messages: [{
    role: "assistant",
    parts: [{
      type: "tool-call",
      toolCall: { id: "call_1", name: "write", input: { value: "first" } }
    }]
  }],
  finishReason: "tool-calls"
});

const providerFailure = () => new ProviderToolCallError({
  provider: "openai",
  transport: "responses",
  diagnosticCode: "OPENAI_RESPONSES_TOOL_CALL_INVALID",
  reason: "stream_truncated",
  retryable: true
});

describe("ProviderToolCallError", () => {
  it("keeps provider failures retryable before any local tool can have effects", () => {
    const error = providerFailure();

    expect(error).toMatchObject({
      message: "Provider tool call could not be materialized safely.",
      category: "provider-tool-call",
      retryable: true,
      effectsPossible: false
    });
  });

  it("marks later generateText provider failures non-retryable after local execution starts", async () => {
    let modelCalls = 0;
    const execute = vi.fn(({ value }: { value: string }) => ({ value }));
    const model: LanguageModel = {
      provider: "test",
      modelId: "effects-generate",
      capabilities,
      async generate() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return toolCallResult();
        }
        throw providerFailure();
      }
    };

    await expect(generateText({
      model,
      prompt: "write",
      maxSteps: 2,
      tools: {
        write: tool({ name: "write", schema: z.object({ value: z.string() }), execute })
      }
    })).rejects.toMatchObject({
      diagnosticCode: "OPENAI_RESPONSES_TOOL_CALL_INVALID",
      reason: "stream_truncated",
      retryable: false,
      effectsPossible: true
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("marks later streamText provider failures non-retryable after local execution starts", async () => {
    let modelCalls = 0;
    const execute = vi.fn(({ value }: { value: string }) => ({ value }));
    const model: LanguageModel = {
      provider: "test",
      modelId: "effects-stream",
      capabilities,
      async generate() {
        return { messages: [createTextMessage("assistant", "unused")], text: "unused" };
      },
      async stream() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return (async function* (): AsyncGenerator<StreamEvent> {
            yield {
              type: "tool-call",
              toolCall: { id: "call_1", name: "write", input: { value: "first" } }
            };
            yield { type: "finish", finishReason: "tool-calls" };
          })();
        }
        return (async function* (): AsyncGenerator<StreamEvent> {
          throw providerFailure();
        })();
      }
    };

    await expect(streamText({
      model,
      prompt: "write",
      maxSteps: 2,
      tools: {
        write: tool({ name: "write", schema: z.object({ value: z.string() }), execute })
      }
    }).collect()).rejects.toMatchObject({
      diagnosticCode: "OPENAI_RESPONSES_TOOL_CALL_INVALID",
      reason: "stream_truncated",
      retryable: false,
      effectsPossible: true
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
