import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { anthropicMcpToolset, anthropicWebSearchTool, createAnthropic } from "../src/index.js";

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
      files: false,
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
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3
      }
    ]);
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
    ).rejects.toThrow('Provider "anthropic" does not support "reasoning.effort".');
  });
});
