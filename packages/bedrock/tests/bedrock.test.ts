import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTextMessage, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";

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

  return {
    BedrockRuntimeClient,
    ConverseCommand,
    ConverseStreamCommand
  };
});

import { createBedrock } from "../src/index.ts";

describe("bedrock adapter", () => {
  runLanguageModelContractSuite({
    providerName: "bedrock",
    modelId: "anthropic.claude-3-5-sonnet",
    createModel: () => createBedrock({ region: "us-east-1" })("anthropic.claude-3-5-sonnet"),
    expectedAgentTier: "tier-c",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: true,
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

  runAgentProviderContractSuite({
    providerName: "bedrock",
    modelId: "anthropic.claude-3-5-sonnet",
    expectedAgentTier: "tier-c",
    createModel: () => createBedrock({ region: "us-east-1" })("anthropic.claude-3-5-sonnet"),
    mockSimpleRun: () => {
      sendMock.mockResolvedValueOnce({
        stopReason: "end_turn",
        output: {
          message: {
            content: [{ text: "hello from bedrock agent" }]
          }
        }
      });
    },
    mockToolRun: () => {
      sendMock.mockResolvedValueOnce({
        stopReason: "tool_use",
        output: {
          message: {
            content: [
              {
                toolUse: {
                  toolUseId: "tool-1",
                  name: "weather",
                  input: { city: "Madrid" }
                }
              }
            ]
          }
        }
      });
      sendMock.mockResolvedValueOnce({
        stopReason: "end_turn",
        output: {
          message: {
            content: [{ text: "Madrid is sunny" }]
          }
        }
      });
    },
    mockStreamRun: () => {
      sendMock.mockResolvedValueOnce({
        stream: (async function* () {
          yield {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: {
                text: "hello"
              }
            }
          };
          yield {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: {
                text: " world"
              }
            }
          };
          yield {
            messageStop: {
              stopReason: "end_turn"
            }
          };
        })()
      });
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

  it("supports tool calls through the common multi-step loop", async () => {
    sendMock.mockResolvedValueOnce({
      stopReason: "tool_use",
      output: {
        message: {
          content: [
            {
              toolUse: {
                toolUseId: "tool-1",
                name: "weather",
                input: { city: "Madrid" }
              }
            }
          ]
        }
      }
    });
    sendMock.mockResolvedValueOnce({
      stopReason: "end_turn",
      output: {
        message: {
          content: [{ text: "Sunny in Madrid" }]
        }
      }
    });

    const provider = createBedrock({ region: "us-east-1" });
    const result = await generateText({
      model: provider("anthropic.claude-3-5-sonnet"),
      prompt: "weather",
      maxSteps: 2,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 26 })
        })
      }
    });

    expect(result.text).toBe("Sunny in Madrid");
    expect(result.toolResults[0]?.toolName).toBe("weather");

    const secondCommand = sendMock.mock.calls[1]?.[0] as {
      input: { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    };
    expect(secondCommand.input.messages.at(-1)?.role).toBe("user");
    expect(secondCommand.input.messages.at(-1)?.content[0]).toMatchObject({
      toolResult: {
        toolUseId: "tool-1"
      }
    });
  });

  it("supports native structured output through Bedrock outputConfig", async () => {
    sendMock.mockResolvedValueOnce({
      stopReason: "end_turn",
      output: {
        message: {
          content: [{ text: JSON.stringify({ title: "Soup" }) }]
        }
      }
    });

    const provider = createBedrock({ region: "us-east-1" });
    const result = await generateObject({
      model: provider("anthropic.claude-3-5-sonnet"),
      prompt: "Return JSON",
      schema: z.object({
        title: z.string()
      }),
      mode: "native"
    });

    expect(result.object).toEqual({ title: "Soup" });
    expect(result.objectMode).toBe("native");

    const command = sendMock.mock.calls[0]?.[0] as {
      input: {
        outputConfig?: {
          textFormat?: {
            type: string;
            structure: {
              jsonSchema: {
                schema: string;
                name: string;
              };
            };
          };
        };
      };
    };
    expect(command.input.outputConfig?.textFormat).toMatchObject({
      type: "json_schema",
      structure: {
        jsonSchema: {
          name: "response"
        }
      }
    });
    expect(JSON.parse(command.input.outputConfig?.textFormat?.structure.jsonSchema.schema ?? "{}")).toMatchObject({
      type: "object"
    });
  });

  it("maps common tool choice to Bedrock toolConfig", async () => {
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
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city })
        })
      },
      toolChoice: {
        type: "tool",
        toolName: "weather"
      }
    });

    const command = sendMock.mock.calls[0]?.[0] as {
      input: { toolConfig?: { toolChoice?: { tool: { name: string } } } };
    };
    expect(command.input.toolConfig?.toolChoice).toEqual({
      tool: {
        name: "weather"
      }
    });
  });

  it("rejects common reasoning config for Bedrock", async () => {
    const provider = createBedrock({ region: "us-east-1" });

    await expect(
      generateText({
        model: provider("anthropic.claude-3-5-sonnet"),
        prompt: "hello",
        reasoning: {
          effort: "low"
        }
      })
    ).rejects.toThrow('Model "bedrock/anthropic.claude-3-5-sonnet" does not support reasoning.');
  });

  it("streams tool calls and text through ConverseStream", async () => {
    sendMock.mockResolvedValueOnce({
      stream: (async function* () {
        yield {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: {
              toolUse: {
                toolUseId: "tool-1",
                name: "weather"
              }
            }
          }
        };
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: {
              toolUse: {
                input: "{\"city\":\"Madrid\"}"
              }
            }
          }
        };
        yield {
          contentBlockStop: {
            contentBlockIndex: 0
          }
        };
        yield {
          messageStop: {
            stopReason: "tool_use"
          }
        };
      })()
    });
    sendMock.mockResolvedValueOnce({
      stream: (async function* () {
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: {
              text: "Sunny in Madrid"
            }
          }
        };
        yield {
          messageStop: {
            stopReason: "end_turn"
          }
        };
      })()
    });

    const provider = createBedrock({ region: "us-east-1" });
    const result = streamText({
      model: provider("anthropic.claude-3-5-sonnet"),
      prompt: "weather",
      maxSteps: 2,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 26 })
        })
      }
    });

    expect((await result.collect()).text).toBe("Sunny in Madrid");
  });
});
