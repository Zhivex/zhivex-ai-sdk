import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateObject, generateText, getAgentCapabilities, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { anthropicCodeExecutionTool, anthropicMcpToolset, anthropicWebSearchTool, createAnthropic } from "../src/index.js";

describe("anthropic adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "anthropic",
    modelId: "claude-3-5-sonnet",
    createModel: () => createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch })("claude-3-5-sonnet"),
    expectedAgentTier: "tier-b",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: false,
      jsonMode: false,
      toolChoice: true,
      parallelToolCalls: true,
      vision: true,
      files: true,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: true,
      webSearch: true
    }
  });

  runAgentProviderContractSuite({
    providerName: "anthropic",
    modelId: "claude-3-5-sonnet",
    expectedAgentTier: "tier-b",
    createModel: () => createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch })("claude-3-5-sonnet"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          content: [{ type: "text", text: "hello from anthropic agent" }],
          stop_reason: "end_turn"
        })
      );
    },
    mockToolRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          content: [{ type: "tool_use", id: "tool-1", name: "weather", input: { city: "Madrid" } }],
          stop_reason: "tool_use"
        })
      );
      fetchMock.mockResolvedValueOnce(
        Response.json({
          content: [{ type: "text", text: "Madrid is sunny" }],
          stop_reason: "end_turn"
        })
      );
    },
    mockStreamRun: () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              "event: content_block_delta\n" +
                'data: {"index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
                "event: content_block_delta\n" +
                'data: {"index":0,"delta":{"type":"text_delta","text":" world"}}\n\n' +
                "event: message_stop\n" +
                'data: {"stop_reason":"end_turn"}\n\n'
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
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps message responses into common text output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from anthropic");
    expect(result.finishReason).toBe("stop");
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("claude-3-5-sonnet")).toMatchObject(provider.languageModel("claude-3-5-sonnet"));
  });

  it("supports tool calls", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "tool_use", id: "tool-1", name: "math", input: { value: 2 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "result is 4" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "double 2",
      maxSteps: 2,
      tools: {
        math: tool({
          name: "math",
          schema: z.object({ value: z.number() }),
          execute: ({ value }) => ({ result: value * 2 })
        })
      }
    });

    expect(result.text).toBe("result is 4");
    expect(result.toolResults[0]?.toolName).toBe("math");
    expect(provider.embeddingModel).toBeUndefined();
  });

  it("falls back to prompted structured output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: JSON.stringify({ title: "Soup" }) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("claude-3-5-sonnet"),
      prompt: "Return JSON",
      schema: z.object({
        title: z.string()
      })
    });

    expect(result.object.title).toBe("Soup");
    expect(result.objectMode).toBe("prompted");
  });

  it("passes provider-specific options through to the Anthropic API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      providerOptions: {
        top_p: 0.9,
        metadata: { source: "test" }
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { top_p: number; metadata: { source: string } };
    expect(body.top_p).toBe(0.9);
    expect(body.metadata.source).toBe("test");
  });

  it("maps common tool choice to Anthropic tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
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
      tool_choice: { type: string; name: string };
    };
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "weather"
    });
  });

  it("maps toolChoice none to Anthropic tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
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

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tool_choice: { type: string };
    };
    expect(body.tool_choice).toEqual({
      type: "none"
    });
  });

  it("maps hosted Anthropic web search tools into native tool definitions", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        web: anthropicWebSearchTool({
          max_uses: 3
        })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tools: Array<{ type: string; name: string; max_uses: number }>;
    };
    expect(body.tools).toEqual([
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 3
      }
    ]);
    expect(getAgentCapabilities(provider("claude-3-5-sonnet")).codeExecution).toBe(true);
  });

  it("maps Anthropic code execution into native tools and beta headers", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [
          { type: "server_tool_use", id: "srv_1", name: "bash_code_execution", input: { command: "python -V" } },
          {
            type: "bash_code_execution_tool_result",
            tool_use_id: "srv_1",
            content: { type: "bash_code_execution_result", stdout: "Python 3.11", stderr: "", return_code: 0 }
          },
          { type: "text", text: "done" }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-sonnet-4"),
      prompt: "run code",
      tools: {
        code: anthropicCodeExecutionTool()
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body)) as { tools: Array<{ type: string; name: string }> };
    expect(headers["anthropic-beta"]).toBe("code-execution-2025-08-25");
    expect(body.tools).toEqual([{ type: "code_execution_20250825", name: "code_execution" }]);
    expect(result.messages.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider-data",
          provider: "anthropic",
          data: expect.objectContaining({ type: "server_tool_use" })
        }),
        expect.objectContaining({
          type: "provider-data",
          provider: "anthropic",
          data: expect.objectContaining({ type: "bash_code_execution_tool_result" })
        })
      ])
    );
  });

  it("maps reasoning budget tokens to Anthropic thinking", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      reasoning: {
        budgetTokens: 1024
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string; budget_tokens: number };
    };
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024
    });
  });

  it("maps reasoning effort to adaptive thinking and output_config for Claude Opus 4.7", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-7"),
      prompt: "hello",
      reasoning: {
        effort: "high"
      },
      providerOptions: {
        thinking: {
          type: "adaptive",
          display: "summarized"
        },
        output_config: {
          task_budget: {
            type: "tokens",
            total: 24000
          }
        }
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string; display?: string };
      output_config: { effort: string; task_budget: { type: string; total: number } };
    };
    expect(body.thinking).toEqual({
      type: "adaptive",
      display: "summarized"
    });
    expect(body.output_config).toEqual({
      effort: "high",
      task_budget: {
        type: "tokens",
        total: 24000
      }
    });
  });

  it("keeps manual thinking plus effort for Claude Opus 4.5", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-5"),
      prompt: "hello",
      reasoning: {
        budgetTokens: 1024,
        effort: "medium"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string; budget_tokens: number };
      output_config: { effort: string };
    };
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024
    });
    expect(body.output_config).toEqual({
      effort: "medium"
    });
  });

  it("sends adaptive thinking config on streaming requests for Claude Opus 4.7", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "event: content_block_delta\n" +
              'data: {"index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
              "event: message_stop\n" +
              'data: {"stop_reason":"end_turn"}\n\n'
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

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("claude-opus-4-7"),
      prompt: "hello",
      reasoning: {
        effort: "high"
      }
    });

    await result.collect();

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string };
      output_config: { effort: string };
    };
    expect(requestBody.thinking).toEqual({
      type: "adaptive"
    });
    expect(requestBody.output_config).toEqual({
      effort: "high"
    });
  });

  it("sends Claude Opus 4.8 fast mode and maps usage speed", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from opus 4.8" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4, speed: "fast" }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-opus-4-8"),
      prompt: "hello",
      reasoning: {
        effort: "xhigh"
      },
      providerOptions: {
        speed: "fast"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      model: string;
      speed: string;
      thinking: { type: string };
      output_config: { effort: string };
    };

    expect(body).toMatchObject({
      model: "claude-opus-4-8",
      speed: "fast",
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" }
    });
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      speed: "fast"
    });
  });

  it("preserves valid mid-conversation system messages for Claude Opus 4.8", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-8"),
      messages: [
        { role: "system", parts: [{ type: "text", text: "Initial instruction." }] },
        { role: "user", parts: [{ type: "text", text: "Start." }] },
        { role: "system", parts: [{ type: "text", text: "Apply this local instruction." }] },
        { role: "assistant", parts: [{ type: "text", text: "Ready." }] }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      system: string;
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(body.system).toBe("Initial instruction.");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Start." }] },
      { role: "system", content: "Apply this local instruction." },
      { role: "assistant", content: [{ type: "text", text: "Ready." }] }
    ]);
  });

  it("keeps legacy top-level system mapping before Claude Opus 4.8", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-7"),
      messages: [
        { role: "user", parts: [{ type: "text", text: "Start." }] },
        { role: "system", parts: [{ type: "text", text: "Legacy local instruction." }] },
        { role: "user", parts: [{ type: "text", text: "Continue." }] }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      system: string;
      messages: Array<{ role: string }>;
    };

    expect(body.system).toBe("Legacy local instruction.");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Start." }] },
      { role: "user", content: [{ type: "text", text: "Continue." }] }
    ]);
  });

  it("rejects invalid mid-conversation system message placement for Claude Opus 4.8", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-opus-4-8"),
        messages: [
          { role: "user", parts: [{ type: "text", text: "Start." }] },
          { role: "assistant", parts: [{ type: "text", text: "Ready." }] },
          { role: "system", parts: [{ type: "text", text: "Too late." }] }
        ]
      })
    ).rejects.toThrow(
      'Provider "anthropic" only supports mid-conversation system messages immediately after a user turn on Claude Opus 4.8 or later.'
    );
  });

  it("maps Anthropic refusals and preserves stop details", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "I cannot help with that." }],
        stop_reason: "refusal",
        stop_details: { type: "refusal", reason: "safety" },
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-opus-4-8"),
      prompt: "unsafe request"
    });

    expect(result.finishReason).toBe("refusal");
    expect(result.providerFinishReason).toBe("refusal");
    expect(result.steps[0]?.response.rawResponse).toMatchObject({
      stop_details: { type: "refusal", reason: "safety" }
    });
  });

  it("streams Anthropic refusal stop details as provider data", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "event: content_block_delta\n" +
              'data: {"index":0,"delta":{"type":"text_delta","text":"I cannot help with that."}}\n\n' +
              "event: message_delta\n" +
              'data: {"delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","reason":"safety"}},"usage":{"input_tokens":10,"output_tokens":4,"speed":"fast"}}\n\n' +
              "event: message_stop\n" +
              "data: {}\n\n"
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

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("claude-opus-4-8"),
      prompt: "unsafe request"
    });

    const final = await result.collect();
    const events = [];
    for await (const event of result.eventStream) {
      events.push(event);
    }

    expect(final).toMatchObject({
      text: "I cannot help with that.",
      finishReason: "refusal",
      providerFinishReason: "refusal",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        speed: "fast"
      }
    });
    expect(events).toContainEqual({
      type: "provider-data",
      provider: "anthropic",
      data: {
        type: "stop_details",
        stop_details: { type: "refusal", reason: "safety" }
      }
    });
  });

  it("maps PDF file parts into Anthropic document blocks and enables the Files API beta when needed", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-opus-4-7"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Summarize this PDF." },
            {
              type: "file",
              data: "file_011CNha8iCJcU1wXNR6q4V8w",
              mediaType: "application/pdf",
              filename: "brief.pdf"
            }
          ]
        }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body)) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };

    expect(headers["anthropic-beta"]).toContain("files-api-2025-04-14");
    expect(body.messages[0]?.content[1]).toEqual({
      type: "document",
      source: {
        type: "file",
        file_id: "file_011CNha8iCJcU1wXNR6q4V8w"
      },
      title: "brief.pdf"
    });
  });

  it("maps Anthropic MCP toolsets into native request fields", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        github: anthropicMcpToolset({
          server: {
            name: "github",
            url: "https://example.com/mcp",
            authorization_token: "secret"
          },
          default_config: {
            enabled: true
          }
        })
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    const body = JSON.parse(String(requestInit.body)) as {
      mcp_servers: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };

    expect(headers["anthropic-beta"]).toBe("mcp-client-2025-11-20");
    expect(body.mcp_servers).toEqual([
      {
        type: "url",
        name: "github",
        url: "https://example.com/mcp",
        authorization_token: "secret"
      }
    ]);
    expect(body.tools).toEqual([
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        default_config: {
          enabled: true
        }
      }
    ]);
  });

  it("parses Anthropic MCP blocks into provider-data parts", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [
          {
            type: "mcp_tool_use",
            id: "mcpu_1",
            name: "fetch_docs",
            server_name: "github",
            input: { path: "README.md" }
          },
          {
            type: "mcp_tool_result",
            tool_use_id: "mcpu_1",
            server_name: "github",
            content: { text: "ok" }
          }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        github: anthropicMcpToolset({
          server: {
            name: "github",
            url: "https://example.com/mcp"
          }
        })
      }
    });

    expect(result.messages.at(-1)?.parts).toEqual([
      {
        type: "provider-data",
        provider: "anthropic",
        data: {
          type: "mcp_tool_use",
          id: "mcpu_1",
          name: "fetch_docs",
          server_name: "github",
          input: {
            path: "README.md"
          }
        }
      },
      {
        type: "provider-data",
        provider: "anthropic",
        data: {
          type: "mcp_tool_result",
          tool_use_id: "mcpu_1",
          server_name: "github",
          content: {
            text: "ok"
          }
        }
      }
    ]);
  });

  it("streams Anthropic MCP blocks as provider-data events", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "event: content_block_start\n" +
              'data: {"index":0,"content_block":{"type":"mcp_tool_use","id":"mcpu_1","name":"fetch_docs","server_name":"github","input":{"path":"README.md"}}}\n\n' +
              "event: content_block_delta\n" +
              'data: {"index":1,"delta":{"type":"text_delta","text":"approved"}}\n\n' +
              "event: message_stop\n" +
              'data: {"stop_reason":"end_turn"}\n\n'
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

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        github: anthropicMcpToolset({
          server: {
            name: "github",
            url: "https://example.com/mcp"
          }
        })
      }
    });

    const final = await result.collect();
    expect(final.text).toBe("approved");
    expect(final.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "anthropic",
      data: {
        type: "mcp_tool_use",
        id: "mcpu_1",
        name: "fetch_docs",
        server_name: "github",
        input: {
          path: "README.md"
        }
      }
    });
  });

  it("rejects unsupported reasoning effort for Anthropic", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-3-5-sonnet"),
        prompt: "hello",
        reasoning: {
          effort: "medium"
        }
      })
    ).rejects.toThrow('Provider "anthropic" does not support "reasoning.effort" for this model.');
  });

  it("rejects budgetTokens for Claude Opus 4.8", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-opus-4-8"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 1024
        }
      })
    ).rejects.toThrow(
      'Provider "anthropic" does not support "reasoning.budgetTokens" for Claude Opus 4.7 or later; use "reasoning.effort" instead.'
    );
  });

  it("rejects explicit sampling controls for Claude Opus 4.8", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-opus-4-8"),
        prompt: "hello",
        temperature: 0
      })
    ).rejects.toThrow(
      'Provider "anthropic" does not support explicit "temperature" for Claude Opus 4.7 or later; omit it from the request.'
    );

    await expect(
      generateText({
        model: provider("claude-opus-4-8"),
        prompt: "hello",
        providerOptions: {
          top_p: 0.9
        }
      })
    ).rejects.toThrow(
      'Provider "anthropic" does not support explicit "top_p" or "top_k" for Claude Opus 4.7 or later; omit them from the request.'
    );
  });
});
