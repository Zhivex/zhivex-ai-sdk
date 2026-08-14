import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTextMessage, embed, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createOllama } from "../src/index.ts";

describe("ollama adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "ollama",
    modelId: "llama3.2",
    createModel: () => createOllama({ fetch: fetchMock as typeof fetch })("llama3.2"),
    createEmbeddingModel: () => createOllama({ fetch: fetchMock as typeof fetch }).embeddingModel("embeddinggemma"),
    expectedAgentTier: "tier-c",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: false,
      parallelToolCalls: true,
      vision: true,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: true,
      reasoning: false,
      webSearch: false
    }
  });

  runAgentProviderContractSuite({
    providerName: "ollama",
    modelId: "llama3.2",
    expectedAgentTier: "tier-c",
    createModel: () => createOllama({ fetch: fetchMock as typeof fetch })("llama3.2"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          message: { content: "hello from ollama agent" },
          done_reason: "stop"
        })
      );
    },
    mockToolRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "weather",
                  arguments: { city: "Madrid" }
                }
              }
            ]
          },
          done_reason: "tool_calls"
        })
      );
      fetchMock.mockResolvedValueOnce(
        Response.json({
          message: { content: "Madrid is sunny" },
          done_reason: "stop"
        })
      );
    },
    mockStreamRun: () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({ message: { content: "hello" }, done: false })}\n` +
                `${JSON.stringify({ message: { content: " world" }, done: true, done_reason: "stop" })}\n`
            )
          );
          controller.close();
        }
      });

      fetchMock.mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" }
        })
      );
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps generated text into the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { content: "hello from ollama" },
        prompt_eval_count: 5,
        eval_count: 4,
        done_reason: "stop"
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("llama3.2"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from ollama");
    expect(result.usage?.totalTokens).toBe(9);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestInit.headers).has("authorization")).toBe(false);
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createOllama({ fetch: fetchMock as typeof fetch });

    expect(provider("llama3.2")).toMatchObject(provider.languageModel("llama3.2"));
  });

  it("sends last user images as base64 payloads", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "ok" } }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("llava"),
      messages: [
        createTextMessage("assistant", "context"),
        {
          role: "user",
          parts: [
            { type: "text", text: "describe" },
            { type: "image", image: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }
          ]
        }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { messages: Array<{ images?: string[] }> };
    expect(body.messages.at(-1)?.images).toEqual(["aGVsbG8="]);
  });

  it("surfaces invalid model errors as validation errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error("model not found"));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("missing"),
        messages: [createTextMessage("user", "hello")]
      })
    ).rejects.toThrow("model not found");
  });

  it("passes provider-specific options through to Ollama", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "hello from ollama" } }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("llama3.2"),
      prompt: "hello",
      providerOptions: {
        keep_alive: "5m",
        logprobs: true,
        top_logprobs: 5
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      keep_alive: string;
      logprobs: boolean;
      top_logprobs: number;
    };
    expect(body.keep_alive).toBe("5m");
    expect(body.logprobs).toBe(true);
    expect(body.top_logprobs).toBe(5);
  });

  it("streams incremental text through the common streaming contract", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ message: { content: "hello" }, done: false })}\n` +
              `${JSON.stringify({
                message: { content: " world" },
                done: true,
                done_reason: "stop",
                prompt_eval_count: 5,
                eval_count: 4
              })}\n`
          )
        );
        controller.close();
      }
    });

    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" }
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("llama3.2"),
      prompt: "hello"
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    const final = await result.collect();
    expect(chunks.join("")).toBe("hello world");
    expect(final.text).toBe("hello world");
    expect(final.usage?.totalTokens).toBe(9);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(String(requestInit.body)) as { stream: boolean };
    expect(requestBody.stream).toBe(true);
  });

  it("supports tool calls through the common multi-step loop", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: {
          thinking: "I should check the weather.",
          content: "",
          tool_calls: [
            {
              function: {
                name: "weather",
                arguments: { city: "Madrid" }
              }
            }
          ]
        },
        done_reason: "tool_calls"
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { content: "Sunny in Madrid" },
        done_reason: "stop"
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen3"),
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

    const followupRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const followupBody = JSON.parse(String(followupRequest.body)) as {
      messages: Array<{
        role: string;
        thinking?: string;
        tool_name?: string;
        tool_call_id?: string;
        tool_calls?: Array<{ function: { arguments: unknown } }>;
      }>;
    };
    expect(followupBody.messages.find((message) => message.role === "assistant")).toMatchObject({
      thinking: "I should check the weather.",
      tool_calls: [{ function: { arguments: { city: "Madrid" } } }]
    });
    expect(followupBody.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_name: "weather",
      tool_call_id: "weather-0"
    });
  });

  it("accepts legacy string tool arguments and rejects incompatible argument shapes", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: {
          tool_calls: [{ function: { name: "weather", arguments: JSON.stringify({ city: "Madrid" }) } }]
        },
        done_reason: "tool_calls"
      })
    );

    const model = createOllama({ fetch: fetchMock as typeof fetch })("qwen3");
    const result = await model.generate({ messages: [createTextMessage("user", "weather")] });
    expect(result.messages?.[0]?.parts).toContainEqual({
      type: "tool-call",
      toolCall: { id: "weather-0", name: "weather", input: { city: "Madrid" } }
    });

    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { tool_calls: [{ function: { name: "weather", arguments: ["Madrid"] } }] },
        done_reason: "tool_calls"
      })
    );
    await expect(model.generate({ messages: [createTextMessage("user", "weather")] })).rejects.toThrow(
      "Ollama tool call arguments must be a JSON object."
    );

    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { tool_calls: [{ function: { name: "weather", arguments: null } }] },
        done_reason: "tool_calls"
      })
    );
    await expect(model.generate({ messages: [createTextMessage("user", "weather")] })).rejects.toThrow(
      "Ollama tool call arguments must be a JSON object."
    );

    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { tool_calls: [{ function: { name: "weather", arguments: '{"city":"private-value"' } }] },
        done_reason: "tool_calls"
      })
    );
    await expect(model.generate({ messages: [createTextMessage("user", "weather")] })).rejects.toThrow(
      "Ollama tool call arguments contained invalid JSON."
    );
  });

  it("correlates parallel tool results with Ollama tool-call indexes", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: {
          tool_calls: [
            { function: { index: 0, name: "weather", arguments: { city: "Madrid" } } },
            { function: { index: 1, name: "weather", arguments: { city: "London" } } }
          ]
        },
        done_reason: "tool_calls"
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({ message: { content: "Madrid and London checked" }, done_reason: "stop" })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen3"),
      prompt: "weather",
      maxSteps: 2,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 20 })
        })
      }
    });
    expect(result.toolResults.map((toolResult) => toolResult.toolCallId)).toEqual(["weather-0", "weather-1"]);

    const followupRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const followupBody = JSON.parse(String(followupRequest.body)) as {
      messages: Array<{
        role: string;
        tool_call_id?: string;
        tool_calls?: Array<{ function: { index: number; arguments: unknown } }>;
      }>;
    };
    expect(followupBody.messages.find((message) => message.role === "assistant")?.tool_calls).toEqual([
      { id: "weather-0", type: "function", function: { index: 0, name: "weather", arguments: { city: "Madrid" } } },
      { id: "weather-1", type: "function", function: { index: 1, name: "weather", arguments: { city: "London" } } }
    ]);
    expect(
      followupBody.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)
    ).toEqual(["weather-0", "weather-1"]);
  });

  it("ignores unrelated or null Ollama provider data in assistant history", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "ok" }, done_reason: "stop" }));

    const model = createOllama({ fetch: fetchMock as typeof fetch })("qwen3");
    await model.generate({
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "provider-data", provider: "ollama", data: null },
            { type: "provider-data", provider: "other", data: { type: "thinking", thinking: "ignore" } },
            { type: "text", text: "context" }
          ]
        },
        createTextMessage("user", "continue")
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { messages: Array<{ thinking?: string }> };
    expect(body.messages[0]).not.toHaveProperty("thinking");
  });

  it("supports native structured output through Ollama format", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { content: JSON.stringify({ title: "Soup" }) },
        done_reason: "stop"
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("llama3.2"),
      prompt: "Return JSON",
      schema: z.object({
        title: z.string()
      }),
      mode: "native"
    });

    expect(result.object).toEqual({ title: "Soup" });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { format: Record<string, unknown> };
    expect(body.format).toMatchObject({
      type: "object"
    });
  });

  it("embeds values through the Ollama embed endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        embeddings: [[0.1, 0.2, 0.3]],
        prompt_eval_count: 8
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await embed({
      model: provider.embeddingModel("embeddinggemma"),
      value: "hello"
    });

    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.usage?.totalTokens).toBe(8);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { model: string; input: string[] };
    expect(body.model).toBe("embeddinggemma");
    expect(body.input).toEqual(["hello"]);
    expect(provider.embeddingModel("embeddinggemma").capabilities).toMatchObject({
      streaming: false,
      tools: false,
      structuredOutput: false,
      jsonMode: false,
      parallelToolCalls: false,
      vision: false,
      embeddings: true,
      reasoning: false
    });
  });

  it("maps shared reasoning and preserves returned thinking", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { thinking: "Working it out", content: "42" },
        done_reason: "stop"
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen3"),
      prompt: "answer",
      reasoning: {
        effort: "medium"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { think: string };
    expect(body.think).toBe("medium");
    expect(result.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "ollama",
      data: { type: "thinking", thinking: "Working it out" }
    });
    expect(provider("qwen3").capabilities).toMatchObject({
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "max"]
    });
  });

  it("preserves native reasoning levels, including max, for compatible models", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "answer" }, done_reason: "stop" }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("deepseek-r1"),
      prompt: "answer",
      reasoning: { effort: "max" }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { think: string };
    expect(body.think).toBe("max");
  });

  it("recognizes both Muse Glimmer distributions and maps their reasoning strength", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "answer" }, done_reason: "stop" }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("muse-glimmer:30b"),
      prompt: "answer",
      reasoning: { effort: "medium" }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { think: string };
    expect(body.think).toBe("medium");
    expect(provider("muse-glimmer:30b").capabilities).toMatchObject({
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high"]
    });
    expect(provider("muse-glimmer:30b-mlx").capabilities).toMatchObject({
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high"]
    });
  });

  it("rejects unsupported max reasoning for Muse Glimmer", async () => {
    const provider = createOllama({ fetch: fetchMock as typeof fetch });

    await expect(
      provider("muse-glimmer:30b").generate({
        messages: [createTextMessage("user", "hello")],
        reasoning: { effort: "max" }
      })
    ).rejects.toThrow('support reasoning effort "none", "low", "medium", or "high"');

    await expect(
      provider("muse-glimmer:30b-mlx").generate({
        messages: [createTextMessage("user", "hello")],
        providerOptions: { think: "max" }
      })
    ).rejects.toThrow('support "think" as a boolean or "low", "medium", or "high"');
  });

  it("maps shared reasoning disablement to think=false", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "plain" }, done_reason: "stop" }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("qwen3"),
      prompt: "answer",
      reasoning: {
        effort: "none"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { think: boolean };
    expect(body.think).toBe(false);
  });

  it("maps GPT-OSS reasoning levels to native think levels", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "answer" }, done_reason: "stop" }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("gpt-oss:20b"),
      prompt: "answer",
      reasoning: { effort: "high" }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { think: string };
    expect(body.think).toBe("high");
  });

  it("rejects unsupported or ambiguous reasoning controls", async () => {
    const provider = createOllama({ fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("qwen3"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 128
        },
        providerOptions: {}
      })
    ).rejects.toThrow('Provider "ollama" does not support "reasoning.budgetTokens".');

    await expect(
      generateText({
        model: provider("qwen3"),
        prompt: "hello",
        reasoning: { effort: "low" },
        providerOptions: { think: true }
      })
    ).rejects.toThrow('Do not combine shared "reasoning" with Ollama "providerOptions.think".');

    await expect(
      generateText({
        model: provider("qwen3"),
        prompt: "hello",
        reasoning: { effort: "low", includeThoughts: false }
      })
    ).rejects.toThrow("cannot hide thinking");

    await expect(
      provider("gpt-oss:20b").generate({
        messages: [createTextMessage("user", "hello")],
        reasoning: { effort: "none" }
      })
    ).rejects.toThrow('require reasoning effort "low", "medium", or "high"');

    await expect(
      provider("gpt-oss:20b").generate({
        messages: [createTextMessage("user", "hello")],
        reasoning: { effort: "max" }
      })
    ).rejects.toThrow('require reasoning effort "low", "medium", or "high"');

    await expect(
      provider("gpt-oss:20b").generate({
        messages: [createTextMessage("user", "hello")],
        providerOptions: { think: "max" }
      })
    ).rejects.toThrow('require "think" to be "low", "medium", or "high"');

    await expect(
      provider("qwen3").generate({
        messages: [createTextMessage("user", "hello")],
        providerOptions: { top_logprobs: 21 }
      })
    ).rejects.toThrow('"top_logprobs" must be an integer between 0 and 20');

    await expect(
      provider("qwen3").generate({
        messages: [createTextMessage("user", "hello")],
        providerOptions: { raw: true }
      })
    ).rejects.toThrow('belong to `/api/generate`');

    await expect(
      provider("qwen3").generate({
        messages: [createTextMessage("user", "hello")],
        providerOptions: { format: "xml" }
      })
    ).rejects.toThrow('chat "format" must be "json" or a JSON Schema object');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves streamed thinking through a tool loop", async () => {
    const firstBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ message: { thinking: "Need " }, done: false })}\n` +
              `${JSON.stringify({
                message: {
                  thinking: "weather",
                  tool_calls: [{ function: { name: "weather", arguments: { city: "Madrid" } } }]
                },
                done: true,
                done_reason: "tool_calls"
              })}\n`
          )
        );
        controller.close();
      }
    });
    const secondBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ message: { content: "Sunny" }, done: true, done_reason: "stop" })}\n`
          )
        );
        controller.close();
      }
    });
    fetchMock
      .mockResolvedValueOnce(new Response(firstBody, { status: 200 }))
      .mockResolvedValueOnce(new Response(secondBody, { status: 200 }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const stream = streamText({
      model: provider("qwen3"),
      prompt: "weather",
      maxSteps: 2,
      reasoning: { effort: "low" },
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 26 })
        })
      }
    });

    const final = await stream.collect();
    expect(final.text).toBe("Sunny");

    const followupRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const followupBody = JSON.parse(String(followupRequest.body)) as {
      messages: Array<{
        role: string;
        thinking?: string;
        tool_calls?: Array<{ function: { arguments: unknown } }>;
      }>;
    };
    expect(followupBody.messages.find((message) => message.role === "assistant")).toMatchObject({
      thinking: "Need weather",
      tool_calls: [{ function: { arguments: { city: "Madrid" } } }]
    });
  });

  it("fails a stream when Ollama emits an NDJSON error after HTTP 200", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ message: { content: "partial" }, done: false })}\n` +
              `${JSON.stringify({ error: "model runner failed" })}\n`
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const model = createOllama({ fetch: fetchMock as typeof fetch })("qwen3");
    const consume = async () => {
      for await (const _event of await model.stream({
        messages: [createTextMessage("user", "hello")]
      })) {
        // Consume the full stream so the terminal provider error is observed.
      }
    };

    await expect(consume()).rejects.toThrow("Ollama streaming request failed.");
  });

  it("rejects terminal NDJSON errors without a trailing newline and non-stream 200 errors", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: "private runner detail" })));
        controller.close();
      }
    });
    fetchMock
      .mockResolvedValueOnce(new Response(body, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ error: "private runner detail" }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await expect(
      streamText({ model: provider("qwen3"), prompt: "hello" }).collect()
    ).rejects.toThrow("Ollama streaming request failed.");
    await expect(generateText({ model: provider("qwen3"), prompt: "hello" })).rejects.toThrow(
      "Ollama request failed."
    );
  });

  it("authenticates direct Ollama Cloud requests and accepts a base URL ending in /api", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ message: { content: "cloud" }, done_reason: "stop" }))
      .mockResolvedValueOnce(Response.json({ embeddings: [[0.1, 0.2]], prompt_eval_count: 2 }));

    const provider = createOllama({
      baseURL: "https://ollama.com/api",
      apiKey: "test-key",
      headers: { "x-zhivex-test": "enabled" },
      fetch: fetchMock as typeof fetch
    });
    await generateText({ model: provider("gpt-oss:120b"), prompt: "hello" });
    await embed({ model: provider.embeddingModel("embeddinggemma"), value: "hello" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://ollama.com/api/chat");
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("x-zhivex-test")).toBe("enabled");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://ollama.com/api/embed");
    expect(new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).get("authorization")).toBe(
      "Bearer test-key"
    );
    expect(provider("gpt-oss:120b").capabilities.structuredOutput).toBe(false);
    expect(provider("gpt-oss:120b").capabilities.jsonMode).toBe(false);
    expect(provider("gpt-oss:120b").capabilities.embeddings).toBe(false);
    expect(provider.embeddingModel("embeddinggemma").capabilities.embeddings).toBe(false);
    expect(provider("gpt-oss:120b").capabilities.reasoningEfforts).toEqual(["low", "medium", "high"]);

    const proxiedCloudModel = createOllama({ fetch: fetchMock as typeof fetch })("gpt-oss:120b-cloud");
    expect(proxiedCloudModel.capabilities).toMatchObject({ structuredOutput: false, jsonMode: false });

    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "header auth" }, done_reason: "stop" }));
    const headerProvider = createOllama({
      baseURL: "https://ollama.com",
      headers: { authorization: "Bearer header-key" },
      fetch: fetchMock as typeof fetch
    });
    await generateText({ model: headerProvider("qwen3"), prompt: "hello" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://ollama.com/api/chat");
    expect(new Headers((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).get("authorization")).toBe(
      "Bearer header-key"
    );
  });

  it("uses Cloud env auth only for ollama.com and lets an authenticated custom fetch sign requests", async () => {
    vi.stubEnv("OLLAMA_API_KEY", " env-key ");
    try {
      fetchMock
        .mockResolvedValueOnce(Response.json({ message: { content: "cloud" }, done_reason: "stop" }))
        .mockResolvedValueOnce(Response.json({ message: { content: "local" }, done_reason: "stop" }));

      const cloud = createOllama({ baseURL: "https://ollama.com", fetch: fetchMock as typeof fetch });
      const local = createOllama({ fetch: fetchMock as typeof fetch });
      await generateText({ model: cloud("qwen3"), prompt: "hello" });
      await generateText({ model: local("qwen3"), prompt: "hello" });

      expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBe(
        "Bearer env-key"
      );
      expect(new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).has("authorization")).toBe(false);

      vi.stubEnv("OLLAMA_API_KEY", "");
      const signedFetch = vi.fn(async () =>
        Response.json({ message: { content: "signed" }, done_reason: "stop" })
      );
      const signed = createOllama({ baseURL: "https://ollama.com", fetch: signedFetch as typeof fetch });
      await generateText({ model: signed("qwen3"), prompt: "hello" });
      expect(signedFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets an explicit apiKey override duplicate Authorization headers case-insensitively", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "cloud" }, done_reason: "stop" }));

    const provider = createOllama({
      baseURL: "https://ollama.com",
      apiKey: "explicit-key",
      headers: { Authorization: "Bearer stale-key" },
      fetch: fetchMock as typeof fetch
    });
    await generateText({ model: provider("qwen3"), prompt: "hello" });

    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBe(
      "Bearer explicit-key"
    );
  });

  it("prefers an explicit Authorization header over OLLAMA_API_KEY", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "environment-key");
    try {
      fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "cloud" }, done_reason: "stop" }));
      const provider = createOllama({
        baseURL: "https://ollama.com",
        headers: { Authorization: "Bearer header-key" },
        fetch: fetchMock as typeof fetch
      });
      await generateText({ model: provider("qwen3"), prompt: "hello" });

      expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("authorization")).toBe(
        "Bearer header-key"
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
