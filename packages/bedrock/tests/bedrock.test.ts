import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createAgent,
  createTextMessage,
  generateObject,
  generateText,
  getAgentCapabilities,
  hostedTool,
  runAgent,
  streamText,
  tool
} from "@zhivex-ai/core";
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

import {
  bedrockCodeExecutionTool,
  bedrockMcpApprovalResponse,
  bedrockRemoteMcpTool,
  bedrockServerTool,
  bedrockWebSearchTool,
  createBedrockAgentCoreMcpClient,
  createBedrockAgentCoreMcpToolSet,
  createBedrock
} from "../src/index.ts";

describe("bedrock adapter", () => {
  const fetchMock = vi.fn();

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

  runLanguageModelContractSuite({
    providerName: "bedrock",
    modelId: "openai.gpt-oss-120b-1:0",
    createModel: () =>
      createBedrock({
        runtime: "openai",
        apiKey: "test",
        baseURL: "https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1",
        fetch: fetchMock as typeof fetch
      })("openai.gpt-oss-120b-1:0"),
    expectedAgentTier: "tier-a",
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
      reasoning: true,
      webSearch: true
    }
  });

  runAgentProviderContractSuite({
    providerName: "bedrock",
    modelId: "openai.gpt-oss-120b-1:0",
    expectedAgentTier: "tier-a",
    createModel: () =>
      createBedrock({
        runtime: "openai",
        apiKey: "test",
        baseURL: "https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1",
        fetch: fetchMock as typeof fetch
      })("openai.gpt-oss-120b-1:0"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "resp_1",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hello from bedrock agent" }] }]
        })
      );
    },
    mockToolRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "resp_1",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "tool-1",
              name: "weather",
              arguments: JSON.stringify({ city: "Madrid" })
            }
          ]
        })
      );
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "resp_2",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Madrid is sunny" }] }]
        })
      );
    },
    mockStreamRun: () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
                'data: {"type":"response.output_text.delta","delta":" world"}\n\n' +
                'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n' +
                "data: [DONE]\n\n"
            )
          );
          controller.close();
        }
      });

      fetchMock.mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      );
    },
    mockApprovalRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "resp_approval",
          status: "completed",
          output: [
            {
              type: "mcp_approval_request",
              id: "mcpr_1",
              arguments: "{}",
              name: "fetch_docs",
              server_label: "docs"
            }
          ]
        })
      );
    },
    mockApprovalResume: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "resp_done",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "approved by bedrock" }] }]
        })
      );
    },
    createApprovalTools: () => ({
      docs: bedrockRemoteMcpTool({
        server_label: "docs",
        server_url: "https://example.com/mcp"
      })
    })
  });

  beforeEach(() => {
    sendMock.mockReset();
    clientMock.mockClear();
    fetchMock.mockReset();
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

  it("passes explicit Bedrock API keys to the native Converse client as a bearer token", () => {
    createBedrock({ region: "us-east-1", apiKey: "bedrock-key" });

    expect(clientMock).toHaveBeenCalledWith({
      region: "us-east-1",
      token: { token: "bedrock-key" }
    });
  });

  it("uses an injected native Converse client without adding API key configuration", () => {
    const client = { send: sendMock } as never;

    createBedrock({ client, region: "us-east-1", apiKey: "bedrock-key" });

    expect(clientMock).not.toHaveBeenCalled();
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

  it("omits Converse tools when common tool choice is none", async () => {
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
      toolChoice: "none"
    });

    const command = sendMock.mock.calls[0]?.[0] as {
      input: { toolConfig?: unknown };
    };
    expect(command.input.toolConfig).toBeUndefined();
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

  it("uses Bedrock OpenAI-compatible Responses mode when requested", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "hello from mantle" }] }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
      })
    );

    const provider = createBedrock({
      runtime: "openai",
      apiKey: "test",
      baseURL: "https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateText({
      model: provider("openai.gpt-oss-120b-1:0"),
      prompt: "hello",
      tools: {
        notes: bedrockServerTool({
          name: "notes",
          type: "server_tool",
          config: { id: "notes" }
        })
      }
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { tools: Array<Record<string, unknown>> };
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1/responses");
    expect(body.tools).toEqual([expect.objectContaining({ type: "server_tool", id: "notes" })]);
    expect(result.text).toBe("hello from mantle");
  });

  it("maps typed Bedrock hosted tools and marks OpenAI-compatible runtime as Tier A", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
      })
    );

    const provider = createBedrock({
      runtime: "openai",
      apiKey: "test",
      baseURL: "https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("openai.gpt-oss-120b-1:0"),
      prompt: "inspect",
      tools: {
        web: bedrockWebSearchTool({ search_context_size: "small" }),
        code: bedrockCodeExecutionTool({ container: { type: "auto" } }),
        mcp: bedrockRemoteMcpTool({
          server_label: "docs",
          server_url: "https://example.com/mcp"
        })
      }
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { tools: Array<Record<string, unknown>> };
    expect(body.tools).toEqual(
      expect.arrayContaining([
        { type: "web_search", search_context_size: "small" },
        { type: "code_interpreter", container: { type: "auto" } },
        expect.objectContaining({ type: "mcp", server_label: "docs", server_url: "https://example.com/mcp" })
      ])
    );

    const capabilities = getAgentCapabilities(provider("openai.gpt-oss-120b-1:0"));
    expect(capabilities.supportTier).toBe("tier-a");
    expect(capabilities.approvalRequests).toBe(true);
    expect(capabilities.remoteMcp).toBe(true);
    expect(capabilities.codeExecution).toBe(true);
  });

  it("rejects non-Bedrock hosted tools in OpenAI-compatible Responses mode", async () => {
    const provider = createBedrock({
      runtime: "openai",
      apiKey: "test",
      baseURL: "https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1",
      fetch: fetchMock as typeof fetch
    });

    await expect(
      generateText({
        model: provider("openai.gpt-oss-120b-1:0"),
        prompt: "hello",
        tools: {
          web: hostedTool({
            name: "web",
            provider: "openai",
            type: "web_search"
          })
        }
      })
    ).rejects.toThrow('Provider "bedrock" does not support hosted tools declared for provider "openai".');
  });

  it("parses Bedrock MCP approval requests and serializes approval responses", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          id: "resp_approval",
          status: "completed",
          output: [
            {
              type: "mcp_approval_request",
              id: "mcpr_1",
              arguments: "{}",
              name: "fetch_docs",
              server_label: "docs"
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "resp_done",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "approved" }] }]
        })
      );

    const provider = createBedrock({
      runtime: "openai",
      apiKey: "test",
      baseURL: "https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1",
      fetch: fetchMock as typeof fetch
    });
    const first = await generateText({
      model: provider("openai.gpt-oss-120b-1:0"),
      prompt: "Use MCP",
      tools: {
        docs: bedrockRemoteMcpTool({
          server_label: "docs",
          server_url: "https://example.com/mcp"
        })
      }
    });
    expect(first.messages.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider-data",
          provider: "bedrock",
          data: expect.objectContaining({ type: "mcp_approval_request", id: "mcpr_1" })
        })
      ])
    );

    const approval = bedrockMcpApprovalResponse({
      approval_request_id: "mcpr_1",
      approve: true
    });
    await generateText({
      model: provider("openai.gpt-oss-120b-1:0"),
      messages: [...first.messages, { role: "user", parts: [approval] }]
    });

    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(secondRequest.body)) as {
      previous_response_id?: string;
      input: Array<Record<string, unknown>>;
    };
    expect(body.previous_response_id).toBe("resp_approval");
    expect(body.input).toEqual([
      {
        type: "mcp_approval_response",
        approval_request_id: "mcpr_1",
        approve: true
      }
    ]);
  });

  it("streams Bedrock OpenAI-compatible approval provider-data events", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_item.done","item":{"type":"mcp_approval_request","id":"mcpr_1","arguments":"{}","name":"fetch_docs","server_label":"docs"}}\n\n' +
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n' +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createBedrock({
      runtime: "openai",
      apiKey: "test",
      baseURL: "https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1",
      fetch: fetchMock as typeof fetch
    });
    const result = streamText({
      model: provider("openai.gpt-oss-120b-1:0"),
      prompt: "Use MCP",
      tools: {
        docs: bedrockRemoteMcpTool({
          server_label: "docs",
          server_url: "https://example.com/mcp"
        })
      }
    });

    const events = [];
    for await (const event of result.eventStream) {
      events.push(event);
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider-data",
          provider: "bedrock",
          data: expect.objectContaining({ type: "mcp_approval_request", id: "mcpr_1" })
        })
      ])
    );
  });

  it("serializes local tool results in Bedrock OpenAI-compatible Responses mode", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          id: "resp_1",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_weather",
              name: "weather",
              arguments: JSON.stringify({ city: "Madrid" })
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "resp_2",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Sunny in Madrid" }] }]
        })
      );

    const provider = createBedrock({
      runtime: "openai",
      apiKey: "test",
      baseURL: "https://bedrock-mantle.us-east-1.amazonaws.com/openai/v1",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateText({
      model: provider("openai.gpt-oss-120b-1:0"),
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

    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(secondRequest.body)) as { input: Array<Record<string, unknown>> };
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_weather",
          output: JSON.stringify({ city: "Madrid", temperatureC: 26 })
        })
      ])
    );
    expect(result.text).toBe("Sunny in Madrid");
  });

  it("calls AgentCore MCP tools through a runtime ARN endpoint and preserves session headers", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            jsonrpc: "2.0",
            id: "1",
            result: {
              tools: [
                {
                  name: "fetch_docs",
                  description: "Fetch docs",
                  inputSchema: {
                    type: "object",
                    properties: {
                      path: { type: "string" }
                    },
                    required: ["path"]
                  }
                }
              ]
            }
          },
          {
            headers: {
              "Mcp-Session-Id": "session-from-agentcore"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: "2.0",
          id: "2",
          result: {
            structuredContent: { title: "README" },
            content: [{ type: "text", text: "docs body" }]
          }
        })
      );

    const client = createBedrockAgentCoreMcpClient({
      runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_mcp_server-xyz123",
      region: "us-west-2",
      bearerToken: "token-123",
      headers: {
        "X-Team": "platform"
      },
      sessionId: "initial-session",
      fetch: fetchMock as typeof fetch
    });

    const listed = await client.listTools();
    const result = await client.callTool({
      name: "fetch_docs",
      arguments: { path: "README.md" }
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aruntime%2Fmy_mcp_server-xyz123/invocations?qualifier=DEFAULT"
    );
    const firstRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(firstRequest.headers).toMatchObject({
      Authorization: "Bearer token-123",
      "X-Team": "platform",
      "Mcp-Session-Id": "initial-session"
    });
    expect(JSON.parse(String(firstRequest.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/list"
    });

    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(secondRequest.headers).toMatchObject({
      "Mcp-Session-Id": "session-from-agentcore"
    });
    expect(JSON.parse(String(secondRequest.body))).toMatchObject({
      method: "tools/call",
      params: {
        name: "fetch_docs",
        arguments: { path: "README.md" }
      }
    });
    expect(listed).toEqual({
      tools: [
        expect.objectContaining({
          name: "fetch_docs",
          description: "Fetch docs"
        })
      ]
    });
    expect(result).toEqual({
      structuredContent: { title: "README" },
      content: [{ type: "text", text: "docs body" }]
    });
  });

  it("uses an explicit AgentCore MCP endpoint and authorization header for ToolSet conversion", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        jsonrpc: "2.0",
        id: "1",
        result: {
          tools: [
            {
              name: "search",
              description: "Search docs",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" }
                },
                required: ["query"]
              }
            }
          ]
        }
      })
    );

    const tools = await createBedrockAgentCoreMcpToolSet(
      {
        endpoint: "https://gateway-id.gateway.bedrock-agentcore.us-east-1.amazonaws.com/docs/invocations",
        authorization: "Bearer explicit-token",
        fetch: fetchMock as typeof fetch
      },
      {
        toolNamePrefix: "agentcore_"
      }
    );

    expect(Object.keys(tools)).toEqual(["agentcore_search"]);
    expect(tools.agentcore_search?.metadata).toMatchObject({
      source: "mcp",
      originalName: "search"
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://gateway-id.gateway.bedrock-agentcore.us-east-1.amazonaws.com/docs/invocations"
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer explicit-token"
    });
  });

  it("propagates AgentCore MCP HTTP and JSON-RPC errors", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            message: "unauthorized"
          }
        },
        {
          status: 401
        }
      )
    );

    const client = createBedrockAgentCoreMcpClient({
      endpoint: "https://example.com/mcp",
      authorization: "Bearer token",
      fetch: fetchMock as typeof fetch
    });

    await expect(client.listTools()).rejects.toThrow("Bedrock AgentCore MCP request failed with status 401.");

    fetchMock.mockResolvedValueOnce(
      Response.json({
        jsonrpc: "2.0",
        id: "2",
        error: {
          code: -32601,
          message: "unknown method"
        }
      })
    );

    await expect(client.callTool({ name: "missing" })).rejects.toThrow(
      "Bedrock AgentCore MCP tools/call failed: unknown method."
    );
  });

  it("runs AgentCore MCP ToolSet through the shared agent loop on Bedrock Converse", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: "2.0",
          id: "1",
          result: {
            tools: [
              {
                name: "fetch_docs",
                description: "Fetch docs",
                inputSchema: {
                  type: "object",
                  properties: {
                    path: { type: "string" }
                  },
                  required: ["path"]
                },
                annotations: {
                  readOnlyHint: true
                }
              }
            ]
          }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: "2.0",
          id: "2",
          result: {
            structuredContent: { title: "README" },
            content: [{ type: "text", text: "docs body" }]
          }
        })
      );
    sendMock
      .mockResolvedValueOnce({
        stopReason: "tool_use",
        output: {
          message: {
            content: [
              {
                toolUse: {
                  toolUseId: "tool-1",
                  name: "agentcore_fetch_docs",
                  input: { path: "README.md" }
                }
              }
            ]
          }
        }
      })
      .mockResolvedValueOnce({
        stopReason: "end_turn",
        output: {
          message: {
            content: [{ text: "README says docs body" }]
          }
        }
      });

    const agentcoreTools = await createBedrockAgentCoreMcpToolSet(
      {
        endpoint: "https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/runtime/invocations?qualifier=DEFAULT",
        bearerToken: "token",
        fetch: fetchMock as typeof fetch
      },
      {
        toolNamePrefix: "agentcore_"
      }
    );
    const result = await runAgent(
      createAgent({
        model: createBedrock({ region: "us-east-1" })("anthropic.claude-3-5-sonnet"),
        tools: agentcoreTools,
        maxSteps: 2
      }),
      {
        prompt: "Fetch docs"
      }
    );

    expect(result.status).toBe("completed");
    expect(result.outputText).toBe("README says docs body");
    expect(result.toolResults[0]).toMatchObject({
      toolName: "agentcore_fetch_docs",
      output: {
        structuredContent: { title: "README" },
        content: [{ type: "text", text: "docs body" }]
      }
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({
      method: "tools/call",
      params: {
        name: "fetch_docs",
        arguments: { path: "README.md" }
      }
    });
  });
});
