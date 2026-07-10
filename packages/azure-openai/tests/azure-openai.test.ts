import { beforeEach, describe, expect, it, vi } from "vitest";

import { embed, generateGroundedText, generateSpeech, generateText, getAgentCapabilities, hostedTool, ProviderResponseTooLargeError, streamText, tool, transcribeAudio } from "@zhivex-ai/core";
import { z } from "zod";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import {
  azureOpenAIApplyPatchTool,
  azureOpenAICodeInterpreterTool,
  azureOpenAIMcpApprovalResponse,
  azureOpenAIRemoteMcpTool,
  azureOpenAIShellTool,
  azureOpenAIToolSearchTool,
  azureOpenAIWebSearchTool,
  createAzureOpenAI
} from "../src/index.js";

describe("azure openai adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "azure-openai",
    modelId: "gpt-4o-mini",
    createModel: () =>
      createAzureOpenAI({
        apiKey: "test",
        endpoint: "https://example.openai.azure.com",
        fetch: fetchMock as typeof fetch
      })("gpt-4o-mini"),
    createEmbeddingModel: () =>
      createAzureOpenAI({
        apiKey: "test",
        endpoint: "https://example.openai.azure.com",
        fetch: fetchMock as typeof fetch
      }).embeddingModel("text-embedding-3-small"),
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
    providerName: "azure-openai",
    modelId: "gpt-4o-mini",
    expectedAgentTier: "tier-a",
    createModel: () =>
      createAzureOpenAI({
        apiKey: "test",
        endpoint: "https://example.openai.azure.com",
        fetch: fetchMock as typeof fetch
      })("gpt-4o-mini"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "hello from azure agent" } }]
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
                "data: {\"choices\":[{\"delta\":{\"content\":\" azure\"},\"finish_reason\":\"stop\"}]}\n\n" +
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
              content: [{ type: "output_text", text: "approved by azure" }]
            }
          ]
        })
      );
    },
    createApprovalTools: () => ({
      github: azureOpenAIRemoteMcpTool({
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
        choices: [{ finish_reason: "stop", message: { content: "hello from azure" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateText({
      model: provider("gpt-5.4"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from azure");
    expect(result.usage?.totalTokens).toBe(7);
  });

  it("rejects Responses tools that the selected Azure OpenAI model does not support", async () => {
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    expect(getAgentCapabilities(provider("gpt-5.4")).toolSearch).toBe(true);
    expect(getAgentCapabilities(provider("gpt-5.4-nano")).toolSearch).toBe(false);

    await expect(
      generateText({
        model: provider("gpt-5.4-nano"),
        prompt: "inspect",
        tools: {
          toolSearch: azureOpenAIToolSearchTool()
        }
      })
    ).rejects.toThrow('Provider "azure-openai" model "gpt-5.4-nano" does not support the Responses tool_search tool.');
  });

  it("streams incremental text", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" azure\"},\"finish_reason\":\"stop\"}]}\n\n" +
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

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = streamText({
      model: provider("gpt-4o-mini"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello azure");
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

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = streamText({
      model: provider("gpt-5"),
      prompt: "Use hosted web search if needed, then weather.",
      maxSteps: 2,
      tools: {
        web: hostedTool({
          name: "web",
          provider: "azure-openai",
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
      input: Array<Record<string, unknown>>;
    };
    expect(secondRequest.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "Use hosted web search if needed, then weather." }]
      },
      {
        role: "assistant",
        content: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "weather",
            arguments: JSON.stringify({ city: "Madrid" })
          }
        ]
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify({ city: "Madrid", forecast: "sunny" })
      }
    ]);
  });

  it("parses remote MCP approval requests from Azure Responses API", async () => {
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

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateText({
      model: provider("gpt-5"),
      prompt: "Use MCP",
      tools: {
        github: azureOpenAIRemoteMcpTool({
          server_label: "github",
          server_url: "https://example.com/mcp"
        })
      }
    });

    expect(result.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "azure-openai",
      data: {
        type: "mcp_approval_request",
        id: "mcpr_1",
        arguments: "{}",
        name: "fetch_docs",
        server_label: "github"
      }
    });
  });

  it("serializes MCP approval responses back into Azure Responses API input", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: []
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("gpt-5"),
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "provider-data",
              provider: "azure-openai",
              data: {
                responseId: "resp_prev"
              }
            }
          ]
        },
        {
          role: "user",
          parts: [
            azureOpenAIMcpApprovalResponse({
              approval_request_id: "mcpr_1",
              approve: true
            })
          ]
        }
      ],
      tools: {
        github: azureOpenAIRemoteMcpTool({
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
      server_description: "Docs server"
    });
  });

  it("embeds values", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }]
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await embed({
      model: provider.embeddingModel("text-embedding-3-small"),
      value: "hello"
    });

    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("maps common tool choice to Azure OpenAI tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from azure" } }]
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
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

  it("maps common reasoning config to Azure OpenAI request fields", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "reasoned" } }]
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
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

  it("maps typed Azure OpenAI hosted tool helpers", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "hello from azure" }]
          }
        ]
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("gpt-4o-mini"),
      prompt: "hello",
      tools: {
        web: azureOpenAIWebSearchTool()
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tools: Array<{ type: string }>;
    };
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");
    expect(body.tools).toEqual([
      {
        type: "web_search_preview"
      }
    ]);

    const webTool = azureOpenAIWebSearchTool();
    const mcpTool = azureOpenAIRemoteMcpTool({
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
  });

  it("maps Azure OpenAI agent built-in helpers into Responses tools", async () => {
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

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("gpt-5.4"),
      prompt: "inspect",
      tools: {
        code: azureOpenAICodeInterpreterTool({ container: { type: "auto" } }),
        shell: azureOpenAIShellTool({ execute: () => ({ stdout: "", stderr: "", outcome: { type: "exit", exitCode: 0 } }) }),
        patch: azureOpenAIApplyPatchTool({ applyOperation: () => ({ status: "completed", output: "ok" }) }),
        toolSearch: azureOpenAIToolSearchTool()
      },
      toolApprovalPolicy: () => true
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { tools: Array<{ type: string }> };
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");
    expect(body.tools).toEqual(
      expect.arrayContaining([
        { type: "code_interpreter", container: { type: "auto" } },
        { type: "shell" },
        { type: "apply_patch" },
        { type: "tool_search" }
      ])
    );
  });

  it("blocks Azure OpenAI local harness paths that escape rootDir", async () => {
    const shell = azureOpenAIShellTool({
      rootDir: "/tmp/azure-openai-root",
      cwd: "../outside"
    });
    await expect(shell.execute({ command: "echo hi" })).rejects.toThrow(
      "Azure OpenAI shell cwd path escapes rootDir."
    );

    const applyOperation = vi.fn(() => ({ status: "completed" as const }));
    const patch = azureOpenAIApplyPatchTool({
      rootDir: "/tmp/azure-openai-root",
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
    ).rejects.toThrow("Azure OpenAI apply_patch path escapes rootDir.");
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

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateText({
      model: provider("gpt-5"),
      prompt: "Use hosted web search if needed, then weather.",
      maxSteps: 2,
      tools: {
        web: hostedTool({
          name: "web",
          provider: "azure-openai",
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
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");

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

  it("rejects unsupported reasoning budget tokens for Azure OpenAI", async () => {
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });

    await expect(
      generateText({
        model: provider("gpt-5"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 256
        }
      })
    ).rejects.toThrow('Provider "azure-openai" does not support "reasoning.budgetTokens".');
  });

  it("transcribes audio through the shared contract", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ text: "hello from azure audio" }));

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await transcribeAudio({
      model: provider.transcriptionModel!("gpt-4o-mini-transcribe"),
      audio: {
        data: "aGVsbG8=",
        mediaType: "audio/wav"
      }
    });

    expect(result.text).toBe("hello from azure audio");
  });

  it("generates speech through the shared contract", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" }
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateSpeech({
      model: provider.speechModel!("gpt-4o-mini-tts"),
      input: "hello azure"
    });

    expect(Array.from(result.audio)).toEqual([4, 5, 6]);
  });

  it("enforces configured Azure speech response limits", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "audio/mpeg", "content-length": "4" }
      })
    );
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch,
      responseLimits: { speechBytes: 3 }
    });
    await expect(
      generateSpeech({ model: provider.speechModel!("gpt-4o-mini-tts"), input: "hello" })
    ).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
  });

  it("generates grounded text with sources", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: "completed",
        output_text: "fresh azure answer",
        output: [{ content: [{ annotations: [{ title: "Azure Source", url: "https://example.com/azure" }] }] }]
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateGroundedText({
      model: provider.groundedLanguageModel!("gpt-4o-search-preview"),
      prompt: "What happened today?"
    });

    expect(result.text).toBe("fresh azure answer");
    expect(result.sources[0]?.url).toBe("https://example.com/azure");
  });

  it("connects realtime sessions using the Azure websocket URI format", async () => {
    const sent: Record<string, unknown>[] = [];
    const connectionFactory = vi.fn(async (url: string, headers: Record<string, string>) => {
      expect(url).toBe(
        "wss://example.openai.azure.com/openai/realtime?api-version=2025-04-01-preview&deployment=gpt-4o-realtime-preview"
      );
      expect(headers).toEqual({ "api-key": "test" });
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

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      apiVersion: "2025-04-01-preview",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gpt-4o-realtime-preview").connect({
      instructions: "Be brief."
    });

    await session.sendMedia({ data: "azure-image", mediaType: "image/jpeg" });
    await session.sendText("hello azure");
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      type: "session.update",
      session: expect.objectContaining({
        model: "gpt-4o-realtime-preview",
        instructions: "Be brief."
      })
    });
    expect(sent[1]).toMatchObject({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/jpeg;base64,azure-image" }]
      }
    });
    expect(sent[2]).toMatchObject({
      type: "conversation.item.create",
      item: expect.objectContaining({ role: "user" })
    });
    expect(sent[3]).toEqual({ type: "response.create" });
  });

  it("rejects non-image realtime media input for Azure sessions", async () => {
    const connectionFactory = vi.fn(async () => ({
      async sendJson() {},
      async recvJson() {
        return undefined;
      },
      async close() {}
    }));

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("gpt-realtime").connect();

    await expect(session.sendMedia({ data: "video", mediaType: "video/mp4" })).rejects.toThrow(
      'Provider "azure-openai" only supports realtime image media input, but received "video/mp4".'
    );
  });

  it("creates Azure realtime browser tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        client_secret: {
          value: "azure-ephemeral-secret",
          expires_at_ms: 1234
        }
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });

    const model = provider.realtimeModel!("gpt-realtime");
    const token = await model.createBrowserToken?.({
      instructions: "Be helpful.",
      providerOptions: {
        expires_after: { anchor: "created_at", seconds: 60 }
      }
    });

    expect(model.capabilities.realtime?.browserTokens).toBe(true);
    expect(token).toEqual({
      value: "azure-ephemeral-secret",
      expiresAtMs: 1234,
      rawResponse: expect.any(Object)
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.openai.azure.com/openai/v1/realtime/client_secrets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "api-key": "test" }),
        body: expect.stringContaining("\"model\":\"gpt-realtime\"")
      })
    );
  });
});
