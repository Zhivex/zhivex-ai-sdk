import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateObject, generateText, hostedTool, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createDeepSeek } from "../src/index.js";

describe("deepseek adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "deepseek",
    modelId: "deepseek-v4-flash",
    createModel: () => createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch })("deepseek-v4-flash"),
    expectedAgentTier: "tier-c",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: true,
      parallelToolCalls: true,
      vision: false,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: true,
      webSearch: false
    }
  });

  runAgentProviderContractSuite({
    providerName: "deepseek",
    modelId: "deepseek-v4-flash",
    expectedAgentTier: "tier-c",
    createModel: () => createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch })("deepseek-v4-flash"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "hello from deepseek agent" } }]
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
                "data: {\"choices\":[{\"delta\":{\"content\":\" deepseek\"},\"finish_reason\":\"stop\"}]}\n\n" +
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
        choices: [{ finish_reason: "stop", message: { content: "hello from deepseek" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("deepseek-v4-pro"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from deepseek");
    expect(result.usage?.totalTokens).toBe(7);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
  });

  it("streams incremental text", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" deepseek\"},\"finish_reason\":\"stop\",\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":3,\"total_tokens\":7}}]}\n\n" +
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

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("deepseek-v4-pro"),
      prompt: "hello"
    });

    const final = await result.collect();
    expect(final.text).toBe("hello deepseek");
    expect(final.usage?.totalTokens).toBe(7);
  });

  it("supports tool calls and JSON object structured output", async () => {
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

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("deepseek-v4-pro"),
      prompt: "Use weather tool and return JSON.",
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

    const firstRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstBody = JSON.parse(String(firstRequest.body)) as {
      response_format: { type: string; json_schema?: unknown };
    };
    expect(firstBody.response_format).toEqual({ type: "json_object" });
  });

  it("maps common reasoning config to DeepSeek thinking mode", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "reasoned" } }]
      })
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("deepseek-v4-pro"),
      prompt: "hello",
      reasoning: {
        effort: "xhigh"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string };
      reasoning_effort: string;
    };
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("max");
  });

  it("disables DeepSeek thinking for reasoning effort none", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "plain" } }]
      })
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("deepseek-v4-flash"),
      prompt: "hello",
      reasoning: {
        effort: "none"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string };
      reasoning_effort?: string;
    };
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("preserves DeepSeek reasoning content across a multi-step tool loop", async () => {
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

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("deepseek-v4-pro"),
      prompt: "weather",
      maxSteps: 2,
      reasoning: {
        effort: "high"
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

  it("streams reasoning content as provider data", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Think\"}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" answer\"},\"finish_reason\":\"stop\"}]}\n\n" +
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

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("deepseek-v4-pro"),
      prompt: "hello",
      reasoning: {
        effort: "high"
      }
    });

    const final = await result.collect();
    expect(final.text).toBe(" answer");
    expect(final.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "deepseek",
      data: {
        type: "reasoning_content",
        reasoningContent: "Think"
      }
    });
  });

  it("rejects hosted tools", async () => {
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "research",
        tools: {
          search: hostedTool({
            name: "search",
            provider: "deepseek",
            type: "deepseek:web_search",
            toolClass: "web-search"
          })
        }
      })
    ).rejects.toThrow('Provider "deepseek" does not support hosted tools.');
  });

  it("requires an API key", () => {
    expect(() => createDeepSeek()).toThrow("Missing DeepSeek API key.");
  });

  it("surfaces provider HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "hello"
      })
    ).rejects.toThrow("DeepSeek request failed with status 400.");
  });
});
