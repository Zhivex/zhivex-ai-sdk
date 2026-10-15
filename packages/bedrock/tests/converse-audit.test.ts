import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  ProviderHTTPError,
  ProviderToolCallError,
  ValidationError,
  createTextMessage,
  generateText,
  streamText,
  tool
} from "@zhivex-ai/core";
import { z } from "zod";

const sendMock = vi.fn();
const clientMock = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient {
    constructor(...args: unknown[]) {
      clientMock(...args);
    }

    send = sendMock;
  }

  class ConverseCommand {
    constructor(readonly input: unknown) {}
  }

  class ConverseStreamCommand {
    constructor(readonly input: unknown) {}
  }

  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand };
});

import { createBedrock } from "../src/index.ts";

const textResponse = (stopReason: string, extra: Record<string, unknown> = {}) => ({
  stopReason,
  output: { message: { content: [{ text: "ok" }] } },
  usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
  ...extra
});

const commandInput = () => (sendMock.mock.calls.at(-1)?.[0] as { input: Record<string, unknown> }).input;

describe("Bedrock Converse audit fixes", () => {
  beforeEach(() => {
    sendMock.mockReset();
    clientMock.mockClear();
  });

  it("retries throttling by exception name and ignores the model wording", async () => {
    sendMock
      .mockRejectedValueOnce({
        name: "ThrottlingException",
        message: "The model is throttled.",
        $metadata: { httpStatusCode: 429 },
        $response: { headers: { "retry-after": "0" } }
      })
      .mockResolvedValueOnce(textResponse("end_turn"));

    const provider = createBedrock({ region: "us-east-1" });
    const result = await generateText({
      model: provider("anthropic.claude-haiku-5-5"),
      prompt: "hello",
      maxRetries: 1,
      retryBackoffMs: 0
    });

    expect(result.text).toBe("ok");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry ValidationException when the message mentions model", async () => {
    sendMock.mockRejectedValueOnce({
      name: "ValidationException",
      message: "The provided model identifier is invalid.",
      $metadata: { httpStatusCode: 400 }
    });

    const provider = createBedrock({ region: "us-east-1" });
    await expect(
      generateText({
        model: provider("bad-model"),
        prompt: "hello",
        maxRetries: 2,
        retryBackoffMs: 0
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("retries ServiceUnavailableException even when the message contains model", async () => {
    sendMock.mockRejectedValueOnce({
      name: "ServiceUnavailableException",
      message: "The model is unavailable.",
      $metadata: { httpStatusCode: 503 }
    });

    const provider = createBedrock({ region: "us-east-1" });
    await expect(
      generateText({
        model: provider("anthropic.claude-haiku-5-5"),
        prompt: "hello",
        maxRetries: 0
      })
    ).rejects.toBeInstanceOf(ProviderHTTPError);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stop_sequence", "stop"],
    ["guardrail_intervened", "content-filter"],
    ["content_filtered", "content-filter"],
    ["model_context_window_exceeded", "length"],
    ["malformed_model_output", "error"],
    ["malformed_tool_use", "error"],
    ["end_turn", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool-calls"]
  ] as const)("maps stopReason %s to %s", async (stopReason, finishReason) => {
    sendMock.mockResolvedValueOnce(textResponse(stopReason));
    const provider = createBedrock({ region: "us-east-1" });
    const result = await generateText({
      model: provider("anthropic.claude-haiku-5-5"),
      prompt: "hello"
    });
    expect(result.finishReason).toBe(finishReason);
    expect(result.providerFinishReason).toBe(stopReason);
  });

  it("keeps tool definitions when toolChoice none follows a tool history", async () => {
    sendMock.mockResolvedValueOnce(textResponse("end_turn"));
    const provider = createBedrock({ region: "us-east-1" });
    const weather = tool({
      name: "weather",
      schema: z.object({ city: z.string() }),
      execute: ({ city }) => ({ city })
    });

    await generateText({
      model: provider("anthropic.claude-haiku-5-5"),
      tools: { weather },
      toolChoice: "none",
      messages: [
        createTextMessage("user", "weather?"),
        {
          role: "assistant",
          parts: [{ type: "tool-call", toolCall: { id: "tool-1", name: "weather", input: { city: "Madrid" } } }]
        },
        {
          role: "tool",
          parts: [{
            type: "tool-result",
            toolResult: { toolCallId: "tool-1", toolName: "weather", output: { city: "Madrid" }, isError: false }
          }]
        }
      ]
    });

    const input = commandInput();
    expect(input.toolConfig).toMatchObject({
      tools: [expect.objectContaining({ toolSpec: expect.objectContaining({ name: "weather" }) })]
    });
    expect((input.toolConfig as { toolChoice?: unknown }).toolChoice).toBeUndefined();
  });

  it("emits one finish with cache usage and round-trips reasoning signatures", async () => {
    sendMock.mockResolvedValueOnce({
      stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "step" } } } };
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-1" } } } };
        yield { contentBlockStop: { contentBlockIndex: 0 } };
        yield { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "done" } } };
        yield { contentBlockStop: { contentBlockIndex: 1 } };
        yield { messageStop: { stopReason: "stop_sequence" } };
        yield {
          metadata: {
            usage: {
              inputTokens: 8,
              outputTokens: 4,
              totalTokens: 12,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 1
            }
          }
        };
      })()
    });

    const model = createBedrock({ region: "us-east-1" })("anthropic.claude-sonnet-5-5");
    const events = [];
    for await (const event of await model.stream!({
      messages: [createTextMessage("user", "think")],
      reasoning: { effort: "high" }
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "finish")).toEqual([
      {
        type: "finish",
        finishReason: "stop",
        providerFinishReason: "stop_sequence",
        usage: {
          inputTokens: 8,
          outputTokens: 4,
          totalTokens: 12,
          cachedInputTokens: 3,
          cacheWriteTokens: 1
        }
      }
    ]);
    expect(events).toContainEqual({
      type: "provider-data",
      provider: "bedrock",
      data: { type: "reasoning_delta", text: "step" }
    });
    expect(events).toContainEqual({
      type: "provider-data",
      provider: "bedrock",
      data: {
        type: "reasoning_content",
        replay: true,
        reasoningText: { text: "step", signature: "sig-1" }
      }
    });
    expect(commandInput().additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" }
    });
  });

  it("replays a stored reasoning signature on the next Converse turn", async () => {
    sendMock.mockResolvedValueOnce(textResponse("end_turn"));
    const provider = createBedrock({ region: "us-east-1" });
    await generateText({
      model: provider("anthropic.claude-sonnet-5-5"),
      messages: [
        createTextMessage("user", "think"),
        {
          role: "assistant",
          parts: [
            {
              type: "provider-data",
              provider: "bedrock",
              data: {
                type: "reasoning_content",
                replay: true,
                reasoningText: { text: "step", signature: "sig-1" }
              }
            },
            { type: "text", text: "done" }
          ]
        },
        createTextMessage("user", "continue")
      ]
    });

    const messages = commandInput().messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[1]?.content[0]).toMatchObject({
      reasoningContent: { reasoningText: { text: "step", signature: "sig-1" } }
    });
  });

  it("refuses to emit a tool call when the streamed input is not JSON", async () => {
    sendMock.mockResolvedValueOnce({
      stream: (async function* () {
        yield {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "tool-1", name: "weather" } }
          }
        };
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{" } } } };
        yield { contentBlockStop: { contentBlockIndex: 0 } };
        yield { messageStop: { stopReason: "tool_use" } };
      })()
    });

    const model = createBedrock({ region: "us-east-1" })("anthropic.claude-haiku-5-5");
    const events = [];
    await expect((async () => {
      for await (const event of await model.stream!({ messages: [createTextMessage("user", "weather")] })) {
        events.push(event);
      }
    })()).rejects.toMatchObject({
      name: "ProviderToolCallError",
      reason: "invalid_json",
      diagnosticCode: "BEDROCK_MALFORMED_TOOL_USE",
      effectsPossible: false
    });
    expect(events.some((event) => event.type === "tool-call")).toBe(false);
  });

  it("marks a mid-stream fault as effects possible after a tool call was released", async () => {
    sendMock.mockResolvedValueOnce({
      stream: (async function* () {
        yield {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "tool-1", name: "weather" } }
          }
        };
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: "{\"city\":\"Madrid\"}" } }
          }
        };
        yield { contentBlockStop: { contentBlockIndex: 0 } };
        yield { throttlingException: { message: "The model is throttled." } };
      })()
    });

    const model = createBedrock({ region: "us-east-1" })("anthropic.claude-haiku-5-5");
    const events = [];
    await expect((async () => {
      for await (const event of await model.stream!({ messages: [createTextMessage("user", "weather")] })) {
        events.push(event);
      }
    })()).rejects.toMatchObject({
      name: "ProviderToolCallError",
      reason: "stream_truncated",
      effectsPossible: true,
      retryable: false
    });
    expect(events.some((event) => event.type === "tool-call")).toBe(true);
  });

  it("fails when the stream ends without messageStop", async () => {
    sendMock.mockResolvedValueOnce({
      stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } };
      })()
    });

    const model = createBedrock({ region: "us-east-1" })("anthropic.claude-haiku-5-5");
    await expect((async () => {
      for await (const event of await model.stream!({ messages: [createTextMessage("user", "hello")] })) {
        // drain
      }
    })()).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("emits a single finish when messageStop arrives without metadata", async () => {
    sendMock.mockResolvedValueOnce({
      stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "done" } } };
        yield { messageStop: { stopReason: "end_turn" } };
      })()
    });

    const model = createBedrock({ region: "us-east-1" })("anthropic.claude-haiku-5-5");
    const events = [];
    for await (const event of await model.stream!({ messages: [createTextMessage("user", "hello")] })) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "finish")).toHaveLength(1);
  });

  it("configures region, credentials, and profile without requiring AWS_REGION", () => {
    const credentials = async () => ({ accessKeyId: "ak", secretAccessKey: "sk" });
    createBedrock({ profile: "dev", credentials });
    expect(clientMock).toHaveBeenCalledWith({
      maxAttempts: 1,
      profile: "dev",
      credentials
    });
    expect(clientMock.mock.calls[0]?.[0]).not.toHaveProperty("region");
  });

  it("maps Nova 2 reasoning effort and rejects high with temperature", async () => {
    sendMock.mockResolvedValueOnce(textResponse("end_turn"));
    const provider = createBedrock({ region: "us-east-1" });
    await generateText({
      model: provider("amazon.nova-2-lite-v1:0"),
      prompt: "hello",
      reasoning: { effort: "medium" }
    });
    expect(commandInput().additionalModelRequestFields).toEqual({
      reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" }
    });

    await expect(
      generateText({
        model: provider("amazon.nova-2-lite-v1:0"),
        prompt: "hello",
        temperature: 0.2,
        reasoning: { effort: "high" }
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts DeepSeek R1 reasoning without extra request fields and keeps the block", async () => {
    sendMock.mockResolvedValueOnce({
      stopReason: "end_turn",
      output: {
        message: {
          content: [
            { reasoningContent: { reasoningText: { text: "chain", signature: "r1" } } },
            { text: "answer" }
          ]
        }
      }
    });
    const provider = createBedrock({ region: "us-east-1" });
    const result = await generateText({
      model: provider("deepseek.r1-v1:0"),
      prompt: "hello",
      reasoning: { effort: "low" }
    });
    expect(commandInput().additionalModelRequestFields).toBeUndefined();
    expect(result.messages?.find((message) => message.role === "assistant")?.parts[0]).toMatchObject({
      type: "provider-data",
      data: { type: "reasoning_content", replay: true, reasoningText: { signature: "r1" } }
    });
  });

  it("lets caller additionalModelRequestFields override generated thinking", async () => {
    sendMock.mockResolvedValueOnce(textResponse("end_turn"));
    const provider = createBedrock({ region: "us-east-1" });
    await generateText({
      model: provider("anthropic.claude-sonnet-5-5"),
      prompt: "hello",
      reasoning: { effort: "low" },
      providerOptions: {
        additionalModelRequestFields: { thinking: { type: "disabled" } }
      }
    });
    expect(commandInput().additionalModelRequestFields).toEqual({
      thinking: { type: "disabled" },
      output_config: { effort: "low" }
    });
  });

  it("accepts adaptive Claude effort max through generateText and streamText", async () => {
    sendMock.mockResolvedValueOnce(textResponse("end_turn"));
    const provider = createBedrock({ region: "us-east-1" });
    const model = provider("us.anthropic.claude-sonnet-5-5");
    expect(model.capabilities.reasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(model.capabilities.reasoningModes).toBeUndefined();
    expect(model.capabilities.reasoningContexts).toBeUndefined();
    expect(provider("anthropic.claude-fable-5").capabilities.reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
    expect(provider("amazon.nova-2-lite-v1:0").capabilities.reasoningEfforts).toEqual([
      "none",
      "low",
      "medium",
      "high"
    ]);

    await generateText({ model, prompt: "hello", reasoning: { effort: "max" } });
    expect(commandInput().additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "max" }
    });

    sendMock.mockResolvedValueOnce({
      stream: (async function* () {
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } };
        yield { messageStop: { stopReason: "end_turn" } };
      })()
    });
    await streamText({ model, prompt: "hello", reasoning: { effort: "max" } }).collect();
    expect(commandInput().additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "max" }
    });
  });
});
