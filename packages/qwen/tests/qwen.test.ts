import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";

import {
  createBatch,
  createTextMessage,
  deleteFile,
  embed,
  generateImage,
  generateObject,
  generateSpeech,
  generateText,
  generateVideo,
  ProviderResponseTooLargeError,
  streamText,
  tool,
  transcribeAudio,
  uploadFile,
  type RealtimeConnection
} from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import {
  createQwen,
  qwenCodeInterpreterTool,
  qwenFileSearchTool,
  qwenImageSearchTool,
  qwenMcpTool,
  qwenWebExtractorTool,
  qwenWebSearchImageTool,
  qwenWebSearchTool
} from "../src/index.js";

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
      parallelToolCalls: false,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: true,
      reasoning: true,
      webSearch: true,
      vision: false
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

  it("declares current Qwen 3.7 model capabilities without overclaiming vision on max", () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("qwen3.7-plus").capabilities).toMatchObject({
      reasoning: true,
      vision: true,
      tools: true
    });
    expect(provider("qwen3.7-max").capabilities).toMatchObject({
      reasoning: true,
      vision: false,
      tools: true
    });
    expect(provider("qwen3.5-omni-plus").capabilities).toMatchObject({
      streaming: true,
      vision: true,
      audioInput: true,
      tools: true,
      structuredOutput: false,
      reasoning: false,
      webSearch: false,
      agentCapabilities: {
        supportTier: "tier-c",
        hostedWebSearch: false,
        hostedFileSearch: false,
        remoteMcp: false,
        codeExecution: false
      }
    });
    expect(provider("qwen3.6-flash").capabilities.vision).toBe(true);
    expect(provider("qwen3.5-ocr").capabilities).toMatchObject({
      files: true,
      vision: true,
      tools: false,
      reasoning: false,
      webSearch: false
    });
    expect(provider("qwen3-asr-flash").capabilities).toMatchObject({
      tools: false,
      reasoning: false,
      webSearch: false
    });
  });

  it("routes Qwen Omni through streaming Chat Completions and preserves multimodal order", async () => {
    const responseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(
      new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("qwen3.5-omni-plus"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "image", image: "https://example.com/first.png", mediaType: "image/png" },
            { type: "text", text: "Compare this image" },
            { type: "audio", data: new Uint8Array([1]), mediaType: "audio/wav" },
            { type: "text", text: "with this audio." }
          ]
        }
      ]
    });

    expect((await result.collect()).text).toBe("ok");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: "qwen3.5-omni-plus", modalities: ["text"], stream: true });
    expect(body.messages[0].content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/first.png" } },
      { type: "text", text: "Compare this image" },
      { type: "input_audio", input_audio: { data: "data:audio/wav;base64,AQ==" } },
      { type: "text", text: "with this audio." }
    ]);

    await expect(generateText({ model: provider("qwen3.5-omni-plus"), prompt: "hello" })).rejects.toThrow(
      "is streaming-only"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const responsesResult = streamText({
      model: provider("qwen3.5-omni-plus"),
      prompt: "hello",
      providerOptions: { apiMode: "responses" }
    });
    await expect(responsesResult.collect()).rejects.toThrow("Qwen Omni uses streaming Chat Completions");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps documented OCR file URLs and rejects Files API IDs in Responses input", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "invoice" }] }]
      })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("qwen3.5-ocr"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Read this document." },
            {
              type: "file",
              data: "https://example.com/invoice.pdf",
              mediaType: "application/pdf",
              filename: "invoice.pdf"
            }
          ]
        }
      ]
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.input[0]?.content[1]).toEqual({
      type: "input_file",
      file_url: "https://example.com/invoice.pdf",
      filename: "invoice.pdf"
    });

    await expect(
      generateText({
        model: provider("qwen3.5-ocr"),
        messages: [
          {
            role: "user",
            parts: [{ type: "file", data: "file_batch_only", mediaType: "application/pdf" }]
          }
        ]
      })
    ).rejects.toThrow("DashScope Files IDs are reserved for batch jobs");
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

  it("does not let provider options override Responses request fields", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "safe qwen" }] }]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("qwen-plus"),
      prompt: "hello",
      providerOptions: {
        apiMode: "responses",
        model: "override-model",
        input: "override-input",
        stream: true,
        max_output_tokens: 1,
        custom_flag: "kept"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      model: string;
      input: unknown;
      stream: boolean;
      max_output_tokens?: number;
      custom_flag?: string;
    };
    expect(body.model).toBe("qwen-plus");
    expect(body.input).not.toBe("override-input");
    expect(body.stream).toBe(false);
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.custom_flag).toBe("kept");
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

  it("exposes Qwen Responses hosted tools in agent capabilities", () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const agentCapabilities = provider("qwen-plus").capabilities.agentCapabilities;

    expect(agentCapabilities).toMatchObject({
      supportTier: "tier-b",
      hostedWebSearch: true,
      hostedFileSearch: true,
      remoteMcp: true,
      codeExecution: true,
      webExtraction: true,
      approvalRequests: false,
      computerUse: false
    });
  });

  it("streams incremental text", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n" +
              "data: {\"type\":\"response.output_text.delta\",\"delta\":\" world\"}\n\n" +
              "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream\",\"status\":\"completed\"}}\n\n" +
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

    const collected = await result.collect();
    expect(collected.text).toBe("hello world");
    expect(collected.messages.at(-1)?.parts).toContainEqual({
      type: "provider-data",
      provider: "qwen",
      data: { responseId: "resp_stream" }
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
                  function: { name: "weather", arguments: JSON.stringify({ city: "Madrid" }) }
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

  it("maps native structured output into Qwen Chat JSON mode with a schema prompt", async () => {
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

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("qwen-plus"),
      prompt: "Return weather JSON.",
      schema: z.object({
        city: z.string(),
        forecast: z.string()
      }),
      mode: "native"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      response_format?: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]?.content).toContain("JSON Schema");
    expect(result.object.forecast).toBe("sunny");
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

  it("uses the native multimodal embedding endpoint for text, image, and video", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        output: {
          embeddings: [
            { index: 0, type: "text", embedding: [0.1] },
            { index: 1, type: "image", embedding: [0.2] },
            { index: 2, type: "video", embedding: [0.3] }
          ]
        },
        usage: { input_tokens: 2, image_tokens: 3, total_tokens: 5 }
      })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await provider.multimodalEmbeddingModel("qwen3-vl-embedding").embed({
      values: [
        "product",
        { data: new Uint8Array([1, 2]), mediaType: "image/png" },
        { uri: "https://example.com/video.mp4", mediaType: "video/mp4" }
      ],
      providerOptions: { enable_fusion: false, dimension: 1024 }
    });

    expect(result.embeddings).toEqual([[0.1], [0.2], [0.3]]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/services/embeddings/multimodal-embedding/multimodal-embedding"
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.input.contents).toEqual([
      { text: "product" },
      { image: "data:image/png;base64,AQI=" },
      { video: "https://example.com/video.mp4" }
    ]);
    expect(body.parameters).toEqual({ enable_fusion: false, dimension: 1024 });
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
      tool_choice: { type: string; mode: string; tools: Array<{ type: string; name: string }> };
    };
    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "weather" }]
    });
  });

  it("maps Responses reasoning effort and rejects Responses-only ignored common fields", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "reasoned" }] }],
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 7 },
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 20
        }
      })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen-plus"),
      prompt: "hello",
      reasoning: { effort: "low" },
      providerOptions: { apiMode: "responses" }
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.reasoning).toEqual({ effort: "minimal" });
    expect(body.enable_thinking).toBeUndefined();
    expect(body.thinking_budget).toBeUndefined();
    expect(result.usage).toMatchObject({
      inputTokens: 12,
      cachedInputTokens: 7,
      outputTokens: 8,
      reasoningTokens: 5,
      totalTokens: 20
    });

    await expect(
      generateText({
        model: provider("qwen-plus"),
        prompt: "hello",
        maxTokens: 32,
        providerOptions: { apiMode: "responses" }
      })
    ).rejects.toThrow("Qwen Responses does not process maxTokens");
  });

  it("continues streaming Responses conversations with previous_response_id", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"continued\"}\n\n" +
              'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":9,"input_tokens_details":{"cached_tokens":4},"output_tokens":6,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":15}}}\n\n' +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("qwen-plus"),
      messages: [
        createTextMessage("user", "first"),
        {
          role: "assistant",
          parts: [
            { type: "text", text: "first response" },
            { type: "provider-data", provider: "qwen", data: { responseId: "resp_previous" } }
          ]
        },
        createTextMessage("user", "continue")
      ]
    });
    const final = await result.collect();
    expect(final.text).toBe("continued");
    expect(final.usage).toMatchObject({
      inputTokens: 9,
      cachedInputTokens: 4,
      outputTokens: 6,
      reasoningTokens: 2,
      totalTokens: 15
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.previous_response_id).toBe("resp_previous");
    expect(requestBody.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "continue" }] }
    ]);
  });

  it("flushes Chat tool calls when the finish chunk has an empty delta", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"weather","arguments":"{\\"city\\":\\"Madrid\\"}"}}]},"finish_reason":null}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("qwen-plus"),
      prompt: "weather",
      providerOptions: { apiMode: "chat" },
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city })
        })
      }
    });
    const events = [];
    for await (const event of result.eventStream) events.push(event);
    expect(events).toContainEqual({
      type: "tool-call",
      toolCall: { id: "call_1", name: "weather", input: { city: "Madrid" } }
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
        code: qwenCodeInterpreterTool(),
        files: qwenFileSearchTool({ vector_store_ids: ["store_1"] }),
        mcp: qwenMcpTool({
          server_label: "amap-maps",
          server_protocol: "sse",
          server_url: "https://dashscope-intl.aliyuncs.com/api/v1/mcps/amap-maps/sse"
        }),
        imageWeb: qwenWebSearchImageTool(),
        imageSearch: qwenImageSearchTool()
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { tools: Array<Record<string, unknown>> };
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "web_search" }),
        expect.objectContaining({ type: "web_extractor", max_results: 2 }),
        expect.objectContaining({ type: "code_interpreter" }),
        expect.objectContaining({ type: "file_search", vector_store_ids: ["store_1"] }),
        expect.objectContaining({
          type: "mcp",
          server_label: "amap-maps",
          server_protocol: "sse",
          server_url: "https://dashscope-intl.aliyuncs.com/api/v1/mcps/amap-maps/sse"
        }),
        expect.objectContaining({ type: "web_search_image" }),
        expect.objectContaining({ type: "image_search" })
      ])
    );
  });

  it("preserves Qwen Responses hosted tool output items as provider data", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "web_search_call",
            id: "search_1",
            action: {
              type: "search",
              query: "Qwen docs",
              sources: [{ type: "url", url: "https://docs.qwencloud.com" }]
            }
          },
          {
            type: "code_interpreter_call",
            id: "code_1",
            code: "print(1)",
            outputs: [{ type: "logs", logs: "1" }]
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }]
          }
        ]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen-plus"),
      prompt: "research",
      tools: {
        search: qwenWebSearchTool(),
        code: qwenCodeInterpreterTool()
      }
    });

    expect(result.text).toBe("done");
    expect(result.messages.at(-1)?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider-data",
          provider: "qwen",
          data: expect.objectContaining({ type: "web_search_call", id: "search_1" })
        }),
        expect.objectContaining({
          type: "provider-data",
          provider: "qwen",
          data: expect.objectContaining({ type: "code_interpreter_call", id: "code_1" })
        })
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
    ).rejects.toThrow("Qwen Chat Completions does not support Responses hosted tools");
  });

  it("exposes Qwen Cloud files and batch clients", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ id: "file_1", filename: "demo.txt", bytes: 4, status: "processed" }))
      .mockResolvedValueOnce(Response.json({ id: "file_1", deleted: true }))
      .mockResolvedValueOnce(Response.json({ id: "batch_1", status: "validating", model: "qwen-plus" }));

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const file = await uploadFile({
      provider,
      data: new Uint8Array([1, 2, 3, 4]),
      mediaType: "text/plain",
      filename: "demo.txt",
      providerOptions: { purpose: "batch" }
    });
    const deleted = await deleteFile({ provider, name: file.name });
    const batch = await createBatch({
      provider,
      modelId: "qwen-plus",
      fileName: "file_1"
    });

    expect(file).toMatchObject({ name: "file_1", displayName: "demo.txt", sizeBytes: 4 });
    expect(deleted.name).toBe("file_1");
    expect(batch).toMatchObject({ name: "batch_1", model: "qwen-plus", state: "validating" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/files");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/batches");
    expect((fetchMock.mock.calls[0]?.[1]?.body as FormData).get("purpose")).toBe("batch");
    const batchBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(batchBody).toMatchObject({
      input_file_id: "file_1",
      endpoint: "/v1/chat/completions",
      completion_window: "24h"
    });
    expect(batchBody.model).toBeUndefined();
    expect(batchBody.requests).toBeUndefined();
    expect(provider.fileSearchStores).toBeUndefined();
  });

  it("rejects path-like Qwen file, batch, and task IDs before sending credentials", async () => {
    const provider = createQwen({ apiKey: "qwen-secret", fetch: fetchMock as typeof fetch });

    await expect(provider.files!.get({ name: "../batches/batch_1" })).rejects.toThrow(
      "Qwen file ID must be a non-empty opaque identifier"
    );
    await expect(provider.batches!.cancel({ name: ".." })).rejects.toThrow(
      "Qwen batch ID must be a non-empty opaque identifier"
    );
    await expect(provider.tasks.get({ name: "task_1/../secret" })).rejects.toThrow(
      "Qwen task ID must be a non-empty opaque identifier"
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes Qwen speech and media models", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ choices: [{ finish_reason: "stop", message: { content: "hola mundo" } }] })
      )
      .mockResolvedValueOnce(
        Response.json({
          output: {
            audio: { url: "http://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/speech.wav" }
          }
        })
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }))
      .mockResolvedValueOnce(
        Response.json({
          output: {
            choices: [{ message: { content: [{ image: "https://example.com/image.png" }] } }]
          }
        })
      )
      .mockResolvedValueOnce(Response.json({ output: { task_id: "task_1", task_status: "PENDING" } }));

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const transcript = await transcribeAudio({
      model: provider.transcriptionModel!("qwen3-asr-flash"),
      audio: { data: new Uint8Array([1]), mediaType: "audio/wav", filename: "audio.wav" }
    });
    const speech = await generateSpeech({
      model: provider.speechModel!("qwen3-tts-flash"),
      input: "hello"
    });
    const image = await generateImage({
      model: provider.imageGenerationModel!("qwen-image-2.0-pro"),
      prompt: "a product icon"
    });
    const video = await generateVideo({
      model: provider.videoGenerationModel!("wan2.7-t2v"),
      prompt: "a product video"
    });

    expect(transcript.text).toBe("hola mundo");
    expect(speech.mediaType).toBe("audio/mpeg");
    expect(image.images[0]?.uri).toBe("https://example.com/image.png");
    expect(video.operationName).toBe("task_1");
    expect(video.videos).toHaveLength(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen3-asr-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: "data:audio/wav;base64,AQ==" } }]
        }
      ]
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/services/aigc/multimodal-generation/generation");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      model: "qwen3-tts-flash",
      input: { text: "hello", voice: "Cherry" }
    });
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("/services/aigc/multimodal-generation/generation");
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
      model: "qwen-image-2.0-pro",
      input: { messages: [{ role: "user", content: [{ text: "a product icon" }] }] }
    });
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain("/services/aigc/video-generation/video-synthesis");
    expect(fetchMock.mock.calls[4]?.[1]?.headers).toMatchObject({ "X-DashScope-Async": "enable" });
  });

  it("limits decoded Qwen base64 audio and omits the encoded payload from rawResponse", async () => {
    const encoded = Buffer.from([1, 2, 3, 4]).toString("base64");
    fetchMock.mockResolvedValueOnce(
      Response.json({ output: { audio: { data: encoded, media_type: "audio/wav" } } })
    );
    const limited = createQwen({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      responseLimits: { speechBytes: 3 }
    });
    await expect(
      generateSpeech({ model: limited.speechModel!("qwen3-tts-flash"), input: "hello" })
    ).rejects.toBeInstanceOf(ProviderResponseTooLargeError);

    fetchMock.mockResolvedValueOnce(
      Response.json({ output: { audio: { data: encoded, media_type: "audio/wav" } } })
    );
    const provider = createQwen({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      responseLimits: { speechBytes: 4 }
    });
    const result = await generateSpeech({ model: provider.speechModel!("qwen3-tts-flash"), input: "hello" });
    expect(Array.from(result.audio)).toEqual([1, 2, 3, 4]);
    expect((result.rawResponse as any).output.audio).toMatchObject({
      data: undefined,
      data_omitted: true
    });
  });

  it("blocks unsafe Qwen speech audio URLs and validates every redirect", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ output: { audio: { url: "http://127.0.0.1/internal.wav" } } })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateSpeech({ model: provider.speechModel!("qwen3-tts-flash"), input: "hello" })
    ).rejects.toThrow("rejected by the configured safety policy");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          output: {
            audio: { url: "http://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/speech.wav" }
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
      );

    await expect(
      generateSpeech({ model: provider.speechModel!("qwen3-tts-flash"), input: "hello" })
    ).rejects.toThrow("rejected by the configured safety policy");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("allows an explicit Qwen speech audio URL policy for private gateways", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ output: { audio: { url: "https://media.example.com/speech.wav" } } })
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/wav" } }));
    const validator = vi.fn((url: URL) => url.protocol === "https:" && url.hostname === "media.example.com");
    const provider = createQwen({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      speechAudioURLValidator: validator
    });

    const result = await generateSpeech({ model: provider.speechModel!("qwen3-tts-flash"), input: "hello" });

    expect(Array.from(result.audio)).toEqual([1, 2]);
    expect(validator).toHaveBeenCalledWith(expect.objectContaining({ hostname: "media.example.com" }));
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toBeUndefined();
  });

  it("does not allow per-request Qwen image endpoints to receive the API key", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ url: "https://example.com/image.png" }] }));
    const provider = createQwen({ apiKey: "qwen-secret", fetch: fetchMock as typeof fetch });

    await generateImage({
      model: provider.imageGenerationModel!("qwen-image-2.0-pro"),
      prompt: "safe endpoint",
      providerOptions: {
        endpoint: "https://attacker.invalid/collect",
        response_format: "url"
      }
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.parameters.endpoint).toBeUndefined();
    expect(body.parameters.response_format).toBe("url");
  });

  it("routes text and multimodal rerank models to their documented endpoints", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ results: [{ index: 1, relevance_score: 0.9 }] }))
      .mockResolvedValueOnce(
        Response.json({ output: { results: [{ index: 0, relevance_score: 0.8 }] } })
      );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await provider.rerankModel("qwen3-rerank").rerank({
      query: "sdk",
      documents: ["irrelevant", "Zhivex SDK"],
      topN: 1,
      providerOptions: { instruct: "Rank SDK documentation" }
    });
    await provider.rerankModel("qwen3-vl-rerank").rerank({
      query: { data: new Uint8Array([1]), mediaType: "image/png" },
      documents: [{ uri: "https://example.com/product.mp4", mediaType: "video/mp4" }],
      topN: 1,
      providerOptions: { fps: 1 }
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/v1/services/rerank/text-rerank/text-rerank"
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen3-rerank",
      input: {
        query: "sdk",
        documents: ["irrelevant", "Zhivex SDK"]
      },
      parameters: {
        return_documents: true,
        top_n: 1,
        instruct: "Rank SDK documentation"
      }
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/services/rerank/text-rerank/text-rerank");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      input: {
        query: { image: "data:image/png;base64,AQ==" },
        documents: [{ video: "https://example.com/product.mp4" }]
      },
      parameters: { return_documents: true, top_n: 1, fps: 1 }
    });
  });

  it("derives workspace-specific HTTP, task, and realtime endpoints", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          id: "resp_1",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
        })
      )
      .mockResolvedValueOnce(
        Response.json({ output: { embeddings: [{ index: 0, embedding: [0.1] }] } })
      );
    const connection: RealtimeConnection = {
      async sendJson() {},
      async recvJson() { return undefined; },
      async close() {}
    };
    const connectionFactory = vi.fn(async () => connection);
    const provider = createQwen({
      apiKey: "test",
      workspaceId: "ws_123",
      region: "singapore",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    await generateText({ model: provider("qwen3.7-plus"), prompt: "hello" });
    await provider.multimodalEmbeddingModel("qwen3-vl-embedding").embed({ values: ["hello"] });
    await provider.realtimeModel!("qwen3.5-omni-plus-realtime").connect();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://ws_123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses"
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://ws_123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"
    );
    expect(String(connectionFactory.mock.calls[0]?.[0])).toBe(
      "wss://ws_123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime"
    );
  });

  it("opens authenticated Qwen realtime sessions by default in Node", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Expected a TCP address for the Qwen realtime test server.");
    }

    const handshake = new Promise<{ authorization?: string; payload: Record<string, unknown> }>(
      (resolve, reject) => {
        server.once("connection", (socket, request) => {
          socket.once("message", (data) => {
            try {
              resolve({
                authorization: request.headers.authorization,
                payload: JSON.parse(data.toString())
              });
            } catch (error) {
              reject(error);
            }
          });
        });
        server.once("error", reject);
      }
    );
    const provider = createQwen({
      apiKey: "qwen-secret",
      realtimeURL: `ws://127.0.0.1:${address.port}/realtime`
    });
    const session = await provider.realtimeModel!("qwen3.5-omni-plus-realtime").connect(
      { instructions: "be concise" },
      { timeoutMs: 5_000 }
    );

    try {
      await expect(handshake).resolves.toMatchObject({
        authorization: "Bearer qwen-secret",
        payload: {
          type: "session.update",
          session: {
            instructions: "be concise",
            input_audio_format: "pcm",
            output_audio_format: "pcm"
          }
        }
      });
    } finally {
      await session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("maps current Qwen realtime server events into the shared event contract", async () => {
    const incoming: Array<Record<string, unknown>> = [
      { type: "response.text.delta", delta: "Hello", item_id: "item_1", response_id: "resp_1" },
      { type: "response.audio.delta", delta: "AQI=", item_id: "item_1", response_id: "resp_1" },
      { type: "response.audio_transcript.delta", delta: "Hel", item_id: "item_1" },
      { type: "response.audio_transcript.done", transcript: "Hello", item_id: "item_1" },
      {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Hi",
        item_id: "item_user"
      },
      {
        type: "response.function_call_arguments.done",
        call_id: "call_1",
        name: "weather",
        arguments: "{\"city\":\"Madrid\"}"
      },
      { type: "response.done", response: { status: "completed" } },
      { type: "session.finished" }
    ];
    const connection: RealtimeConnection = {
      async sendJson() {},
      async recvJson() { return incoming.shift(); },
      async close() {}
    };
    const provider = createQwen({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: async () => connection
    });
    const session = await provider.realtimeModel!("qwen3.5-omni-plus-realtime").connect();
    const events = [];
    for await (const event of session.eventStream()) events.push(event);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "realtime-text-delta", textDelta: "Hello", itemId: "item_1" }),
        expect.objectContaining({ type: "realtime-audio-output", audio: new Uint8Array([1, 2]) }),
        expect.objectContaining({ type: "realtime-transcript", text: "Hello", role: "assistant", isFinal: true }),
        expect.objectContaining({ type: "realtime-transcript", text: "Hi", role: "user", isFinal: true }),
        expect.objectContaining({
          type: "realtime-tool-call",
          toolCall: { id: "call_1", name: "weather", input: { city: "Madrid" } }
        }),
        expect.objectContaining({ type: "realtime-response-complete", reason: "completed" }),
        expect.objectContaining({ type: "realtime-end", reason: "finished" })
      ])
    );
  });

  it("exposes Qwen realtime and package-specific rerank helpers", async () => {
    const sent: Record<string, unknown>[] = [];
    const connection: RealtimeConnection = {
      async sendJson(payload) {
        sent.push(payload);
      },
      async recvJson() {
        return undefined;
      },
      async close() {}
    };
    const connectionFactory = vi.fn(async () => connection);
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ index: 0, relevance_score: 0.9 }] }));

    const provider = createQwen({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    });
    const session = await provider.realtimeModel!("qwen-omni-turbo-realtime").connect({
      instructions: "be concise",
      turnDetection: { type: "server_vad", silence_duration_ms: 500 }
    });
    await session.sendText("hi");
    await session.sendMedia({ data: new Uint8Array([1, 2]), mediaType: "image/jpeg" });
    await session.close();
    const rerank = await provider.rerankModel("gte-rerank-v2").rerank({
      query: "sdk",
      documents: ["Zhivex SDK"]
    });

    expect(connectionFactory).toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "session.update",
      session: {
        instructions: "be concise",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        turn_detection: { type: "server_vad", silence_duration_ms: 500 }
      }
    });
    expect(sent.some((payload) => payload.type === "conversation.item.create")).toBe(true);
    expect(sent).toContainEqual({ type: "input_image_buffer.append", image: "AQI=" });
    expect(sent.some((payload) => payload.type === "session.close")).toBe(false);
    expect(rerank.results[0]).toMatchObject({ index: 0, document: "Zhivex SDK", relevanceScore: 0.9 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/services/rerank/text-rerank/text-rerank");
  });
});
