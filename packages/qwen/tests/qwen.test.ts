import { beforeEach, describe, expect, it, vi } from "vitest";
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
      parallelToolCalls: true,
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
    expect(provider("qwen3.5-omni-plus").capabilities.vision).toBe(true);
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
      maxTokens: 32,
      providerOptions: {
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
      max_output_tokens: number;
      custom_flag?: string;
    };
    expect(body.model).toBe("qwen-plus");
    expect(body.input).not.toBe("override-input");
    expect(body.stream).toBe(false);
    expect(body.max_output_tokens).toBe(32);
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

  it("maps native structured output into the Qwen Responses API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
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
      prompt: "Return weather JSON.",
      schema: z.object({
        city: z.string(),
        forecast: z.string()
      }),
      mode: "native"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { response_format?: { type: string; json_schema: { strict: boolean } } };
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/responses");
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        strict: true
      }
    });
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
    ).rejects.toThrow('Provider "qwen" does not support hosted tools.');
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
      filename: "demo.txt"
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
  });

  it("exposes Qwen speech and media models", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ text: "hola mundo" }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ url: "https://example.com/image.png" }] }))
      .mockResolvedValueOnce(Response.json({ output: { task_id: "task_1", videos: [{ url: "https://example.com/video.mp4" }] } }));

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const transcript = await transcribeAudio({
      model: provider.transcriptionModel!("qwen-audio-asr"),
      audio: { data: new Uint8Array([1]), mediaType: "audio/wav", filename: "audio.wav" }
    });
    const speech = await generateSpeech({
      model: provider.speechModel!("qwen-tts"),
      input: "hello"
    });
    const image = await generateImage({
      model: provider.imageGenerationModel!("wanx2.1-t2i-turbo"),
      prompt: "a product icon"
    });
    const video = await generateVideo({
      model: provider.videoGenerationModel!("wanx2.1-t2v-turbo"),
      prompt: "a product video"
    });

    expect(transcript.text).toBe("hola mundo");
    expect(speech.mediaType).toBe("audio/mpeg");
    expect(image.images[0]?.uri).toBe("https://example.com/image.png");
    expect(video.operationName).toBe("task_1");
    expect(video.videos[0]?.uri).toBe("https://example.com/video.mp4");
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
      generateSpeech({ model: limited.speechModel!("qwen-tts"), input: "hello" })
    ).rejects.toBeInstanceOf(ProviderResponseTooLargeError);

    fetchMock.mockResolvedValueOnce(
      Response.json({ output: { audio: { data: encoded, media_type: "audio/wav" } } })
    );
    const provider = createQwen({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      responseLimits: { speechBytes: 4 }
    });
    const result = await generateSpeech({ model: provider.speechModel!("qwen-tts"), input: "hello" });
    expect(Array.from(result.audio)).toEqual([1, 2, 3, 4]);
    expect((result.rawResponse as any).output.audio).toMatchObject({
      data: undefined,
      data_omitted: true
    });
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
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/images/generations"
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.endpoint).toBeUndefined();
    expect(body.response_format).toBe("url");
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
    const session = await provider.realtimeModel!("qwen-omni-turbo-realtime").connect({ instructions: "be concise" });
    await session.sendText("hi");
    await session.close();
    const rerank = await provider.rerankModel("gte-rerank-v2").rerank({
      query: "sdk",
      documents: ["Zhivex SDK"]
    });

    expect(connectionFactory).toHaveBeenCalled();
    expect(sent.some((payload) => payload.type === "conversation.item.create")).toBe(true);
    expect(rerank.results[0]).toMatchObject({ index: 0, document: "Zhivex SDK", relevanceScore: 0.9 });
  });
});
