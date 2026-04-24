import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTextMessage, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createKimi, kimiFormulaTools, kimiWebSearchTool } from "../src/index.js";

describe("kimi adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "kimi",
    modelId: "kimi-k2-0905-preview",
    createModel: () => createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch })("kimi-k2-0905-preview"),
    expectedAgentTier: "tier-c",
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
      embeddings: false,
      reasoning: false,
      webSearch: false
    }
  });

  runAgentProviderContractSuite({
    providerName: "kimi",
    modelId: "kimi-k2-0905-preview",
    expectedAgentTier: "tier-c",
    createModel: () => createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch })("kimi-k2-0905-preview"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "hello from kimi agent" } }]
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
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps chat completions to the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from kimi" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("kimi-k2-0905-preview"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from kimi");
    expect(result.usage?.totalTokens).toBe(7);
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("kimi-k2-0905-preview")).toMatchObject(provider.languageModel("kimi-k2-0905-preview"));
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

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("kimi-k2-0905-preview"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello world");
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

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("kimi-k2-0905-preview"),
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
  });

  it("passes provider-specific options through to the Kimi API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from kimi" } }]
      })
    );

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("kimi-k2-0905-preview"),
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

  it("maps common tool choice to Kimi tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from kimi" } }]
      })
    );

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("kimi-k2-0905-preview"),
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

  it("rejects common reasoning config for Kimi through the shared capabilities contract", async () => {
    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("kimi-k2-0905-preview"),
        prompt: "hello",
        reasoning: {
          effort: "medium"
        }
      })
    ).rejects.toThrow('Model "kimi/kimi-k2-0905-preview" does not support reasoning.');
  });

  it("declares reasoning support for thinking-capable Kimi models", () => {
    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("kimi-k2.5").capabilities.reasoning).toBe(true);
    expect(provider("kimi-k2-thinking").capabilities.reasoning).toBe(true);
  });

  it("maps common reasoning config to Kimi thinking mode", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "reasoned" } }]
      })
    );

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("kimi-k2.5"),
      prompt: "hello",
      reasoning: {
        effort: "medium"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string };
    };
    expect(body.thinking).toEqual({
      type: "enabled"
    });
  });

  it("rejects unsupported tool choice when Kimi reasoning is enabled", async () => {
    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("kimi-k2.5"),
        prompt: "hello",
        reasoning: {
          effort: "medium"
        },
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
      })
    ).rejects.toThrow('Provider "kimi" only supports "toolChoice=auto" or "toolChoice=none" when reasoning is enabled.');
  });

  it("preserves Kimi reasoning content across a multi-step tool loop", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              reasoning_content: "Need to inspect the weather tool first.",
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

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("kimi-k2.5"),
      prompt: "weather",
      maxSteps: 2,
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
      messages: Array<{ role: string; reasoning_content?: string }>;
    };
    expect(followupBody.messages.find((message) => message.role === "assistant")?.reasoning_content).toBe(
      "Need to inspect the weather tool first."
    );
  });

  it("streams reasoning content as provider data for Kimi", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Think\"}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" answer\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":3,\"total_tokens\":7}}\n\n" +
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

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("kimi-k2.5"),
      prompt: "hello",
      reasoning: {
        effort: "medium"
      }
    });

    const final = await result.collect();
    expect(final.text).toBe(" answer");
    expect(final.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "kimi",
      data: {
        type: "reasoning_content",
        reasoningContent: "Think"
      }
    });
  });

  it("serializes Kimi official Formula tools as function tools and executes formula fibers", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  {
                    id: "call_1",
                    function: {
                      name: "web_search",
                      arguments: "{\"query\":\"news\"}"
                    }
                  }
                ]
              }
            }
          ]
        })
      )
      .mockResolvedValueOnce(Response.json({ output: [{ title: "Result" }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }));

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("kimi-k2-0905-preview"),
      prompt: "search",
      maxSteps: 2,
      tools: {
        web_search: kimiWebSearchTool({ apiKey: "test", fetch: fetchMock as typeof fetch })
      }
    });

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      tools: Array<{ function: { name: string; parameters: unknown } }>;
    };
    expect(firstBody.tools[0]?.function.name).toBe("web_search");
    expect(firstBody.tools[0]?.function.parameters).toMatchObject({ required: ["query"] });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.moonshot.ai/v1/formulas/moonshot/web-search:latest/fibers");
    expect(result.text).toContain("done");
  });

  it("loads Kimi Formula tool definitions from the official tools endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        tools: [
          {
            type: "function",
            function: {
              name: "fetch",
              description: "Fetch URL",
              parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
            }
          }
        ]
      })
    );

    const tools = await kimiFormulaTools({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      formulas: ["moonshot/fetch:latest"]
    });

    expect(Object.keys(tools)).toEqual(["fetch"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.moonshot.ai/v1/formulas/moonshot/fetch:latest/tools");
  });
});
