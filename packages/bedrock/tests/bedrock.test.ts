import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTextMessage, generateText } from "@zhivex-ai/core";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";

const { sendMock, clientMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  clientMock: vi.fn()
}));

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

  return {
    BedrockRuntimeClient,
    ConverseCommand
  };
});

import { createBedrock } from "../src/index.ts";

describe("bedrock adapter", () => {
  runLanguageModelContractSuite({
    providerName: "bedrock",
    modelId: "anthropic.claude-3-5-sonnet",
    createModel: () => createBedrock({ region: "us-east-1" })("anthropic.claude-3-5-sonnet"),
    expectedCapabilities: {
      streaming: false,
      tools: false,
      structuredOutput: false,
      jsonMode: false,
      toolChoice: false,
      parallelToolCalls: false,
      vision: true,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: false,
      webSearch: false
    }
  });

  beforeEach(() => {
    sendMock.mockReset();
    clientMock.mockClear();
  });

  it("maps generated text into the common contract", async () => {
    sendMock.mockResolvedValueOnce({
      stopReason: "end_turn",
      output: {
        message: {
          content: [{ text: "hello from bedrock" }]
        }
      },
      usage: {
        inputTokens: 4,
        outputTokens: 3,
        totalTokens: 7
      }
    });

    const provider = createBedrock({ region: "us-east-1" });
    const result = await generateText({
      model: provider("anthropic.claude-3-5-sonnet"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from bedrock");
    expect(result.usage?.totalTokens).toBe(7);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createBedrock({ region: "us-east-1" });

    expect(provider("anthropic.claude-3-5-sonnet")).toMatchObject(provider.languageModel("anthropic.claude-3-5-sonnet"));
  });

  it("maps multimodal user content with image data urls", async () => {
    sendMock.mockResolvedValueOnce({
      stopReason: "end_turn",
      output: { message: { content: [{ text: "done" }] } }
    });

    const provider = createBedrock({ region: "us-east-1" });
    await generateText({
      model: provider("amazon.nova-lite-v1:0"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "describe" },
            {
              type: "image",
              image: "data:image/png;base64,aGVsbG8=",
              mediaType: "image/png"
            }
          ]
        }
      ]
    });

    const command = sendMock.mock.calls[0]?.[0] as { input: { messages: Array<{ content: unknown[] }> } };
    expect(command.input.messages[0]?.content).toHaveLength(2);
  });

  it("surfaces invalid model-style errors as validation errors", async () => {
    sendMock.mockRejectedValueOnce({
      message: "The provided model identifier is invalid.",
      $metadata: { httpStatusCode: 400 }
    });

    const provider = createBedrock({ region: "us-east-1" });

    await expect(
      generateText({
        model: provider("bad-model"),
        messages: [createTextMessage("user", "hello")]
      })
    ).rejects.toThrow("invalid");
  });

  it("passes provider-specific options through to Bedrock", async () => {
    sendMock.mockResolvedValueOnce({
      stopReason: "end_turn",
      output: {
        message: {
          content: [{ text: "hello from bedrock" }]
        }
      }
    });

    const provider = createBedrock({ region: "us-east-1" });
    await generateText({
      model: provider("anthropic.claude-3-5-sonnet"),
      prompt: "hello",
      providerOptions: {
        additionalModelResponseFieldPaths: ["/stop_sequence"]
      }
    });

    const command = sendMock.mock.calls[0]?.[0] as { input: { additionalModelResponseFieldPaths?: string[] } };
    expect(command.input.additionalModelResponseFieldPaths).toEqual(["/stop_sequence"]);
  });
});
