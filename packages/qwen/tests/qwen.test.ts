import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTextMessage, embed, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createQwen, qwenCodeInterpreterTool, qwenWebExtractorTool, qwenWebSearchTool } from "../src/index.js";

describe("qwen adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "qwen",
    modelId: "qwen-plus",
    createModel: () => createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch })("qwen-plus"),
    createEmbeddingModel: () =>
      createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch }).embeddingModel("text-embedding-v4"),
    expectedAgentTier: "tier-b",
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
    providerName: "qwen",
    modelId: "qwen-plus",
    expectedAgentTier: "tier-b",
    createModel: () => createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch })("qwen-plus"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "resp_1",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hello from qwen agent" }] }]
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
              "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n" +
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\" world\"}\n\n" +
                "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n" +
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
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps Responses API results to the common contract by default", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "hello from qwen" }] }],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen-plus"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from qwen");
    expect(result.usage?.totalTokens).toBe(7);
    expect(result.messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: "hello from qwen" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");
  });

  it("keeps Chat Completions available through apiMode: chat", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from qwen" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen-plus"),
      prompt: "hello",
      providerOptions: {
        apiMode: "chat"
      }
    });

    expect(result.text).toBe("hello from qwen");
    expect(result.usage?.totalTokens).toBe(7);
    expect(result.messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: "hello from qwen" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("qwen-plus")).toMatchObject(provider.languageModel("qwen-plus"));
  });

  it("streams incremental text", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n" +
              "data: {\"type\":\"response.output_text.delta\",\"delta\":\" world\"}\n\n" +
              "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n" +
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

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("qwen-plus"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello world");
  });

  it("supports tool calls and native structured output", async () => {
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
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify({ city: "Madrid", forecast: "sunny" }) }]
          }
        ]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("qwen-plus"),
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

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await embed({
      model: provider.embeddingModel("text-embedding-v4"),
      value: "hello"
    });

    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("passes provider-specific options through to the Qwen API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "hello from qwen" }] }]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("qwen-plus"),
      prompt: "hello",
      providerOptions: {
        top_p: 0.8,
        user: "test-user"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { top_p: number; user: string; apiMode?: string };
    expect(body.top_p).toBe(0.8);
    expect(body.user).toBe("test-user");
    expect(body.apiMode).toBeUndefined();
  });

  it("maps common tool choice to Qwen tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "hello from qwen" }] }]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("qwen-plus"),
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

  it("rejects common reasoning config for Qwen through the shared capabilities contract", async () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "reasoned" }] }]
      })
    );

    await generateText({
      model: provider("qwen-plus"),
      prompt: "hello",
      reasoning: {
        effort: "medium",
        budgetTokens: 64
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      enable_thinking: boolean;
      thinking_budget: number;
    };
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(64);
  });

  it("preserves Qwen reasoning content across a multi-step tool loop", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              reasoning_content: "Need to call the tool first.",
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
        choices: [{ finish_reason: "stop", message: { content: "Sunny in Madrid" } }]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen-plus"),
      prompt: "weather",
      maxSteps: 2,
      providerOptions: {
        apiMode: "chat"
      },
      reasoning: {
        effort: "medium"
      },
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 26 })
        })
      }
    });

    expect(result.text).toBe("Sunny in Madrid");
    const followupRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const followupBody = JSON.parse(String(followupRequest.body)) as {
      preserve_thinking?: boolean;
      messages: Array<{ role: string; reasoning_content?: string }>;
    };
    expect(followupBody.preserve_thinking).toBe(true);
    expect(followupBody.messages.find((message) => message.role === "assistant")?.reasoning_content).toBe(
      "Need to call the tool first."
    );
  });

  it("streams reasoning content as provider data for Qwen", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"type\":\"response.reasoning_text.delta\",\"delta\":\"Think\"}\n\n" +
              "data: {\"type\":\"response.output_text.delta\",\"delta\":\" answer\"}\n\n" +
              "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":4,\"output_tokens\":3,\"total_tokens\":7}}}\n\n" +
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

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("qwen-plus"),
      prompt: "hello",
      reasoning: {
        effort: "medium"
      }
    });

    const final = await result.collect();
    expect(final.text).toBe(" answer");
    expect(final.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "qwen",
      data: {
        type: "reasoning_content",
        reasoningContent: "Think"
      }
    });
  });

  it("serializes Qwen hosted tools in Responses mode", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("qwen-plus"),
      prompt: "research",
      tools: {
        search: qwenWebSearchTool(),
        extract: qwenWebExtractorTool({ max_results: 2 }),
        code: qwenCodeInterpreterTool()
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { tools: Array<Record<string, unknown>> };
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "web_search" }),
        expect.objectContaining({ type: "web_extractor", max_results: 2 }),
        expect.objectContaining({ type: "code_interpreter" })
      ])
    );
  });

  it("rejects hosted tools in Chat Completions compatibility mode", async () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("qwen-plus"),
        prompt: "research",
        providerOptions: {
          apiMode: "chat"
        },
        tools: {
          search: qwenWebSearchTool()
        }
      })
    ).rejects.toThrow('Provider "qwen" does not support hosted tools.');
  });
});
