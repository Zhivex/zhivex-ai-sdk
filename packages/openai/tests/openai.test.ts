import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createTextMessage,
  embed,
  getAgentCapabilities,
  generateGroundedText,
  generateObject,
  generateSpeech,
  generateText,
  hostedTool,
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
  openAIMcpApprovalResponse,
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
        { type: "shell" },
        { type: "apply_patch" },
        { type: "tool_search" }
      ])
    );
  });

  it("rejects Responses tools that the selected OpenAI model does not support", async () => {
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    expect(getAgentCapabilities(provider("gpt-5.4")).toolSearch).toBe(true);
    expect(getAgentCapabilities(provider("gpt-5.4-nano")).toolSearch).toBe(false);

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
      output: {
        stdout: "ran:echo hi"
      }
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
        authorization: "Bearer test",
        "openai-beta": "realtime=v1"
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
    const session = await provider.realtimeModel!("gpt-realtime").connect({
      instructions: "Be brief.",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: () => ({ ok: true })
        })
      }
    });

    await session.sendMedia({ data: "image-bytes", mediaType: "image/jpeg" });
    await session.sendText("hello");
    await session.close();

    expect(connectionFactory).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      type: "session.update",
      session: expect.objectContaining({
        model: "gpt-realtime",
        instructions: "Be brief.",
        tools: [expect.objectContaining({ type: "function" })]
      })
    });
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
      instructions: "Be helpful."
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
        headers: expect.objectContaining({ authorization: "Bearer test" })
      })
    );
  });
});
