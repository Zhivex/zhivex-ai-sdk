import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  audioPart,
  createTextMessage,
  embed,
  getAgentCapabilities,
  generateGroundedText,
  generateObject,
  generateSpeech,
  generateText,
  hostedTool,
  ProviderHTTPError,
  ProviderResponseTooLargeError,
  streamText,
  tool,
  transcribeAudio
} from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import {
  createOpenAI,
  openAIApplyPatchTool,
  openAICodeInterpreterTool,
  openAIComputerTool,
  openAIComputerUseTool,
  openAIHostedShellTool,
  openAIImageGenerationTool,
  openAIImageGenerationToolChoice,
  openAIMcpApprovalResponse,
  openAIProgrammaticTool,
  openAIProgrammaticToolCallingTool,
  openAIPromptCacheBreakpoint,
  openAIRealtimeMcpApprovalResult,
  openAIRemoteMcpTool,
  openAIShellTool,
  openAIToolSearchTool,
  openAIWebSearchTool
} from "../src/index.js";

describe("openai adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "openai",
    modelId: "gpt-4o-mini",
    createModel: () => createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("gpt-4o-mini"),
    createEmbeddingModel: () =>
      createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch }).embeddingModel("text-embedding-3-small"),
    expectedAgentTier: "tier-a",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: true,
      parallelToolCalls: true,
      vision: true,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: true,
      reasoning: true,
      webSearch: true
    }
  });

  runAgentProviderContractSuite({
    providerName: "openai",
    modelId: "gpt-4o-mini",
    expectedAgentTier: "tier-a",
    createModel: () => createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("gpt-4o-mini"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "hello from openai agent" } }]
        })
      );
    },
    mockToolRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tool-1",
                    function: {
                      name: "weather",
                      arguments: JSON.stringify({ city: "Madrid" })
                    }
                  }
                ]
              }
            }
          ]
        })
      );
      fetchMock.mockResolvedValueOnce(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "Madrid is sunny" } }]
        })
      );
    },
    mockStreamRun: () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}\n\n" +
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
          id: "resp_1",
          status: "completed",
          output: [
            {
              type: "mcp_approval_request",
              id: "mcpr_1",
              arguments: "{}",
              name: "fetch_docs",
              server_label: "github"
            }
          ]
        })
      );
    },
    mockApprovalResume: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "resp_2",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "approved by openai" }]
            }
          ]
        })
      );
    },
    createApprovalTools: () => ({
      github: openAIRemoteMcpTool({
        server_label: "github",
        server_url: "https://example.com/mcp"
      })
    })
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps chat completions to the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from openai" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-4o-mini"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from openai");
    expect(result.usage?.totalTokens).toBe(7);
    expect(result.messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: "hello from openai" });
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("gpt-4o-mini")).toMatchObject(provider.languageModel("gpt-4o-mini"));
  });

  it("streams incremental text", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}\n\n" +
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

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("gpt-4o-mini"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello world");
  });

  it("streams Responses API events for hosted tools", async () => {
    const firstBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"item_1\",\"call_id\":\"call_1\",\"name\":\"weather\",\"arguments\":\"\"}}\n\n" +
              "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item_1\",\"delta\":\"{\\\"city\\\":\\\"Mad\"}\n\n" +
              "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item_1\",\"delta\":\"rid\\\"}\"}\n\n" +
              "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"item_1\",\"arguments\":\"{\\\"city\\\":\\\"Madrid\\\"}\"}\n\n" +
              "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2,\"total_tokens\":6}}}\n\n" +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    const secondBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Madrid \"}\n\n" +
              "data: {\"type\":\"response.output_text.delta\",\"delta\":\"is sunny.\"}\n\n" +
              "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\",\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n" +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });

    fetchMock.mockResolvedValueOnce(
      new Response(firstBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(secondBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("gpt-5"),
      prompt: "Use hosted web search if needed, then weather.",
      maxSteps: 2,
      tools: {
        web: hostedTool({
          name: "web",
          provider: "openai",
          type: "web_search"
        }),
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      }
    });

    expect((await result.collect()).text).toBe("Madrid is sunny.");

    const firstRequest = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { stream: boolean };
    expect(firstRequest.stream).toBe(true);

    const secondRequest = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      previous_response_id?: string;
      input: Array<Record<string, unknown>>;
    };
    expect(secondRequest.previous_response_id).toBe("resp_1");
    expect(secondRequest.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify({ city: "Madrid", forecast: "sunny" })
      }
    ]);
  });

  it("streams decoded image-generation events without persisting partial base64", async () => {
    const partialBytes = new Uint8Array(1_100_000).fill(7);
    const partialBase64 = Buffer.from(partialBytes).toString("base64");
    const finalBytes = new Uint8Array([8, 9, 10]);
    const finalBase64 = Buffer.from(finalBytes).toString("base64");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: "response.image_generation_call.partial_image",
              item_id: "ig_1",
              partial_image_index: 0,
              partial_image_b64: partialBase64
            })}\n\n` +
              `data: ${JSON.stringify({
                type: "response.output_item.done",
                item: {
                  type: "image_generation_call",
                  id: "ig_1",
                  status: "completed",
                  result: finalBase64
                }
              })}\n\n` +
              'data: {"type":"response.completed","response":{"id":"resp_image","status":"completed"}}\n\n' +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("gpt-5.6"),
      prompt: "Draw a harbor",
      tools: { image: openAIImageGenerationTool({ partial_images: 1, output_format: "webp" }) },
      providerOptions: { tool_choice: openAIImageGenerationToolChoice() }
    });
    const events = [];
    for await (const event of result.eventStream) {
      events.push(event);
    }
    const collected = await result.collect();

    const imageEvents = events.filter((event) => event.type === "image-generation");
    expect(imageEvents).toHaveLength(2);
    expect(imageEvents[0]).toMatchObject({
      type: "image-generation",
      provider: "openai",
      partial: true,
      id: "ig_1",
      index: 0,
      image: { mediaType: "image/webp", data: partialBytes }
    });
    expect(imageEvents[1]).toMatchObject({
      type: "image-generation",
      provider: "openai",
      partial: false,
      id: "ig_1",
      image: { mediaType: "image/webp", data: finalBytes }
    });
    expect(JSON.stringify(collected.messages)).not.toContain(partialBase64);
    const providerDataParts = collected.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "provider-data");
    expect(providerDataParts).toHaveLength(2);
    expect(providerDataParts).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ type: "responses_output" }) }),
      expect.objectContaining({ data: { responseId: "resp_image" } })
    ]));
    expect(collected.steps[0]?.response.images?.[0]?.data).toEqual(finalBytes);

    const requestBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(requestBody.tools).toEqual([{ type: "image_generation", partial_images: 1, output_format: "webp" }]);
    expect(requestBody.tool_choice).toEqual({ type: "image_generation" });
  });

  it("rejects a hosted image SSE event above the configured decoded-byte limit", async () => {
    const imageBase64 = Buffer.from([1, 2, 3, 4]).toString("base64");
    fetchMock.mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({
          type: "response.image_generation_call.partial_image",
          item_id: "ig_limit",
          partial_image_index: 0,
          partial_image_b64: imageBase64
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );

    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      responseLimits: { hostedImageEventBytes: 3, hostedImageTotalBytes: 16 }
    });

    await expect(streamText({
      model: provider("gpt-5.6"),
      prompt: "Draw",
      tools: { image: openAIImageGenerationTool({ partial_images: 1 }) }
    }).collect()).rejects.toMatchObject<Partial<ProviderResponseTooLargeError>>({
      maxBytes: 3,
      receivedBytes: 4,
      provider: "openai",
      endpoint: "hosted image generation event"
    });
  });

  it("rejects hosted image SSE data above the configured accumulated limit", async () => {
    const partialBase64 = Buffer.from([1, 2, 3]).toString("base64");
    const finalBase64 = Buffer.from([4, 5, 6]).toString("base64");
    fetchMock.mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({
          type: "response.image_generation_call.partial_image",
          item_id: "ig_total",
          partial_image_index: 0,
          partial_image_b64: partialBase64
        })}\n\n` +
          `data: ${JSON.stringify({
            type: "response.output_item.done",
            item: {
              type: "image_generation_call",
              id: "ig_total",
              status: "completed",
              result: finalBase64
            }
          })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );

    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      responseLimits: { hostedImageEventBytes: 4, hostedImageTotalBytes: 5 }
    });

    await expect(streamText({
      model: provider("gpt-5.6"),
      prompt: "Draw",
      tools: { image: openAIImageGenerationTool({ partial_images: 1 }) }
    }).collect()).rejects.toMatchObject<Partial<ProviderResponseTooLargeError>>({
      maxBytes: 5,
      receivedBytes: 6,
      provider: "openai",
      endpoint: "hosted image generation stream"
    });
  });

  it("validates hosted image response limits before creating a provider", () => {
    expect(() => createOpenAI({
      apiKey: "test",
      responseLimits: { hostedImageEventBytes: 0 }
    })).toThrow('The "hostedImageEventBytes" response limit must be a positive safe integer.');
  });

  it("returns typed hosted image outputs from non-streaming Responses", async () => {
    const imageBytes = new Uint8Array([12, 13, 14]);
    const imageBase64 = Buffer.from(imageBytes).toString("base64");
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_image_nonstream",
        status: "completed",
        output: [
          {
            type: "image_generation_call",
            id: "ig_nonstream",
            status: "completed",
            revised_prompt: "A quiet harbor at dawn",
            result: imageBase64
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-5.6"),
      prompt: "Draw a harbor",
      tools: { image: openAIImageGenerationTool({ output_format: "jpeg" }) },
      providerOptions: { tool_choice: openAIImageGenerationToolChoice() }
    });

    expect(result.steps[0]?.response.images).toEqual([
      expect.objectContaining({
        data: imageBytes,
        mediaType: "image/jpeg",
        text: "A quiet harbor at dawn"
      })
    ]);
    const providerDataParts = result.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "provider-data");
    expect(providerDataParts.filter((part) =>
      typeof part.data === "object" && part.data !== null && "type" in part.data && part.data.type === "responses_output"
    )).toHaveLength(1);
  });

  it("parses remote MCP approval requests from the Responses API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "mcp_approval_request",
            id: "mcpr_1",
            arguments: "{}",
            name: "fetch_docs",
            server_label: "github"
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-5"),
      prompt: "Use MCP",
      tools: {
        github: openAIRemoteMcpTool({
          server_label: "github",
          server_url: "https://example.com/mcp"
        })
      }
    });

    expect(result.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "openai",
      data: {
        type: "mcp_approval_request",
        id: "mcpr_1",
        arguments: "{}",
        name: "fetch_docs",
        server_label: "github"
      }
    });
  });

  it("serializes MCP approval responses back into Responses API input", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: []
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-5"),
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "provider-data",
              provider: "openai",
              data: {
                responseId: "resp_prev"
              }
            }
          ]
        },
        {
          role: "user",
          parts: [
            openAIMcpApprovalResponse({
              approval_request_id: "mcpr_1",
              approve: true
            })
          ]
        }
      ],
      tools: {
        github: openAIRemoteMcpTool({
          server_label: "github",
          server_url: "https://example.com/mcp",
          authorization: "Bearer token",
          server_description: "Docs server",
          allowed_tools: {
            read_only: true,
            tool_names: ["fetch_docs"]
          },
          require_approval: {
            never: {
              read_only: true
            }
          }
        })
      }
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      previous_response_id: string;
      input: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
    expect(body.previous_response_id).toBe("resp_prev");
    expect(body.input).toContainEqual({
      type: "mcp_approval_response",
      approval_request_id: "mcpr_1",
      approve: true
    });
    expect(body.tools[0]).toMatchObject({
      type: "mcp",
      server_label: "github",
      server_url: "https://example.com/mcp",
      authorization: "Bearer token",
      server_description: "Docs server",
      allowed_tools: {
        read_only: true,
        tool_names: ["fetch_docs"]
      },
      require_approval: {
        never: {
          read_only: true
        }
      }
    });
  });

  it("supports tool calls and native structured output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "tool-1",
                  function: {
                    name: "weather",
                    arguments: JSON.stringify({ city: "Madrid" })
                  }
                }
              ]
            }
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ city: "Madrid", forecast: "sunny" }) }
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("gpt-4o-mini"),
      messages: [createTextMessage("user", "Use weather tool and return JSON.")],
      maxSteps: 2,
      schema: z.object({
        city: z.string(),
        forecast: z.string()
      }),
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      },
      mode: "native"
    });

    expect(result.object.forecast).toBe("sunny");
    expect(result.objectMode).toBe("native");
    expect(result.toolResults[0]?.toolName).toBe("weather");
  });

  it("embeds values", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await embed({
      model: provider.embeddingModel("text-embedding-3-small"),
      value: "hello"
    });

    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("passes provider-specific options through to the OpenAI API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from openai" } }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-4o-mini"),
      prompt: "hello",
      providerOptions: {
        top_p: 0.8,
        user: "test-user"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { top_p: number; user: string };
    expect(body.top_p).toBe(0.8);
    expect(body.user).toBe("test-user");
  });

  it("maps common tool choice to OpenAI tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from openai" } }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-4o-mini"),
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

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tool_choice: { type: string; function: { name: string } };
    };
    expect(body.tool_choice).toEqual({
      type: "function",
      function: {
        name: "weather"
      }
    });
  });

  it("maps typed OpenAI hosted tool helpers", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "hello from openai" }]
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-4o-mini"),
      prompt: "hello",
      tools: {
        web: openAIWebSearchTool({
          search_context_size: "small"
        })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tools: Array<{ type: string; search_context_size?: string }>;
    };
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    expect(body.tools).toEqual([
      {
        type: "web_search",
        search_context_size: "low"
      }
    ]);

    const webTool = openAIWebSearchTool();
    const mcpTool = openAIRemoteMcpTool({
      server_label: "docs",
      server_url: "https://example.com/mcp"
    });
    expect(webTool.toolClass).toBe("web-search");
    expect(mcpTool.toolClass).toBe("remote-mcp");
    expect(mcpTool.requiresApproval).toBe(true);
    expect(getAgentCapabilities(provider("gpt-4o-mini")).remoteMcp).toBe(true);
    expect(getAgentCapabilities(provider("gpt-4o-mini")).codeExecution).toBe(true);
    expect(getAgentCapabilities(provider("gpt-4o-mini")).shell).toBe(false);
    expect(getAgentCapabilities(provider("gpt-5.4")).shell).toBe(true);
    expect(getAgentCapabilities(provider("gpt-5.5")).computerUse).toBe(true);
    expect(getAgentCapabilities(provider("gpt-5.5")).toolSearch).toBe(true);
  });

  it("maps OpenAI agent built-in helpers into Responses tools", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }]
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-5.4"),
      prompt: "inspect",
      tools: {
        code: openAICodeInterpreterTool({ container: { type: "auto" } }),
        shell: openAIShellTool({ execute: () => ({ stdout: "", stderr: "", outcome: { type: "exit", exitCode: 0 } }) }),
        patch: openAIApplyPatchTool({ applyOperation: () => ({ status: "completed", output: "ok" }) }),
        toolSearch: openAIToolSearchTool()
      },
      toolApprovalPolicy: () => true
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { tools: Array<{ type: string }> };
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    expect(body.tools).toEqual(
      expect.arrayContaining([
        { type: "code_interpreter", container: { type: "auto" } },
        expect.objectContaining({ type: "shell" }),
        { type: "apply_patch" },
        { type: "tool_search" }
      ])
    );
  });

  it("rejects Responses tools that the selected OpenAI model does not support", async () => {
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    expect(getAgentCapabilities(provider("gpt-5.4")).toolSearch).toBe(true);
    expect(getAgentCapabilities(provider("gpt-5.4-nano")).toolSearch).toBe(false);
    expect(getAgentCapabilities(provider("gpt-5.5")).computerUse).toBe(true);

    await expect(
      generateText({
        model: provider("gpt-5.4-nano"),
        prompt: "inspect",
        tools: {
          toolSearch: openAIToolSearchTool()
        }
      })
    ).rejects.toThrow('Provider "openai" model "gpt-5.4-nano" does not support the Responses tool_search tool.');
  });

  it("executes OpenAI shell calls through the local approval-aware harness", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "shell_call",
            call_id: "call_shell",
            action: {
              command: "echo hi",
              max_output_length: 1000
            }
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_2",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "shell done" }]
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const approvals: string[] = [];
    const result = await generateText({
      model: provider("gpt-5.4"),
      prompt: "run shell",
      maxSteps: 2,
      tools: {
        shell: openAIShellTool({
          execute: (input) => ({
            stdout: `ran:${input.command ?? input.action?.command}`,
            stderr: "",
            outcome: { type: "exit", exitCode: 0 },
            maxOutputLength: input.maxOutputLength
          })
        })
      },
      toolApprovalPolicy(request) {
        approvals.push(request.toolCall.name);
        return true;
      }
    });

    expect(result.text).toBe("shell done");
    expect(approvals).toEqual(["shell"]);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      input: Array<{ type: string; call_id: string; output: unknown }>;
    };
    expect(secondBody.input[0]).toMatchObject({
      type: "shell_call_output",
      call_id: "call_shell",
      output: [
        expect.objectContaining({
          stdout: "ran:echo hi",
          outcome: { type: "exit", exit_code: 0 }
        })
      ]
    });
  });

  it("blocks OpenAI local harness paths that escape rootDir", async () => {
    const shell = openAIShellTool({
      rootDir: "/tmp/openai-root",
      cwd: "../outside"
    });
    await expect(shell.execute({ command: "echo hi" })).rejects.toThrow("OpenAI shell cwd path escapes rootDir.");

    const applyOperation = vi.fn(() => ({ status: "completed" as const }));
    const patch = openAIApplyPatchTool({
      rootDir: "/tmp/openai-root",
      applyOperation
    });
    await expect(
      patch.execute({
        operation: {
          type: "update_file",
          path: "../outside.txt",
          diff: "patch"
        }
      })
    ).rejects.toThrow("OpenAI apply_patch path escapes rootDir.");
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it("uses the Responses API for hosted tools and continues local function loops", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "weather",
            arguments: JSON.stringify({ city: "Madrid" })
          }
        ],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_2",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Madrid is sunny." }]
          }
        ],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-5"),
      prompt: "Use hosted web search if needed, then weather.",
      maxSteps: 2,
      tools: {
        web: hostedTool({
          name: "web",
          provider: "openai",
          type: "web_search"
        }),
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      }
    });

    expect(result.text).toBe("Madrid is sunny.");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      tools: Array<{ type: string }>;
    };
    expect(firstBody.tools).toEqual(
      expect.arrayContaining([
        { type: "web_search" },
        expect.objectContaining({ type: "function", name: "weather" })
      ])
    );

    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      previous_response_id: string;
      input: Array<{ type: string; call_id?: string; output?: string }>;
    };
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify({ city: "Madrid", forecast: "sunny" })
      }
    ]);
  });

  it("maps common reasoning config to OpenAI request fields", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "reasoned" } }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-5"),
      prompt: "hello",
      maxTokens: 256,
      reasoning: {
        effort: "high"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      reasoning_effort: string;
      max_completion_tokens: number;
      max_tokens?: number;
    };
    expect(body.reasoning_effort).toBe("high");
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
  });

  it("rejects unsupported reasoning budget tokens for OpenAI", async () => {
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("gpt-5"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 256
        }
      })
    ).rejects.toThrow('Provider "openai" does not support "reasoning.budgetTokens".');
  });

  it("reports the current GPT-5.6, GPT-5.5, and GPT-5.4 tool capability matrix", () => {
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });

    for (const modelId of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const model = provider(modelId);
      expect(model.capabilities).toMatchObject({
        files: true,
        explicitPromptCaching: true,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        reasoningModes: ["standard", "pro"],
        reasoningContexts: ["auto", "current_turn", "all_turns"]
      });
      expect(getAgentCapabilities(model)).toMatchObject({
        computerUse: true,
        shell: true,
        applyPatch: true,
        skills: true,
        toolSearch: true,
        programmaticToolCalling: true,
        multiAgent: true
      });
    }

    expect(getAgentCapabilities(provider("gpt-5.5"))).toMatchObject({
      computerUse: true,
      shell: true,
      applyPatch: true,
      skills: true,
      toolSearch: true
    });
    expect(getAgentCapabilities(provider("gpt-5.5-pro"))).toMatchObject({
      computerUse: false,
      shell: true,
      applyPatch: false,
      skills: false,
      toolSearch: false
    });
    expect(getAgentCapabilities(provider("gpt-5.4-mini"))).toMatchObject({
      computerUse: true,
      shell: true,
      applyPatch: true,
      skills: true,
      toolSearch: true
    });
    expect(getAgentCapabilities(provider("gpt-5.4-nano"))).toMatchObject({
      computerUse: false,
      shell: true,
      applyPatch: true,
      skills: true,
      toolSearch: false
    });
  });

  it("uses Responses by default for GPT-5.6 and maps endpoint-specific reasoning and usage", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_56",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "reasoned" }] }],
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 8, cache_write_tokens: 4 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 6 },
          total_tokens: 30
        }
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "chat" } }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const responseResult = await generateText({
      model: provider("gpt-5.6-terra"),
      prompt: "hard problem",
      maxTokens: 512,
      reasoning: {
        effort: "max",
        mode: "pro",
        context: "all_turns",
        includeThoughts: true
      }
    });
    await generateText({
      model: provider("gpt-5.6-luna"),
      prompt: "chat override",
      maxTokens: 128,
      reasoning: { effort: "high" },
      providerOptions: { apiMode: "chat" }
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
    const responsesBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(responsesBody).toMatchObject({
      model: "gpt-5.6-terra",
      max_output_tokens: 512,
      reasoning: { effort: "max", mode: "pro", context: "all_turns", summary: "auto" }
    });
    expect(responsesBody.reasoning_effort).toBeUndefined();
    expect(responsesBody.max_completion_tokens).toBeUndefined();
    expect(responseResult.usage).toMatchObject({
      cachedInputTokens: 8,
      cacheWriteTokens: 4,
      reasoningTokens: 6
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    const chatBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(chatBody).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning_effort: "high",
      max_completion_tokens: 128
    });
    expect(chatBody.apiMode).toBeUndefined();
    expect(chatBody.reasoning).toBeUndefined();
  });

  it("does not send Responses-only encrypted reasoning includes to Chat with store false", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "chat" } }] })
    );
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-5.6"),
      prompt: "chat",
      providerOptions: { apiMode: "chat", store: false }
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.store).toBe(false);
    expect(body.include).toBeUndefined();
  });

  it("passes GPT-5.6 cache and safety controls and explicit breakpoints to Responses", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_cache",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "cached" }] }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-5.6"),
      messages: [
        {
          role: "system",
          parts: [
            {
              type: "text",
              text: "Stable system prefix",
              providerMetadata: {
                openai: { prompt_cache_breakpoint: { mode: "explicit" } }
              }
            }
          ]
        },
        {
          role: "user",
          parts: [{ type: "text", text: "Question" }, openAIPromptCacheBreakpoint()]
        }
      ],
      providerOptions: {
        prompt_cache_key: "tenant:acme:v1",
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
        safety_identifier: "user_123"
      }
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      prompt_cache_key: "tenant:acme:v1",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      safety_identifier: "user_123"
    });
    expect(body.input[0].content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    expect(body.input[1].content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
  });

  it("maps named GPT-5.6 tool choice to the Responses shape", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_choice",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
      })
    );
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-5.6"),
      prompt: "weather",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city })
        })
      },
      toolChoice: { type: "tool", toolName: "weather" }
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.tool_choice).toEqual({ type: "function", name: "weather" });
  });

  it("enables Multi-agent with the beta header and returns only the root final answer", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_agents",
        status: "completed",
        output: [
          {
            type: "message",
            agent: { agent_name: "/root/reviewer" },
            phase: "final_answer",
            content: [{ type: "output_text", text: "subagent text" }]
          },
          {
            type: "message",
            agent: { agent_name: "/root" },
            phase: "analysis",
            content: [{ type: "output_text", text: "root analysis" }]
          },
          {
            type: "multi_agent_call_output",
            call_id: "spawn_1",
            output: []
          },
          {
            type: "message",
            agent: { agent_name: "/root" },
            phase: "final_answer",
            content: [{ type: "output_text", text: "root final" }]
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-5.6-sol"),
      prompt: "review",
      providerOptions: {
        multi_agent: { enabled: true, max_concurrent_subagents: 4 }
      }
    });

    expect(result.text).toBe("root final");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("OpenAI-Beta")).toContain("responses_multi_agent=v1");
    expect(JSON.parse(String(request.body)).multi_agent).toEqual({
      enabled: true,
      max_concurrent_subagents: 4
    });
  });

  it("filters streamed Multi-agent text to the root final-answer item", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","agent":{"agent_name":"/root/reviewer"},"phase":"final_answer","content":[]}}\n\n' +
              'data: {"type":"response.output_text.delta","output_index":0,"delta":"subagent"}\n\n' +
              'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","agent":{"agent_name":"/root/reviewer"},"phase":"final_answer","content":[{"type":"output_text","text":"subagent"}]}}\n\n' +
              'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","content":[]}}\n\n' +
              'data: {"type":"response.output_text.delta","output_index":1,"delta":"root final"}\n\n' +
              'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","agent":{"agent_name":"/root"},"phase":"final_answer","content":[{"type":"output_text","text":"root final"}]}}\n\n' +
              'data: {"type":"response.completed","response":{"id":"resp_agents_stream","status":"completed"}}\n\n' +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("gpt-5.6-sol"),
      prompt: "review",
      providerOptions: { multi_agent: { enabled: true } }
    });

    expect((await result.collect()).text).toBe("root final");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("OpenAI-Beta")).toContain("responses_multi_agent=v1");
  });

  it("supports Programmatic Tool Calling and preserves caller during continuation", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_program",
        status: "completed",
        output: [
          {
            type: "program",
            id: "prog_1",
            call_id: "call_program",
            code: "text(JSON.stringify(await tools.inventory({sku: 'a'})))",
            fingerprint: "opaque"
          },
          {
            type: "function_call",
            call_id: "call_inventory",
            name: "inventory",
            arguments: JSON.stringify({ sku: "a" }),
            caller: { type: "program", caller_id: "call_program" }
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_program_done",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-5.6-sol"),
      prompt: "check inventory",
      maxSteps: 2,
      tools: {
        inventory: openAIProgrammaticTool(
          tool({
            name: "inventory",
            schema: z.object({ sku: z.string() }),
            execute: ({ sku }) => ({ sku, available: 4 })
          }),
          {
            outputSchema: z.object({ sku: z.string(), available: z.number() })
          }
        ),
        programmatic: openAIProgrammaticToolCallingTool()
      }
    });

    expect(result.text).toBe("done");
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstBody.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          name: "inventory",
          allowed_callers: ["programmatic"],
          output_schema: expect.objectContaining({ type: "object" })
        }),
        { type: "programmatic_tool_calling" }
      ])
    );
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody.previous_response_id).toBe("resp_program");
    expect(secondBody.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_inventory",
        output: JSON.stringify({ sku: "a", available: 4 }),
        caller: { type: "program", caller_id: "call_program" }
      }
    ]);
  });

  it("continues Programmatic Tool Calling internally until a final message", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_program_output",
        status: "completed",
        output: [
          {
            type: "program_output",
            id: "program_output_1",
            call_id: "call_program",
            result: JSON.stringify({ total: 7 }),
            status: "completed"
          }
        ],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_program_final",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "total is 7" }] }],
        usage: { input_tokens: 2, output_tokens: 4, total_tokens: 6 }
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-5.6-sol"),
      prompt: "calculate",
      tools: { programmatic: openAIProgrammaticToolCallingTool() }
    });

    expect(result.text).toBe("total is 7");
    expect(result.usage).toMatchObject({ inputTokens: 6, outputTokens: 7, totalTokens: 13 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const continuationBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(continuationBody.previous_response_id).toBe("resp_program_output");
    expect(continuationBody.input).toBeUndefined();
  });

  it("does not continue incomplete Programmatic Tool Calling responses", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_program_incomplete",
        status: "incomplete",
        output: [
          {
            type: "program_output",
            call_id: "call_program",
            result: "{}",
            status: "incomplete"
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-5.6"),
      prompt: "calculate",
      tools: { programmatic: openAIProgrammaticToolCallingTool() }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.providerFinishReason).toBe("incomplete");
  });

  it("preserves Responses refusals in non-streaming and streaming results", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_refusal",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "I cannot help with that." }]
          }
        ]
      })
    );
    const streamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","content":[]}}\n\n' +
              'data: {"type":"response.refusal.delta","output_index":0,"delta":"I cannot help."}\n\n' +
              'data: {"type":"response.completed","response":{"id":"resp_refusal_stream","status":"completed"}}\n\n' +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(
      new Response(streamBody, { status: 200, headers: { "content-type": "text/event-stream" } })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const generated = await generateText({ model: provider("gpt-5.6"), prompt: "unsafe" });
    const streamed = await streamText({ model: provider("gpt-5.6"), prompt: "unsafe" }).collect();

    expect(generated).toMatchObject({ text: "I cannot help with that.", finishReason: "refusal" });
    expect(streamed).toMatchObject({ text: "I cannot help.", finishReason: "refusal" });
  });

  it("throws terminal Responses SSE errors", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"error","error":{"message":"multi-agent failed"}}\n\n' +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await expect(
      streamText({ model: provider("gpt-5.6"), prompt: "review" }).collect()
    ).rejects.toThrow("multi-agent failed");
  });

  it("uses the correctness-preserving non-SSE path when streaming Programmatic Tool Calling", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_stream_program_output",
        status: "completed",
        output: [
          {
            type: "program_output",
            call_id: "call_program",
            result: "{}",
            status: "completed"
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_stream_program_final",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "stream final" }] }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("gpt-5.6"),
      prompt: "calculate",
      tools: { programmatic: openAIProgrammaticToolCallingTool() }
    });

    expect((await result.collect()).text).toBe("stream final");
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstBody.stream).toBeUndefined();
  });

  it("replays encrypted reasoning and raw output items for store false continuations", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_stateless",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_1", encrypted_content: "encrypted" },
          {
            type: "function_call",
            call_id: "call_stateless",
            name: "lookup",
            arguments: "{}",
            caller: { type: "program", caller_id: "call_program" }
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_stateless_done",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-5.6"),
      prompt: "lookup",
      maxSteps: 2,
      providerOptions: { store: false },
      tools: {
        lookup: tool({ name: "lookup", schema: z.object({}), execute: () => ({ ok: true }) })
      }
    });

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstBody.include).toContain("reasoning.encrypted_content");
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input).toEqual(
      expect.arrayContaining([
        { type: "reasoning", id: "rs_1", encrypted_content: "encrypted" },
        expect.objectContaining({ type: "function_call", call_id: "call_stateless" }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_stateless",
          caller: { type: "program", caller_id: "call_program" }
        })
      ])
    );
  });

  it("preserves all internal Programmatic Tool Calling outputs across store false tool steps", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_stateless_program",
        status: "completed",
        output: [
          {
            type: "program_output",
            call_id: "call_program",
            result: JSON.stringify({ stage: 1 }),
            status: "completed"
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_stateless_call",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_lookup",
            name: "lookup",
            arguments: "{}",
            caller: { type: "program", caller_id: "call_program" }
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_stateless_final",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "complete" }] }]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-5.6"),
      prompt: "run program",
      maxSteps: 2,
      providerOptions: { store: false },
      tools: {
        lookup: openAIProgrammaticTool(
          tool({ name: "lookup", schema: z.object({}), execute: () => ({ ok: true }) })
        ),
        programmatic: openAIProgrammaticToolCallingTool()
      }
    });

    expect(result.text).toBe("complete");
    const thirdBody = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body));
    expect(thirdBody.previous_response_id).toBeUndefined();
    expect(thirdBody.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "program_output", call_id: "call_program" }),
        expect.objectContaining({ type: "function_call", call_id: "call_lookup" }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_lookup",
          caller: { type: "program", caller_id: "call_program" }
        })
      ])
    );
  });

  it("executes GPT-5.6 Computer Use GA actions and returns an original screenshot", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_computer",
        status: "completed",
        output: [
          {
            type: "computer_call",
            call_id: "call_computer",
            actions: [{ type: "click", x: 10, y: 20 }, { type: "screenshot" }]
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_computer_done",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "finished" }] }]
      })
    );

    const execute = vi.fn(() => ({
      type: "computer_screenshot" as const,
      image_url: "data:image/png;base64,aGVsbG8="
    }));
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("gpt-5.6-luna"),
      prompt: "click",
      maxSteps: 2,
      toolApprovalPolicy: () => true,
      tools: { computer: openAIComputerTool({ execute }) }
    });

    expect(result.text).toBe("finished");
    expect(execute).toHaveBeenCalledWith({
      actions: [{ type: "click", x: 10, y: 20 }, { type: "screenshot" }]
    });
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstBody.tools).toContainEqual({ type: "computer" });
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody.input).toEqual([
      {
        type: "computer_call_output",
        call_id: "call_computer",
        output: {
          type: "computer_screenshot",
          image_url: "data:image/png;base64,aGVsbG8=",
          detail: "original"
        }
      }
    ]);
  });

  it("maps Shell environments with skills and serializes batched command outputs", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_shell_batch",
        status: "completed",
        output: [
          {
            type: "shell_call",
            call_id: "call_shell_batch",
            action: {
              commands: ["pwd", "ls"],
              timeout_ms: 5000,
              max_output_length: 2000
            }
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_shell_done",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "shell done" }] }]
      })
    );

    const execute = vi.fn(() => [
      { stdout: "/tmp\n", stderr: "", outcome: { type: "exit" as const, exit_code: 0 }, maxOutputLength: 2000 },
      { stdout: "a.txt\n", stderr: "", outcome: { type: "exit" as const, exit_code: 0 }, maxOutputLength: 2000 }
    ]);
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-5.6-terra"),
      prompt: "inspect",
      maxSteps: 2,
      toolApprovalPolicy: () => true,
      tools: {
        terminal: openAIShellTool({
          name: "terminal",
          execute,
          environment: {
            type: "local",
            skills: [{ name: "repo", description: "Inspect the repository", path: "/skills/repo" }]
          }
        })
      }
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ commands: ["pwd", "ls"] }) })
    );
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstBody.tools[0]).toEqual({
      type: "shell",
      environment: {
        type: "local",
        skills: [{ name: "repo", description: "Inspect the repository", path: "/skills/repo" }]
      }
    });
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody.input[0]).toEqual({
      type: "shell_call_output",
      call_id: "call_shell_batch",
      max_output_length: 2000,
      output: [
        { stdout: "/tmp\n", stderr: "", outcome: { type: "exit", exit_code: 0 } },
        { stdout: "a.txt\n", stderr: "", outcome: { type: "exit", exit_code: 0 } }
      ]
    });
  });

  it("keeps hosted Shell and preview Computer calls as provider data instead of executing locally", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_hosted_shell",
        status: "completed",
        output: [
          {
            type: "shell_call",
            call_id: "hosted_shell_1",
            action: { commands: ["python -V"] },
            status: "completed"
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_preview_computer",
        status: "completed",
        output: [
          {
            type: "computer_call",
            call_id: "preview_1",
            action: { type: "screenshot" },
            status: "completed"
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const hostedResult = await generateText({
      model: provider("gpt-5.6-sol"),
      prompt: "run hosted",
      maxSteps: 2,
      tools: {
        shell: openAIHostedShellTool({
          environment: {
            type: "container_auto",
            skills: [{ type: "skill_reference", skill_id: "skill_123", version: "latest" }],
            network_policy: {
              type: "allowlist",
              allowed_domains: ["example.com"],
              domain_secrets: [{ domain: "example.com", name: "API_TOKEN", value: "secret" }]
            }
          }
        })
      }
    });
    const previewResult = await generateText({
      model: provider("gpt-5.4"),
      prompt: "legacy preview",
      maxSteps: 2,
      tools: {
        computer: openAIComputerUseTool({
          environment: "browser",
          display_width: 1280,
          display_height: 720
        })
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hostedResult.toolCalls ?? []).toHaveLength(0);
    expect(hostedResult.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({
        type: "provider-data",
        data: expect.objectContaining({ type: "shell_call", call_id: "hosted_shell_1" })
      })
    );
    expect(previewResult.toolCalls ?? []).toHaveLength(0);
    expect(previewResult.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({
        type: "provider-data",
        data: expect.objectContaining({ type: "computer_call", action: { type: "screenshot" } })
      })
    );

    const hostedBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(hostedBody.tools[0]).toMatchObject({
      type: "shell",
      environment: {
        type: "container_auto",
        skills: [{ type: "skill_reference", skill_id: "skill_123", version: "latest" }],
        network_policy: { type: "allowlist", allowed_domains: ["example.com"] }
      }
    });
  });

  it("transcribes audio through the shared contract", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ text: "hello transcript" }));

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await transcribeAudio({
      model: provider.transcriptionModel!("gpt-4o-mini-transcribe"),
      audio: {
        data: "aGVsbG8=",
        mediaType: "audio/wav",
        filename: "clip.wav"
      }
    });

    expect(result.text).toBe("hello transcript");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/audio/transcriptions");
  });

  it("uploads only the selected audio view and protects reserved multipart fields", async () => {
    const backing = Uint8Array.from([9, 1, 2, 8]);
    fetchMock.mockImplementationOnce(async (_url, init: RequestInit) => {
      const form = init.body as FormData;
      const file = form.get("file") as File;
      expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2]);
      expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
      return Response.json({ text: "safe transcript" });
    });

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await transcribeAudio({
      model: provider.transcriptionModel!("gpt-4o-mini-transcribe"),
      audio: { data: backing.subarray(1, 3), mediaType: "audio/wav" },
      providerOptions: { model: "attacker-model", file: "not-a-file" }
    });
  });

  it("generates speech through the shared contract", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" }
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateSpeech({
      model: provider.speechModel!("gpt-4o-mini-tts"),
      input: "hello there"
    });

    expect(result.mediaType).toBe("audio/mpeg");
    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
  });

  it("limits speech bodies and releases the reader when a timeout aborts streaming", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(Uint8Array.from([1, 2, 3, 4]), {
        headers: { "content-type": "audio/mpeg", "content-length": "4" }
      })
    );
    const limited = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      responseLimits: { speechBytes: 3 }
    });
    await expect(
      generateSpeech({ model: limited.speechModel!("gpt-4o-mini-tts"), input: "hello" })
    ).rejects.toBeInstanceOf(ProviderResponseTooLargeError);

    let response: Response | undefined;
    fetchMock.mockImplementationOnce(async (_url, init: RequestInit) => {
      const signal = init.signal!;
      response = new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          }
        }),
        { headers: { "content-type": "audio/mpeg" } }
      );
      return response;
    });
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await expect(
      generateSpeech({ model: provider.speechModel!("gpt-4o-mini-tts"), input: "hello", timeoutMs: 1 })
    ).rejects.toBeDefined();
    expect(response?.body?.locked).toBe(false);
  });

  it("bounds provider error bodies while preserving ProviderHTTPError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("abcdefgh", { status: 500 }));
    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      responseLimits: { errorBodyBytes: 4 }
    });
    const promise = generateSpeech({ model: provider.speechModel!("gpt-4o-mini-tts"), input: "hello" });
    await expect(promise).rejects.toBeInstanceOf(ProviderHTTPError);
    await expect(promise).rejects.toMatchObject({
      status: 500,
      responseBody: "abcd\n...[truncated at 4 bytes]"
    });
  });

  it("generates grounded text with normalized sources", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: "completed",
        output_text: "fresh answer",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                annotations: [{ title: "Source", url: "https://example.com", snippet: "Snippet" }]
              }
            ]
          }
        ]
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateGroundedText({
      model: provider.groundedLanguageModel!("gpt-4o-search-preview"),
      prompt: "What happened today?"
    });

    expect(result.text).toBe("fresh answer");
    expect(result.sources).toEqual([
      {
        title: "Source",
        url: "https://example.com",
        snippet: "Snippet",
        providerMetadata: expect.any(Object)
      }
    ]);
  });

  it("connects realtime sessions with the expected headers and setup payload", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (url: string, headers: Record<string, string>) => {
      expect(url).toContain("/realtime");
      expect(url).toContain("model=gpt-realtime");
      expect(headers).toMatchObject({
        authorization: "Bearer test"
      });
      expect(headers).not.toHaveProperty("openai-beta");
      return {
        async sendJson(payload: Record<string, unknown>) {
          sent.push(payload);
        },
        async recvJson() {
          return undefined;
        },
        async close() {}
      };
    });

    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gpt-realtime").connect({
      instructions: "Be brief.",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: () => ({ ok: true })
        })
      },
      toolChoice: { type: "tool", toolName: "weather" }
    });

    await session.sendMedia({ data: "image-bytes", mediaType: "image/jpeg" });
    await session.sendText("hello");
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
    const initialSession = sent[0]?.session as { tools: Array<Record<string, unknown>> };
    expect(sent[0]).toMatchObject({
      type: "session.update",
      session: expect.objectContaining({
        model: "gpt-realtime",
        instructions: "Be brief.",
        tool_choice: { type: "function", name: "weather" }
      })
    });
    expect(initialSession.tools[0]).toMatchObject({
      type: "function",
      name: "weather",
      parameters: expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({ city: expect.objectContaining({ type: "string" }) })
      })
    });
    expect(initialSession.tools[0]).not.toHaveProperty("function");
    expect(sent[1]).toMatchObject({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/jpeg;base64,image-bytes" }]
      }
    });
    expect(sent[2]).toMatchObject({
      type: "conversation.item.create",
      item: expect.objectContaining({ role: "user" })
    });
    expect(sent[3]).toEqual({ type: "response.create" });
  });

  it("sends realtime safety identifiers and custom headers without leaking them into the session body", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (_url: string, headers: Record<string, string>) => {
      expect(headers).toEqual({
        authorization: "Bearer test",
        "x-request-id": "request_123",
        "OpenAI-Safety-Identifier": "hashed-user-123"
      });
      return {
        async sendJson(payload: Record<string, unknown>) {
          sent.push(payload);
        },
        async recvJson() {
          return undefined;
        },
        async close() {}
      };
    });

    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gpt-realtime-2.1").connect({
      providerOptions: {
        safety_identifier: "hashed-user-123",
        headers: {
          "x-request-id": "request_123",
          Authorization: "Bearer wrong-key",
          "Content-Type": "text/plain",
          "openai-safety-identifier": "stale-value"
        }
      }
    });
    await session.close();

    const sessionBody = sent[0]?.session as Record<string, unknown>;
    expect(sessionBody).not.toHaveProperty("safety_identifier");
    expect(sessionBody).not.toHaveProperty("headers");
  });

  it("rejects Responses-only hosted tools in Realtime sessions", async () => {
    const connectionFactory = vi.fn(async () => ({
      async sendJson() {},
      async recvJson() {
        return undefined;
      },
      async close() {}
    }));
    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });

    await expect(
      provider.realtimeModel!("gpt-realtime-2.1").connect({
        tools: { web: openAIWebSearchTool() }
      })
    ).rejects.toThrow(
      'Provider "openai" Realtime does not support the hosted tool type "web_search". Use function or MCP tools.'
    );
  });

  it("maps OpenAI chat audio input and output for audio-capable models", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "",
              audio: {
                id: "audio_1",
                data: Buffer.from([1, 2, 3]).toString("base64"),
                format: "wav",
                transcript: "The recording contains a greeting."
              }
            }
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await provider("gpt-audio-mini").generate({
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "What is in this recording?" },
            audioPart({
              data: new Uint8Array([7, 8, 9]),
              mediaType: "audio/wav"
            })
          ]
        }
      ],
      providerOptions: {
        modalities: ["text", "audio"],
        audio: { voice: "alloy", format: "wav" }
      }
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(provider("gpt-audio-mini").capabilities).toMatchObject({ audioInput: true, audioOutput: true });
    expect(body.messages[0].content).toContainEqual({
      type: "input_audio",
      input_audio: {
        data: Buffer.from([7, 8, 9]).toString("base64"),
        format: "wav"
      }
    });
    expect(body.modalities).toEqual(["text", "audio"]);
    expect(result.text).toBe("The recording contains a greeting.");
    expect(Array.from(result.audio?.[0]?.data ?? [])).toEqual([1, 2, 3]);
    expect(result.audio?.[0]?.mediaType).toBe("audio/wav");
  });

  it("maps GPT Realtime 2 reasoning into realtime session setup", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (url: string) => {
      expect(url).toContain("/realtime");
      expect(url).toContain("model=gpt-realtime-2");
      return {
        async sendJson(payload: Record<string, unknown>) {
          sent.push(payload);
        },
        async recvJson() {
          return undefined;
        },
        async close() {}
      };
    });

    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const model = provider.realtimeModel!("gpt-realtime-2");
    const session = await model.connect({
      reasoning: { effort: "high" },
      outputAudioMediaType: "audio/pcm",
      voice: "marin"
    });

    await session.sendAudio({ data: "audio", mediaType: "audio/pcm", isFinal: true });
    await session.close();

    expect(model.capabilities.reasoning).toBe(true);
    expect(model.capabilities.realtime).toMatchObject({ audioInput: true, audioOutput: true, tools: true });
    expect(sent[0]).toMatchObject({
      type: "session.update",
      session: expect.objectContaining({
        type: "realtime",
        model: "gpt-realtime-2",
        reasoning: { effort: "high" },
        output_modalities: ["audio"]
      })
    });
    expect(sent).toContainEqual({ type: "response.create" });
  });

  it.each(["gpt-realtime-2.1", "gpt-realtime-2.1-mini"])(
    "recognizes %s as a reasoning and image-input Realtime model",
    async (modelId) => {
      const sent: Record<string, unknown>[] = [];
      const connectionFactory = vi.fn(async () => ({
        async sendJson(payload: Record<string, unknown>) {
          sent.push(payload);
        },
        async recvJson() {
          return undefined;
        },
        async close() {}
      }));
      const provider = createOpenAI({
        apiKey: "test",
        fetch: fetchMock as typeof fetch,
        realtimeConnectionFactory: connectionFactory
      });
      const model = provider.realtimeModel!(modelId);
      const session = await model.connect({ reasoning: { effort: "high" } });

      await session.sendMedia({ data: "image", mediaType: "image/png" });
      await session.close();

      expect(model.capabilities).toMatchObject({
        reasoning: true,
        vision: true,
        webSearch: false,
        structuredOutput: false,
        jsonMode: false,
        embeddings: false,
        agentCapabilities: {
          supportTier: "tier-a",
          hostedWebSearch: false,
          hostedFileSearch: false,
          remoteMcp: true,
          computerUse: false,
          codeExecution: false,
          shell: false,
          applyPatch: false,
          toolSearch: false,
          skills: false
        }
      });
      expect(model.capabilities.realtime).toMatchObject({ imageInput: true });
      expect(sent[0]).toMatchObject({
        type: "session.update",
        session: expect.objectContaining({ model: modelId, reasoning: { effort: "high" } })
      });
      expect(sent[1]).toMatchObject({
        type: "conversation.item.create",
        item: expect.objectContaining({
          content: [{ type: "input_image", image_url: "data:image/png;base64,image" }]
        })
      });
    }
  );

  it("normalizes provider-executed Realtime MCP lifecycle events and sends explicit approval responses", async () => {
    const sent: Record<string, unknown>[] = [];
    const incoming: Array<Record<string, unknown> | undefined> = [
      { type: "mcp_list_tools.in_progress", item_id: "list_1" },
      { type: "mcp_list_tools.completed", item_id: "list_1" },
      {
        type: "mcp_list_tools.failed",
        item_id: "list_2",
        error: { message: "Unable to import MCP tools" }
      },
      {
        type: "conversation.item.done",
        item: {
          type: "mcp_list_tools",
          id: "list_1",
          server_label: "docs",
          tools: [{ name: "fetch_docs", description: "Fetch documentation" }]
        }
      },
      {
        type: "conversation.item.done",
        item: {
          type: "mcp_approval_request",
          id: "approval_1",
          server_label: "docs",
          name: "fetch_docs",
          arguments: '{"url":"https://developers.openai.com"}'
        }
      },
      { type: "response.mcp_call_arguments.delta", item_id: "call_1", delta: "{\"url\":" },
      {
        type: "response.mcp_call_arguments.done",
        item_id: "call_1",
        arguments: '{"url":"https://developers.openai.com"}'
      },
      { type: "response.mcp_call.in_progress", item_id: "call_1" },
      {
        type: "response.output_item.done",
        item: {
          type: "mcp_call",
          id: "call_1",
          server_label: "docs",
          name: "fetch_docs",
          arguments: '{"url":"https://developers.openai.com"}',
          output: '{"title":"Realtime"}',
          status: "completed"
        }
      },
      {
        type: "response.mcp_call.failed",
        item_id: "call_2",
        error: { message: "MCP server unavailable" }
      },
      undefined
    ];
    let incomingIndex = 0;
    const connectionFactory = vi.fn(async () => ({
      async sendJson(payload: Record<string, unknown>) {
        sent.push(payload);
      },
      async recvJson() {
        const event = incoming[incomingIndex];
        incomingIndex += 1;
        return event;
      },
      async close() {}
    }));
    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gpt-realtime-2.1").connect({
      tools: {
        docs: openAIRemoteMcpTool({
          server_label: "docs",
          server_url: "https://developers.openai.com/mcp",
          require_approval: "always"
        })
      }
    });

    const events = [];
    for await (const event of session.eventStream()) {
      events.push(event);
    }

    expect(events).not.toContainEqual(expect.objectContaining({ type: "realtime-tool-call" }));
    expect(events).toContainEqual({
      type: "realtime-provider-data",
      provider: "openai",
      data: expect.objectContaining({
        type: "mcp_list_tools",
        status: "completed",
        item_id: "list_1",
        server_label: "docs",
        tools: [{ name: "fetch_docs", description: "Fetch documentation" }],
        raw_event: expect.any(Object)
      })
    });
    expect(events).toContainEqual({
      type: "realtime-provider-data",
      provider: "openai",
      data: expect.objectContaining({
        type: "mcp_list_tools",
        status: "failed",
        item_id: "list_2",
        error: { message: "Unable to import MCP tools" },
        raw_event: expect.any(Object)
      })
    });
    expect(events).toContainEqual({
      type: "realtime-provider-data",
      provider: "openai",
      data: expect.objectContaining({
        type: "mcp_approval_request",
        status: "approval_required",
        approval_request_id: "approval_1",
        name: "fetch_docs",
        arguments: { url: "https://developers.openai.com" },
        raw_event: expect.any(Object)
      })
    });
    expect(events).toContainEqual({
      type: "realtime-provider-data",
      provider: "openai",
      data: expect.objectContaining({
        type: "mcp_call",
        status: "completed",
        item_id: "call_1",
        name: "fetch_docs",
        output: { title: "Realtime" },
        raw_event: expect.any(Object)
      })
    });
    expect(events).toContainEqual({
      type: "realtime-provider-data",
      provider: "openai",
      data: expect.objectContaining({
        type: "mcp_call",
        status: "failed",
        item_id: "call_2",
        error: { message: "MCP server unavailable" },
        raw_event: expect.any(Object)
      })
    });

    await session.sendToolResult(
      openAIRealtimeMcpApprovalResult({
        approvalRequestId: "approval_1",
        itemId: "approval_response_1",
        name: "fetch_docs",
        approve: true
      })
    );
    await session.close();

    expect(sent).toContainEqual({
      type: "conversation.item.create",
      item: {
        id: "approval_response_1",
        type: "mcp_approval_response",
        approval_request_id: "approval_1",
        approve: true
      }
    });
    expect(sent).not.toContainEqual({ type: "response.create" });
  });

  it("uses the dedicated realtime translation endpoint and disables tools", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (url: string) => {
      expect(url).toContain("/realtime/translations");
      expect(url).toContain("model=gpt-realtime-translate");
      return {
        async sendJson(payload: Record<string, unknown>) {
          sent.push(payload);
        },
        async recvJson() {
          return undefined;
        },
        async close() {}
      };
    });

    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const model = provider.realtimeModel!("gpt-realtime-translate");
    const session = await model.connect({
      translation: { targetLanguage: "es", sourceLanguage: "en" },
      outputAudioMediaType: "audio/pcm"
    });

    await session.sendAudio({ data: "audio", mediaType: "audio/pcm", isFinal: true });
    await expect(session.sendText("hello")).rejects.toThrow(
      'Provider "openai" model "gpt-realtime-translate" does not support realtime text input in translation mode.'
    );
    await session.close();

    expect(model.capabilities).toMatchObject({
      tools: false,
      audioInput: true,
      audioOutput: true,
      vision: false,
      agentCapabilities: { supportTier: "tier-c", remoteMcp: false }
    });
    expect(model.capabilities.realtime).toMatchObject({ imageInput: false });
    expect(sent[0]).toMatchObject({
      type: "session.update",
      session: expect.objectContaining({
        type: "realtime",
        model: "gpt-realtime-translate",
        translation: { target_language: "es", source_language: "en" },
        tools: undefined
      })
    });
    expect(sent).not.toContainEqual({ type: "response.create" });
  });

  it("uses realtime transcription sessions for GPT Realtime Whisper", async () => {
    const sent: Record<string, unknown>[] = [];
    let readCount = 0;
    const connectionFactory = vi.fn(async (url: string) => {
      expect(url).toContain("/realtime/transcription_sessions");
      expect(url).toContain("model=gpt-realtime-whisper");
      return {
        async sendJson(payload: Record<string, unknown>) {
          sent.push(payload);
        },
        async recvJson() {
          readCount += 1;
          if (readCount === 1) {
            return {
              type: "conversation.item.input_audio_transcription.delta",
              item_id: "item_1",
              delta: "Hola"
            };
          }
          if (readCount === 2) {
            return {
              type: "conversation.item.input_audio_transcription.completed",
              item_id: "item_1",
              transcript: "Hola mundo"
            };
          }
          return undefined;
        },
        async close() {}
      };
    });

    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const model = provider.realtimeModel!("gpt-realtime-whisper");
    const session = await model.connect({
      inputTranscription: { language: "es", includeLogprobs: true, delay: "low" },
      inputAudioMediaType: "audio/pcm",
      inputSampleRateHz: 24_000,
      noiseReduction: { type: "near_field" }
    });

    await session.sendAudio({ data: "audio", mediaType: "audio/pcm", isFinal: true });
    const events = [];
    for await (const event of session.eventStream()) {
      events.push(event);
    }
    await session.close();

    expect(model.capabilities).toMatchObject({ tools: false, audioInput: true, audioOutput: false, vision: false });
    expect(model.capabilities.realtime).toMatchObject({ imageInput: false });
    expect(sent[0]).toMatchObject({
      type: "session.update",
      session: expect.objectContaining({
        type: "transcription",
        model: "gpt-realtime-whisper",
        include: ["item.input_audio_transcription.logprobs"],
        audio: {
          input: expect.objectContaining({
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: "gpt-realtime-whisper",
              language: "es",
              prompt: undefined,
              delay: "low"
            },
            noise_reduction: { type: "near_field" }
          })
        }
      })
    });
    expect(sent).not.toContainEqual({ type: "response.create" });
    expect(events).toContainEqual(expect.objectContaining({ type: "realtime-transcript", text: "Hola", isFinal: false }));
    expect(events).toContainEqual(expect.objectContaining({ type: "realtime-transcript", text: "Hola mundo", isFinal: true }));
  });

  it("rejects realtime image input for OpenAI preview models that do not support it", async () => {
    const connectionFactory = vi.fn(async () => ({
      async sendJson() {},
      async recvJson() {
        return undefined;
      },
      async close() {}
    }));

    const provider = createOpenAI({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gpt-4o-realtime-preview").connect();

    await expect(session.sendMedia({ data: "image", mediaType: "image/jpeg" })).rejects.toThrow(
      'Provider "openai" model "gpt-4o-realtime-preview" does not support realtime image input.'
    );
  });

  it("creates browser tokens for realtime client sessions", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        client_secret: {
          value: "ephemeral-secret",
          expires_at_ms: 1234
        }
      })
    );

    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const token = await provider.realtimeModel!("gpt-realtime").createBrowserToken?.({
      instructions: "Be helpful.",
      providerOptions: {
        safety_identifier: "hashed-browser-user",
        headers: {
          "x-request-id": "browser_request_1",
          Authorization: "Bearer wrong-key",
          "Content-Type": "text/plain"
        }
      }
    });

    expect(token).toEqual({
      value: "ephemeral-secret",
      expiresAtMs: 1234,
      rawResponse: expect.any(Object)
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test",
          "content-type": "application/json",
          "x-request-id": "browser_request_1",
          "OpenAI-Safety-Identifier": "hashed-browser-user"
        })
      })
    );
    const requestHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(requestHeaders).not.toHaveProperty("Authorization");
    expect(requestHeaders).not.toHaveProperty("Content-Type");
    const requestBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      session: Record<string, unknown>;
    };
    expect(requestBody.session).not.toHaveProperty("safety_identifier");
    expect(requestBody.session).not.toHaveProperty("headers");
  });
});
