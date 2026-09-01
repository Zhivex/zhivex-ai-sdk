import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateObject, generateText, hostedTool, streamObject, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createDeepSeek } from "../src/index.js";

const sseResponse = (...events: Array<Record<string, unknown> | "[DONE]">) => {
  const body = new ReadableStream({
    start(controller) {
      const payload = events
        .map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`)
        .join("");
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    }
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
};

describe("deepseek adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "deepseek",
    modelId: "deepseek-v4-flash",
    createModel: () => createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch })("deepseek-v4-flash"),
    expectedAgentTier: "tier-b",
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
      contextCaching: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      reasoning: true,
      webSearch: false
    }
  });

  runAgentProviderContractSuite({
    providerName: "deepseek",
    modelId: "deepseek-v4-flash",
    expectedAgentTier: "tier-b",
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

  it("maps DeepSeek V4 Flash Vision image and file inputs in order", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "vision ok" } }]
      })
    );
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider("deepseek-v4-flash-vision-exp");

    expect(model.capabilities.vision).toBe(true);
    expect(model.capabilities.files).toBe(true);

    await generateText({
      model,
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Compare these images." },
            {
              type: "image",
              image: "aGVsbG8=",
              mediaType: "image/png",
              providerMetadata: { deepseekDetail: "high" }
            },
            { type: "file", data: "file-api-image_123", mediaType: "image/jpeg" }
          ]
        }
      ]
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.model).toBe("deepseek-v4-flash-vision-exp");
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these images." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "high" }
          },
          { type: "file", file_id: "file-api-image_123" }
        ]
      }
    ]);
  });

  it("rejects DeepSeek vision media on unsupported models and roles", async () => {
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("deepseek-v4-flash"),
        messages: [
          {
            role: "user",
            parts: [{ type: "image", image: "aGVsbG8=", mediaType: "image/png" }]
          }
        ]
      })
    ).rejects.toThrow('Model "deepseek/deepseek-v4-flash" does not support image inputs.');

    await expect(
      generateText({
        model: provider("deepseek-v4-flash-vision-exp"),
        messages: [
          {
            role: "assistant",
            parts: [{ type: "image", image: "aGVsbG8=", mediaType: "image/png" }]
          }
        ]
      })
    ).rejects.toThrow("only supports image and file inputs in user messages");

    expect(fetchMock).not.toHaveBeenCalled();
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
      messages: Array<{ role: string; content: string }>;
    };
    expect(firstBody.response_format).toEqual({ type: "json_object" });
    expect(firstBody.messages[0]?.role).toBe("system");
    expect(firstBody.messages[0]?.content).toContain("Return only valid JSON matching this JSON Schema:");
    expect(firstBody.messages[0]?.content).toContain('"city"');
    expect(firstBody.messages[0]?.content).toContain('"forecast"');
  });

  it("adds the DeepSeek JSON instruction and schema to streamed native structured output", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        {
          choices: [
            {
              delta: { content: '{"city":"Buenos Aires",' },
              finish_reason: null
            }
          ]
        },
        {
          choices: [
            {
              delta: { content: '"country":"Argentina"}' },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 8,
            total_tokens: 18
          }
        },
        "[DONE]"
      )
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamObject({
      model: provider("deepseek-v4-flash"),
      prompt: "Return the city-country pair for Buenos Aires, Argentina.",
      schema: z.object({
        city: z.string(),
        country: z.string()
      }),
      mode: "native"
    });

    await expect(result.collect()).resolves.toMatchObject({
      object: {
        city: "Buenos Aires",
        country: "Argentina"
      },
      objectMode: "native"
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining('"country"')
    });
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
      messages: Array<{ role: string; content: string; reasoning_content?: string }>;
    };
    expect(followupBody.preserve_thinking).toBeUndefined();
    expect(followupBody.messages.find((message) => message.role === "assistant")?.reasoning_content).toBe(
      "Need to call the tool first."
    );
    expect(followupBody.messages.find((message) => message.role === "assistant")?.content).toBe("");
  });

  it("streams reasoning content and logprobs as provider data", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Think\"},\"logprobs\":{\"reasoning_content\":[{\"token\":\"Think\",\"logprob\":-0.1}]}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" answer\"},\"logprobs\":{\"content\":[{\"token\":\" answer\",\"logprob\":-0.2}]},\"finish_reason\":\"stop\"}]}\n\n" +
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
      },
      providerOptions: {
        logprobs: true,
        top_logprobs: 2
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
    expect(final.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "deepseek",
      data: {
        type: "logprobs",
        logprobs: {
          content: [{ token: " answer", logprob: -0.2 }]
        }
      }
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      logprobs: true,
      top_logprobs: 2
    });
  });

  it("executes a streamed tool loop when tool arguments and finish reason arrive in separate chunks", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        { choices: [{ delta: { reasoning_content: "Need weather." } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "tool-stream-1",
                    function: { name: "weather", arguments: '{"ci' }
                  }
                ]
              }
            }
          ]
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: 'ty":"Madrid"}' } }]
              }
            }
          ]
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 10,
            prompt_cache_hit_tokens: 4,
            completion_tokens: 5,
            completion_tokens_details: { reasoning_tokens: 2 },
            total_tokens: 15
          }
        },
        "[DONE]"
      )
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        { choices: [{ delta: { content: "Sunny in Madrid" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 20,
            prompt_cache_hit_tokens: 12,
            completion_tokens: 4,
            completion_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 24
          }
        },
        "[DONE]"
      )
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("deepseek-v4-pro"),
      prompt: "weather",
      maxSteps: 2,
      reasoning: { effort: "high" },
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      }
    });

    const final = await result.collect();
    expect(final.text).toBe("Sunny in Madrid");
    expect(final.toolResults).toHaveLength(1);
    expect(final.toolResults[0]).toMatchObject({
      toolCallId: "tool-stream-1",
      toolName: "weather",
      output: { city: "Madrid", forecast: "sunny" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const followupRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const followupBody = JSON.parse(String(followupRequest.body)) as {
      preserve_thinking?: boolean;
      messages: Array<{ role: string; content: string; reasoning_content?: string }>;
    };
    expect(followupBody.preserve_thinking).toBeUndefined();
    expect(followupBody.messages.find((message) => message.role === "assistant")).toMatchObject({
      content: "",
      reasoning_content: "Need weather."
    });
  });

  it("maps official cache and reasoning usage and emits exactly one streamed finish", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        { choices: [{ delta: { content: "partial" } }] },
        { choices: [{ delta: {}, finish_reason: "insufficient_system_resource" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 30,
            prompt_cache_hit_tokens: 18,
            prompt_cache_miss_tokens: 12,
            completion_tokens: 8,
            completion_tokens_details: { reasoning_tokens: 6 },
            total_tokens: 38
          }
        },
        "[DONE]"
      )
    );

    const model = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch })("deepseek-v4-pro");
    const events = [];
    for await (const event of await model.stream({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(event);
    }

    const finishes = events.filter((event) => event.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      finishReason: "error",
      providerFinishReason: "insufficient_system_resource",
      usage: {
        inputTokens: 30,
        cachedInputTokens: 18,
        outputTokens: 8,
        reasoningTokens: 6,
        totalTokens: 38
      }
    });
  });

  it("maps cache and reasoning usage for non-streaming responses", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "insufficient_system_resource", message: { content: "partial" } }],
        usage: {
          prompt_tokens: 40,
          prompt_cache_hit_tokens: 25,
          prompt_cache_miss_tokens: 15,
          completion_tokens: 9,
          completion_tokens_details: { reasoning_tokens: 7 },
          total_tokens: 49
        }
      })
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({ model: provider("deepseek-v4-pro"), prompt: "hello" });

    expect(result.finishReason).toBe("error");
    expect(result.providerFinishReason).toBe("insufficient_system_resource");
    expect(result.usage).toEqual({
      inputTokens: 40,
      cachedInputTokens: 25,
      outputTokens: 9,
      reasoningTokens: 7,
      totalTokens: 49
    });
  });

  it("retries retryable HTTP responses for generation", async () => {
    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "recovered" } }] })
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("deepseek-v4-flash"),
      prompt: "hello",
      maxRetries: 1,
      retryBackoffMs: 0
    });

    expect(result.text).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries retryable HTTP responses before consuming a stream", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        { choices: [{ delta: { content: "recovered" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "[DONE]"
      )
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("deepseek-v4-flash"),
      prompt: "hello",
      maxRetries: 1,
      retryBackoffMs: 0
    });

    expect((await result.collect()).text).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts the official max reasoning effort through the common API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "deep result" } }] })
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("deepseek-v4-pro"),
      prompt: "hello",
      reasoning: { effort: "max" }
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max"
    });
  });

  it("respects provider options and gives common options precedence", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "configured" } }] })
    );

    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("deepseek-v4-pro"),
      prompt: "hello",
      temperature: 0.2,
      maxTokens: 64,
      reasoning: { effort: "none" },
      tools: {
        weather: tool({ name: "weather", schema: z.object({ city: z.string() }) })
      },
      toolChoice: "required",
      providerOptions: {
        thinking: { type: "enabled" },
        reasoning_effort: "max",
        temperature: 0.8,
        max_tokens: 32,
        response_format: { type: "json_object" },
        tool_choice: "none",
        user_id: "tenant_123",
        stop: ["END"]
      }
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      thinking: { type: "disabled" },
      temperature: 0.2,
      max_tokens: 64,
      response_format: { type: "json_object" },
      tool_choice: "required",
      user_id: "tenant_123",
      stop: ["END"]
    });
    const body = JSON.parse(String(request.body));
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "Return only valid JSON."
    });
  });

  it("routes DeepSeek strict tools through the beta endpoint automatically", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] })
    );

    const provider = createDeepSeek({
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("deepseek-v4-pro"),
      prompt: "hello",
      tools: {
        weather: tool({ name: "weather", schema: z.object({ city: z.string() }) })
      },
      providerOptions: { strictTools: true }
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      strictTools?: boolean;
      tools: Array<{ function: { strict?: boolean } }>;
    };
    expect(body.strictTools).toBeUndefined();
    expect(body.tools[0]?.function.strict).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/beta/chat/completions");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["optional properties", z.object({ city: z.string().optional() }), "requires every property"],
    ["string length constraints", z.object({ city: z.string().min(1) }), 'does not support "minLength"'],
    ["array length constraints", z.object({ cities: z.array(z.string()).min(1) }), 'does not support "minItems"'],
    ["unsupported string formats", z.object({ website: z.url() }), "unsupported string format"]
  ])("rejects unsupported DeepSeek strict schema features: %s", async (_name, schema, message) => {
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "Call the tool.",
        tools: {
          inspect: tool({
            name: "inspect",
            schema
          })
        },
        providerOptions: { strictTools: true }
      })
    ).rejects.toThrow(String(message));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports beta chat prefix completion without leaking SDK-only options", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: " completed" } }] })
    );
    const provider = createDeepSeek({
      apiKey: "test",
      baseURL: "https://stable.example/v1",
      betaBaseURL: "https://beta.example/beta",
      fetch: fetchMock as typeof fetch
    });

    await generateText({
      model: provider("deepseek-v4-pro"),
      prompt: "Write a sentence",
      providerOptions: {
        prefix: {
          content: "The answer is",
          reasoningContent: "I should finish this precisely."
        }
      }
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://beta.example/beta/chat/completions");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      prefix?: unknown;
      messages: Array<Record<string, unknown>>;
    };
    expect(body.prefix).toBeUndefined();
    expect(body.messages.at(-1)).toEqual({
      role: "assistant",
      content: "The answer is",
      prefix: true,
      reasoning_content: "I should finish this precisely."
    });
  });

  it("exposes FIM, models, balance, and files clients on the callable provider", () => {
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider.fim.generate).toBeTypeOf("function");
    expect(provider.fim.stream).toBeTypeOf("function");
    expect(provider.models.list).toBeTypeOf("function");
    expect(provider.balance.get).toBeTypeOf("function");
    expect(provider.files.upload).toBeTypeOf("function");
    expect(provider.files.list).toBeTypeOf("function");
    expect(provider.files.get).toBeTypeOf("function");
    expect(provider.files.delete).toBeTypeOf("function");
  });

  it("omits auto tool choice and rejects forced tool choice while thinking", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] })
    );
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const tools = { weather: tool({ name: "weather", schema: z.object({ city: z.string() }) }) };

    await generateText({
      model: provider("deepseek-v4-pro"),
      prompt: "hello",
      tools,
      toolChoice: "auto",
      reasoning: { effort: "high" }
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).tool_choice).toBeUndefined();

    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "hello",
        tools,
        toolChoice: "required",
        reasoning: { effort: "high" }
      })
    ).rejects.toThrow("does not support explicit tool choice while thinking mode is enabled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ temperature: 0.3 }, 'does not support "temperature" while thinking mode is enabled'],
    [{ top_p: 0.8 }, 'does not support "top_p" while thinking mode is enabled'],
    [{ frequency_penalty: 0.2 }, 'no longer supports "frequency_penalty" or "presence_penalty"'],
    [{ presence_penalty: 0.2 }, 'no longer supports "frequency_penalty" or "presence_penalty"'],
    [{ user: "legacy-user" }, 'uses "user_id" instead of "user"'],
    [{ user_id: "invalid user" }, '"user_id" must contain 1-512 characters'],
    [{ prefix: { content: "" } }, '"prefix" requires non-empty "content" or "reasoningContent"']
  ])("rejects unsupported or invalid provider option %j", async (providerOptions, message) => {
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "hello",
        providerOptions
      })
    ).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ temperature: 2.1 }, '"temperature" must be between 0 and 2'],
    [{ top_p: 1.1 }, '"top_p" must be between 0 and 1'],
    [{ stop: Array.from({ length: 17 }, (_, index) => `${index}`) }, '"stop" accepts at most 16 sequences'],
    [{ stop: ["ok", 1] }, '"stop" must be a string or an array of strings']
  ])("validates DeepSeek non-thinking request limits before network I/O: %j", async (providerOptions, message) => {
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "hello",
        reasoning: { effort: "none" },
        providerOptions: providerOptions as any
      })
    ).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates DeepSeek function count and names before network I/O", async () => {
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const tooManyTools = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [
        `tool_${index}`,
        tool({ name: `tool_${index}`, schema: z.object({ value: z.string() }) })
      ])
    );

    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "hello",
        tools: tooManyTools
      })
    ).rejects.toThrow("at most 128 function tools");

    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "hello",
        tools: {
          invalid: tool({ name: "invalid tool", schema: z.object({ value: z.string() }) })
        }
      })
    ).rejects.toThrow("must contain 1-64 letters, numbers, underscores, or hyphens");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported common reasoning controls before sending a request", async () => {
    const provider = createDeepSeek({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "hello",
        reasoning: { effort: "minimal" }
      })
    ).rejects.toThrow('does not support reasoning effort "minimal"');
    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "hello",
        reasoning: { mode: "pro" }
      })
    ).rejects.toThrow('does not support reasoning mode "pro"');
    await expect(
      generateText({
        model: provider("deepseek-v4-pro"),
        prompt: "hello",
        reasoning: { budgetTokens: 1024 }
      })
    ).rejects.toThrow('does not support "reasoning.budgetTokens"');
    expect(fetchMock).not.toHaveBeenCalled();
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
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect(() => createDeepSeek()).toThrow("Missing DeepSeek API key.");
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
    }
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
