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
  QWEN_TOKEN_PLAN_BASE_URL,
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

  it.each(["qwen3.8-max", "qwen3.8-flash"])(
    "declares %s as a hybrid multimodal production model",
    (modelId) => {
      const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
      const model = provider(modelId);

      expect(model.capabilities).toMatchObject({
        reasoning: true,
        reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        vision: true,
        files: true,
        tools: true,
        structuredOutput: true,
        jsonMode: true,
        parallelToolCalls: true,
        webSearch: true
      });
    }
  );

  it("routes qwen3.8-flash multimodal reasoning through Responses without reducing effort", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_38_flash",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "explained" }] }]
      })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    const result = await generateText({
      model: provider("qwen3.8-flash"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "image", image: "https://example.com/diagram.png", mediaType: "image/png" },
            { type: "text", text: "Explain this diagram." }
          ]
        }
      ],
      reasoning: { effort: "high" }
    });

    expect(result.text).toBe("explained");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/responses"
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "qwen3.8-flash",
      reasoning: { effort: "high" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "https://example.com/diagram.png" },
            { type: "input_text", text: "Explain this diagram." }
          ]
        }
      ]
    });
  });

  it("maps qwen3.8-flash video and hybrid controls through Chat", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "video understood" } }]
      })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    const result = await generateText({
      model: provider("qwen3.8-flash"),
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "file",
              data: "https://example.com/demo.mp4",
              mediaType: "video/mp4",
              filename: "demo.mp4"
            },
            { type: "text", text: "Summarize the video." }
          ]
        }
      ],
      maxTokens: 256,
      reasoning: { effort: "none" },
      providerOptions: { parallel_tool_calls: true }
    });

    expect(result.text).toBe("video understood");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "qwen3.8-flash",
      parallel_tool_calls: true,
      enable_thinking: false,
      preserve_thinking: true,
      max_completion_tokens: 256
    });
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages[0]?.content).toEqual([
      { type: "video_url", video_url: { url: "https://example.com/demo.mp4" } },
      { type: "text", text: "Summarize the video." }
    ]);
  });

  it("uses qwen3.8-flash native JSON Schema structured output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ title: "Architecture", components: 3 }) }
          }
        ]
      })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    const result = await generateObject({
      model: provider("qwen3.8-flash"),
      prompt: "Return a JSON summary.",
      schema: z.object({ title: z.string(), components: z.number() }),
      mode: "native",
      schemaName: "architecture_summary"
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "architecture_summary",
        strict: true,
        schema: { type: "object" }
      }
    });
    expect(body.messages).toEqual([{ role: "user", content: "Return a JSON summary." }]);
    expect(result.object).toEqual({ title: "Architecture", components: 3 });
  });

  it("routes qwen3.8-max multimodal reasoning through the standard Responses endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_38_max",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "explained" }] }]
      })
    );
    const provider = createQwen({
      apiKey: "pay-as-you-go-key",
      workspaceId: "ws_123",
      region: "beijing",
      fetch: fetchMock as typeof fetch
    });

    const result = await generateText({
      model: provider("qwen3.8-max"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "image", image: "https://example.com/diagram.png", mediaType: "image/png" },
            { type: "text", text: "Explain this diagram." }
          ]
        }
      ],
      reasoning: { effort: "low" }
    });

    expect(result.text).toBe("explained");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://ws_123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses"
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "qwen3.8-max",
      reasoning: { effort: "low" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "https://example.com/diagram.png" },
            { type: "input_text", text: "Explain this diagram." }
          ]
        }
      ]
    });
  });

  it("supports qwen3.8-max native structured output with hybrid thinking disabled", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ title: "Architecture", components: 3 }) }
          }
        ]
      })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    const result = await generateObject({
      model: provider("qwen3.8-max"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "image", image: "https://example.com/architecture.png", mediaType: "image/png" },
            { type: "text", text: "Return a JSON summary." }
          ]
        }
      ],
      schema: z.object({ title: z.string(), components: z.number() }),
      mode: "native",
      maxTokens: 256,
      reasoning: { effort: "none" }
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
    expect(body).toMatchObject({
      model: "qwen3.8-max",
      response_format: { type: "json_object" },
      enable_thinking: false,
      preserve_thinking: true,
      max_completion_tokens: 256
    });
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages[0]?.content).toContain("JSON Schema");
    expect(body.messages[1]?.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/architecture.png" } },
      { type: "text", text: "Return a JSON summary." }
    ]);
    expect(result.object).toEqual({ title: "Architecture", components: 3 });
  });

  it("maps qwen3.8-max Chat reasoning aliases and always preserves thinking history", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "reasoned" } }]
      })
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await generateText({
      model: provider("qwen3.8-max"),
      prompt: "Think carefully.",
      reasoning: { effort: "high" },
      providerOptions: { apiMode: "chat" }
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      reasoning_effort: "xhigh",
      preserve_thinking: true
    });
    expect(body.reasoning).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it("streams qwen3.8-max video and Chat tool options without losing multimodal order", async () => {
    const responseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"video understood"},"finish_reason":"stop"}]}\n\n' +
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
      model: provider("qwen3.8-max"),
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "file",
              data: "https://example.com/demo.mp4",
              mediaType: "video/mp4",
              filename: "demo.mp4"
            },
            { type: "text", text: "Summarize the video." }
          ]
        }
      ],
      providerOptions: {
        parallel_tool_calls: true,
        tool_stream: true
      }
    });

    expect((await result.collect()).text).toBe("video understood");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "qwen3.8-max",
      parallel_tool_calls: true,
      tool_stream: true,
      preserve_thinking: true,
      stream: true
    });
    expect(body.messages[0]?.content).toEqual([
      { type: "video_url", video_url: { url: "https://example.com/demo.mp4" } },
      { type: "text", text: "Summarize the video." }
    ]);
  });

  it("enforces qwen3.8-max thinking tool-choice restrictions and allows forcing a tool when disabled", async () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider("qwen3.8-max");
    const tools = {
      weather: tool({
        name: "weather",
        schema: z.object({ city: z.string() }),
        execute: ({ city }) => ({ city })
      })
    };

    await expect(
      generateText({
        model,
        prompt: "Use the weather tool.",
        tools,
        toolChoice: "required"
      })
    ).rejects.toThrow('only when thinking is disabled');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "done" } }]
      })
    );
    await generateText({
      model,
      prompt: "Use the weather tool.",
      tools,
      toolChoice: { type: "tool", toolName: "weather" },
      reasoning: { effort: "none" },
      providerOptions: { apiMode: "chat" }
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      enable_thinking: false,
      preserve_thinking: true,
      tool_choice: { type: "function", function: { name: "weather" } }
    });
  });

  it("rejects invalid qwen3.8-max reasoning and non-video FilePart controls before fetch", async () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider("qwen3.8-max");

    await expect(
      generateText({
        model,
        prompt: "hello",
        reasoning: { effort: "medium", budgetTokens: 16_384 }
      })
    ).rejects.toThrow("does not allow reasoning_effort and thinking_budget");
    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: { thinking_budget: 262_145 }
      })
    ).rejects.toThrow("thinking_budget must be an integer between 0 and 262144");
    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: { preserve_thinking: false }
      })
    ).rejects.toThrow("requires preserve_thinking");
    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: { tool_stream: true }
      })
    ).rejects.toThrow("tool_stream requires streamText");
    await expect(
      generateText({
        model,
        messages: [
          {
            role: "user",
            parts: [{ type: "file", data: "https://example.com/report.pdf", mediaType: "application/pdf" }]
          }
        ]
      })
    ).rejects.toThrow("FilePart input is reserved for video/* media");
    await expect(
      generateText({
        model,
        messages: [
          {
            role: "user",
            parts: [{ type: "file", data: "https://example.com/demo.mp4", mediaType: "video/mp4" }]
          }
        ],
        providerOptions: { apiMode: "responses" }
      })
    ).rejects.toThrow("does not process maxTokens, audio/video input");

    const tokenPlanProvider = createQwen({
      apiKey: "token-plan-key",
      baseURL: QWEN_TOKEN_PLAN_BASE_URL,
      fetch: fetchMock as typeof fetch
    });
    await expect(
      generateText({
        model: tokenPlanProvider("qwen3.8-max"),
        prompt: "hello"
      })
    ).rejects.toThrow("QWEN_TOKEN_PLAN_BASE_URL is reserved for qwen3.8-max-preview");
    await expect(
      generateText({
        model: tokenPlanProvider("qwen3.8-flash"),
        prompt: "hello"
      })
    ).rejects.toThrow("QWEN_TOKEN_PLAN_BASE_URL is reserved for qwen3.8-max-preview");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects tool_stream for non-streaming requests across Qwen model families", async () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider("qwen3.7-plus");

    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: { tool_stream: true }
      })
    ).rejects.toThrow("tool_stream requires streamText");

    await expect(
      generateObject({
        model,
        prompt: "Return JSON.",
        schema: z.object({ answer: z.string() }),
        providerOptions: { tool_stream: true }
      })
    ).rejects.toThrow("tool_stream requires streamText");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declares qwen3.8-max-preview as a thinking-only multimodal Token Plan model", () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider("qwen3.8-max-preview");

    expect(model.capabilities).toMatchObject({
      reasoning: true,
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      vision: true,
      tools: true,
      structuredOutput: false,
      jsonMode: false,
      parallelToolCalls: false
    });
    expect(model.capabilities.reasoningEfforts).not.toContain("none");
  });

  it("rejects native structured output for qwen3.8-max-preview before fetch", async () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateObject({
        model: provider("qwen3.8-max-preview"),
        prompt: "Return an object.",
        schema: z.object({ answer: z.string() }),
        mode: "native"
      })
    ).rejects.toThrow("does not support native structured output");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "xhigh"],
    ["xhigh", "xhigh"],
    ["max", "xhigh"]
  ] as const)(
    "maps qwen3.8-max-preview Responses effort %s to %s",
    async (effort, expectedEffort) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "resp_38",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
        })
      );
      const provider = createQwen({
        apiKey: "token-plan-key",
        baseURL: QWEN_TOKEN_PLAN_BASE_URL,
        fetch: fetchMock as typeof fetch
      });

      await generateText({
        model: provider("qwen3.8-max-preview"),
        messages: [
          {
            role: "user",
            parts: [
              { type: "image", image: "https://example.com/diagram.png", mediaType: "image/png" },
              { type: "text", text: "Explain this diagram." }
            ]
          }
        ],
        reasoning: { effort }
      });

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        `${QWEN_TOKEN_PLAN_BASE_URL}/responses`
      );
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.reasoning).toEqual({ effort: expectedEffort });
      expect(body.input[0].content).toEqual([
        { type: "input_image", image_url: "https://example.com/diagram.png" },
        { type: "input_text", text: "Explain this diagram." }
      ]);
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.thinking_budget).toBeUndefined();
      expect(body.enable_thinking).toBeUndefined();
    }
  );

  it("maps qwen3.8-max-preview reasoning effort in forced Chat mode", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }]
      })
    );
    const provider = createQwen({
      apiKey: "test",
      baseURL: QWEN_TOKEN_PLAN_BASE_URL,
      fetch: fetchMock as typeof fetch
    });

    await generateText({
      model: provider("qwen3.8-max-preview"),
      prompt: "Think deeply.",
      reasoning: { effort: "high" },
      providerOptions: { apiMode: "chat" }
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      reasoning_effort: "xhigh",
      preserve_thinking: true
    });
    expect(body.reasoning).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it("routes qwen3.8-max-preview thinking budgets through Chat and preserves reasoning", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }]
      })
    );
    const provider = createQwen({
      apiKey: "test",
      baseURL: QWEN_TOKEN_PLAN_BASE_URL,
      fetch: fetchMock as typeof fetch
    });

    await generateText({
      model: provider("qwen3.8-max-preview"),
      prompt: "Solve this.",
      maxTokens: 512,
      reasoning: { budgetTokens: 16_384 }
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chat/completions");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      thinking_budget: 16_384,
      preserve_thinking: true,
      max_completion_tokens: 512
    });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it("always returns qwen3.8-max-preview Chat reasoning_content with preserve_thinking", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "continued" } }]
      })
    );
    const provider = createQwen({
      apiKey: "test",
      baseURL: QWEN_TOKEN_PLAN_BASE_URL,
      fetch: fetchMock as typeof fetch
    });

    await generateText({
      model: provider("qwen3.8-max-preview"),
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "provider-data",
              provider: "qwen",
              data: { type: "reasoning_content", reasoningContent: "Earlier reasoning." }
            },
            { type: "text", text: "Earlier answer." }
          ]
        },
        createTextMessage("user", "Continue.")
      ],
      providerOptions: { apiMode: "chat" }
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.preserve_thinking).toBe(true);
    expect(body.messages[0]).toMatchObject({
      role: "assistant",
      reasoning_content: "Earlier reasoning.",
      content: "Earlier answer."
    });
  });

  it("rejects the pay-as-you-go endpoint for qwen3.8-max-preview before fetch", async () => {
    expect(QWEN_TOKEN_PLAN_BASE_URL).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
    );
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("qwen3.8-max-preview"),
        prompt: "hello"
      })
    ).rejects.toThrow("is Token Plan only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects decorated Token Plan base URLs before fetch", async () => {
    const provider = createQwen({
      apiKey: "test",
      baseURL: `${QWEN_TOKEN_PLAN_BASE_URL}?redirect=paygo`,
      fetch: fetchMock as typeof fetch
    });

    await expect(
      generateText({
        model: provider("qwen3.8-max-preview"),
        prompt: "hello"
      })
    ).rejects.toThrow("is Token Plan only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid qwen3.8-max-preview thinking controls before fetch", async () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const model = provider("qwen3.8-max-preview");
    const tools = {
      weather: tool({
        name: "weather",
        schema: z.object({ city: z.string() }),
        execute: ({ city }) => ({ city })
      })
    };

    await expect(
      generateText({
        model,
        prompt: "hello",
        reasoning: { effort: "none" }
      })
    ).rejects.toThrow('does not support reasoning effort "none"');
    await expect(
      generateText({
        model,
        prompt: "hello",
        reasoning: { effort: "medium", budgetTokens: 16_384 }
      })
    ).rejects.toThrow("does not allow reasoning_effort and thinking_budget");
    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: { reasoning_effort: "none" }
      })
    ).rejects.toThrow("thinking-only");
    await expect(
      generateText({
        model,
        prompt: "hello",
        providerOptions: { preserve_thinking: false }
      })
    ).rejects.toThrow("requires preserve_thinking");
    await expect(
      generateText({
        model,
        prompt: "Use weather.",
        tools,
        toolChoice: "required"
      })
    ).rejects.toThrow('only when thinking is disabled');
    expect(fetchMock).not.toHaveBeenCalled();
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
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"   ","function":{"arguments":""}}]},"finish_reason":null}]}\n\n' +
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

  it("normalizes parallel transient Chat tool-call ids before deduplication", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            { id: "0", function: { name: "weather", arguments: JSON.stringify({ city: "Madrid" }) } },
            { id: "0", function: { name: "weather", arguments: JSON.stringify({ city: "Lisbon" }) } },
            { id: "   ", function: { name: "weather", arguments: JSON.stringify({ city: "Rome" }) } },
            { id: "call_opaque", function: { name: "weather", arguments: JSON.stringify({ city: "Paris" }) } }
          ]
        }
      }]
    }));
    const model = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch })("qwen3.8-flash");
    const result = await model.generate({
      messages: [createTextMessage("user", "compare weather")],
      providerOptions: { apiMode: "chat" }
    });
    const ids = result.messages?.[0]?.parts.flatMap((part) =>
      part.type === "tool-call" ? [part.toolCall.id] : []
    );

    expect(ids).toEqual([
      "qwen-chat-tool-1-0",
      "qwen-chat-tool-1-1",
      "qwen-chat-tool-1-2",
      "call_opaque"
    ]);
  });

  it("normalizes parallel transient Responses tool-call ids before deduplication", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      id: "resp_transient_calls",
      status: "completed",
      output: [
        { type: "function_call", call_id: "0", id: "0", name: "weather", arguments: "{}" },
        { type: "function_call", call_id: "0", id: "0", name: "weather", arguments: "{}" },
        { type: "function_call", call_id: "   ", id: "   ", name: "weather", arguments: "{}" },
        { type: "function_call", call_id: "call_opaque", name: "weather", arguments: "{}" }
      ]
    }));
    const model = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch })("qwen3.8-flash");
    const result = await model.generate({
      messages: [createTextMessage("user", "compare weather")],
      providerOptions: { apiMode: "responses" }
    });
    const ids = result.messages?.[0]?.parts.flatMap((part) =>
      part.type === "tool-call" ? [part.toolCall.id] : []
    );

    expect(ids).toEqual([
      "qwen-responses-tool-1-0",
      "qwen-responses-tool-1-1",
      "qwen-responses-tool-1-2",
      "call_opaque"
    ]);
  });

  it("keeps parallel transient Chat tool calls distinct while streaming", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [
                  { index: 0, id: "0", function: { name: "weather", arguments: "{}" } },
                  { index: 1, id: "0", function: { name: "timezone", arguments: "{}" } }
                ]
              },
              finish_reason: null
            }]
          })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
          "data: [DONE]\n\n"
        ));
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const model = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch })("qwen3.8-flash");
    const stream = await model.stream({
      messages: [createTextMessage("user", "compare cities")],
      providerOptions: { apiMode: "chat" }
    });
    const toolCalls = [];
    for await (const event of stream) {
      if (event.type === "tool-call") toolCalls.push(event.toolCall);
    }

    expect(toolCalls).toEqual([
      { id: "qwen-chat-tool-1-0", name: "weather", input: {} },
      { id: "qwen-chat-tool-1-1", name: "timezone", input: {} }
    ]);
  });

  it("correlates parallel transient Responses tool calls by output position while streaming", async () => {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "0", call_id: "0", name: "weather" } },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "0", call_id: "0", name: "timezone" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "0", call_id: "0", delta: "{\"city\":\"Mad" },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "0", call_id: "0", delta: "{\"city\":\"Lis" },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "0", call_id: "0", arguments: "{\"city\":\"Madrid\"}" },
      { type: "response.function_call_arguments.done", output_index: 1, item_id: "0", call_id: "0", arguments: "{\"city\":\"Lisbon\"}" },
      { type: "response.completed", response: { status: "completed" } }
    ];
    const body = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const model = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch })("qwen3.8-flash");
    const stream = await model.stream({
      messages: [createTextMessage("user", "compare cities")],
      providerOptions: { apiMode: "responses" }
    });
    const toolCalls = [];
    for await (const event of stream) {
      if (event.type === "tool-call") toolCalls.push(event.toolCall);
    }

    expect(toolCalls).toEqual([
      { id: "qwen-responses-tool-1-0", name: "weather", input: { city: "Madrid" } },
      { id: "qwen-responses-tool-1-1", name: "timezone", input: { city: "Lisbon" } }
    ]);
  });

  it("synthesizes distinct durable Chat tool-call ids across streamed turns", async () => {
    const toolResponse = (city: string) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { name: "weather", arguments: JSON.stringify({ city }) }
                }]
              },
              finish_reason: null
            }]
          })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
          "data: [DONE]\n\n"
        ));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });
    const finalResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\n` +
          "data: [DONE]\n\n"
        ));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });
    fetchMock
      .mockResolvedValueOnce(toolResponse("Madrid"))
      .mockResolvedValueOnce(toolResponse("Lisbon"))
      .mockResolvedValueOnce(finalResponse);

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("qwen-plus"),
      prompt: "compare weather",
      maxSteps: 3,
      providerOptions: { apiMode: "chat" },
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 26 })
        })
      }
    });

    expect((await result.collect()).text).toBe("done");
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const thirdRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    const firstId = secondRequest.messages.find((message: any) => message.role === "assistant")
      ?.tool_calls?.[0]?.id;
    const secondId = thirdRequest.messages.filter((message: any) => message.role === "assistant")
      .at(-1)?.tool_calls?.[0]?.id;
    expect(firstId).toMatch(/^qwen-chat-tool-\d+-0$/);
    expect(secondId).toMatch(/^qwen-chat-tool-\d+-0$/);
    expect(secondId).not.toBe(firstId);
  });

  it("advances fallback Chat tool-call ids for repeated transient ids after compaction", async () => {
    const transientIdResponse = () => Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [{
            id: "0",
            function: { name: "weather", arguments: JSON.stringify({ city: "Madrid" }) }
          }]
        }
      }]
    });
    fetchMock
      .mockResolvedValueOnce(transientIdResponse())
      .mockResolvedValueOnce(transientIdResponse());
    const compactedMessages = (toolCallId: string) => [
      createTextMessage("user", "weather"),
      {
        role: "assistant" as const,
        parts: [{
          type: "tool-call" as const,
          toolCall: { id: toolCallId, name: "weather", input: { city: "Lisbon" } }
        }]
      },
      {
        role: "tool" as const,
        parts: [{
          type: "tool-result" as const,
          toolResult: { toolCallId, isError: false, output: { temperatureC: 26 } }
        }]
      }
    ];
    const model = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch })("qwen-plus");

    const first = await model.generate({
      messages: compactedMessages("qwen-chat-tool-2-0"),
      providerOptions: { apiMode: "chat" }
    });
    const firstCall = first.messages?.[0]?.parts.find((part) => part.type === "tool-call");
    const firstId = firstCall?.type === "tool-call" ? firstCall.toolCall.id : undefined;
    const second = await model.generate({
      messages: compactedMessages(firstId ?? "missing"),
      providerOptions: { apiMode: "chat" }
    });
    const secondCall = second.messages?.[0]?.parts.find((part) => part.type === "tool-call");

    expect(firstId).toBe("qwen-chat-tool-3-0");
    expect(secondCall).toMatchObject({
      type: "tool-call",
      toolCall: { id: "qwen-chat-tool-4-0" }
    });
  });

  it("synthesizes non-empty Responses tool-call ids", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      id: "resp_missing_call_id",
      status: "completed",
      output: [{
        type: "function_call",
        name: "weather",
        arguments: JSON.stringify({ city: "Madrid" })
      }]
    }));
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await provider("qwen-plus").generate({
      messages: [createTextMessage("user", "weather")],
      providerOptions: { apiMode: "responses" }
    });
    const toolCall = result.messages?.[0]?.parts.find((part) => part.type === "tool-call");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolCall: {
        id: "qwen-responses-tool-1-0",
        name: "weather",
        input: { city: "Madrid" }
      }
    });
  });

  it("rejects duplicate Chat tool-call ids with a bounded diagnostic code", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [{
            id: "call_existing",
            function: { name: "weather", arguments: JSON.stringify({ city: "Lisbon" }) }
          }]
        }
      }]
    }));
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await expect(provider("qwen-plus").generate({
      messages: [
        createTextMessage("user", "weather in Madrid"),
        {
          role: "assistant",
          parts: [{
            type: "tool-call",
            toolCall: { id: "call_existing", name: "weather", input: { city: "Madrid" } }
          }]
        },
        {
          role: "tool",
          parts: [{
            type: "tool-result",
            toolResult: { toolCallId: "call_existing", isError: false, output: { temperatureC: 26 } }
          }]
        },
        createTextMessage("user", "now Lisbon")
      ],
      providerOptions: { apiMode: "chat" }
    })).rejects.toMatchObject({
      name: "QwenToolCallIdError",
      diagnosticCode: "QWEN_DUPLICATE_TOOL_CALL_ID"
    });
  });

  it("rejects duplicate stable ids before tool execution", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            { id: "call_duplicate", function: { name: "weather", arguments: "{}" } },
            { id: "call_duplicate", function: { name: "weather", arguments: "{}" } }
          ]
        }
      }]
    }));
    const execute = vi.fn(() => ({ temperatureC: 26 }));
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(generateText({
      model: provider("qwen3.8-flash"),
      prompt: "compare weather",
      maxSteps: 2,
      providerOptions: { apiMode: "chat" },
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({}),
          execute
        })
      }
    })).rejects.toMatchObject({
      name: "QwenToolCallIdError",
      diagnosticCode: "QWEN_DUPLICATE_TOOL_CALL_ID",
      message: "Qwen returned a duplicate tool-call id."
    });
    expect(execute).not.toHaveBeenCalled();
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
            audio: { url: "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/speech.wav" }
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
    ).rejects.toThrow("require an HTTPS URL");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          output: {
            audio: { url: "https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/speech.wav" }
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
      );

    await expect(
      generateSpeech({ model: provider.speechModel!("qwen3-tts-flash"), input: "hello" })
    ).rejects.toThrow("require an HTTPS URL");
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

    const handshake = new Promise<{
      authorization?: string;
      payload: Record<string, unknown>;
      sendOversizedFrame: () => void;
    }>(
      (resolve, reject) => {
        server.once("connection", (socket, request) => {
          socket.once("message", (data) => {
            try {
              resolve({
                authorization: request.headers.authorization,
                payload: JSON.parse(data.toString()),
                sendOversizedFrame: () => {
                  socket.send(JSON.stringify({
                    type: "response.text.delta",
                    delta: "x".repeat(256)
                  }));
                  socket.send(JSON.stringify({ type: "session.finished" }));
                }
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
      realtimeURL: `ws://127.0.0.1:${address.port}/realtime`,
      allowUnsafeEndpoints: true
    });
    const session = await provider.realtimeModel!("qwen3.5-omni-plus-realtime").connect(
      { instructions: "be concise" },
      { timeoutMs: 5_000, maxIncomingFrameBytes: 64 }
    );

    try {
      const connected = await handshake;
      expect(connected).toMatchObject({
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
      connected.sendOversizedFrame();

      const events = [];
      for await (const event of session.eventStream()) {
        events.push(event);
      }
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "realtime-error",
          message: expect.stringMatching(/payload|message size|frame/i)
        }),
        expect.objectContaining({ type: "realtime-end", reason: "error" })
      ]));
    } finally {
      await session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("validates Qwen Node realtime frame limits before opening a socket", async () => {
    const provider = createQwen({
      apiKey: "qwen-secret",
      realtimeURL: "ws://127.0.0.1:1/realtime",
      allowUnsafeEndpoints: true
    });

    await expect(
      provider.realtimeModel!("qwen3.5-omni-plus-realtime").connect(
        {},
        { maxIncomingFrameBytes: 0 }
      )
    ).rejects.toThrow("positive safe integer");
    await expect(
      provider.realtimeModel!("qwen3.5-omni-plus-realtime").connect(
        {},
        { timeoutMs: 0 }
      )
    ).rejects.toThrow("positive safe integer");
  });

  it("fails closed for unsupported realtime tool selection and search combinations", async () => {
    const connectionFactory = vi.fn(async () => ({
      async sendJson() {},
      async recvJson() { return undefined; },
      async close() {}
    }));
    const model = createQwen({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: connectionFactory
    }).realtimeModel!("qwen3.5-omni-plus-realtime");

    expect(model.capabilities).toMatchObject({
      streaming: false,
      structuredOutput: false,
      jsonMode: false,
      toolChoice: false,
      parallelToolCalls: false,
      embeddings: false,
      reasoning: false
    });
    await expect(model.connect({ toolChoice: "required" })).rejects.toThrow(
      "not required or named tool choice"
    );
    await expect(
      model.connect({
        tools: {
          weather: tool({
            name: "weather",
            schema: z.object({ city: z.string() }),
            execute: () => ({ ok: true })
          })
        },
        providerOptions: { enable_search: true }
      })
    ).rejects.toThrow("cannot be enabled together");
    expect(connectionFactory).not.toHaveBeenCalled();
  });

  it("honors manual response control for realtime text, audio, and tool results", async () => {
    const sent: Record<string, unknown>[] = [];
    let releaseReceive: ((value: undefined) => void) | undefined;
    const connection: RealtimeConnection = {
      async sendJson(payload) { sent.push(payload); },
      async recvJson() {
        return new Promise<undefined>((resolve) => {
          releaseReceive = resolve;
        });
      },
      async close() { releaseReceive?.(undefined); }
    };
    const provider = createQwen({
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      realtimeConnectionFactory: async () => connection
    });
    const session = await provider.realtimeModel!("qwen3.5-omni-plus-realtime").connect({
      autoResponse: false
    });

    await session.sendText("hello");
    await session.sendAudio({
      data: new Uint8Array([1, 2]),
      mediaType: "audio/pcm",
      isFinal: true
    });
    await session.sendToolResult({
      toolCallId: "call_1",
      toolName: "weather",
      output: { ok: true },
      isError: false
    });
    await session.close();

    expect(sent[0]).toMatchObject({
      type: "session.update",
      session: { modalities: ["text"] }
    });
    expect(sent).toContainEqual({ type: "input_audio_buffer.commit" });
    expect(sent).not.toContainEqual({ type: "response.create" });
  });

  it("rejects unsafe Qwen realtime endpoints unless explicitly opted in", () => {
    expect(() =>
      createQwen({
        apiKey: "qwen-secret",
        realtimeURL: "ws://127.0.0.1:8787/collect"
      })
    ).toThrow("must use wss");

    expect(() =>
      createQwen({
        apiKey: "qwen-secret",
        realtimeURL: "wss://attacker.example/collect"
      })
    ).toThrow("is not trusted");
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
      {
        type: "response.function_call_arguments.done",
        call_id: "0",
        item_id: "0",
        name: "weather",
        arguments: "{\"city\":\"Lisbon\"}"
      },
      {
        type: "response.function_call_arguments.done",
        call_id: "0",
        item_id: "0",
        name: "weather",
        arguments: "{\"city\":\"Buenos Aires\"}"
      },
      {
        type: "response.function_call_arguments.done",
        name: "weather",
        arguments: "{\"city\":\"Rome\"}"
      },
      {
        type: "response.function_call_arguments.done",
        name: "weather",
        arguments: "{\"city\":\"Paris\"}"
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
        expect.objectContaining({
          type: "realtime-tool-call",
          toolCall: { id: "qwen-realtime-tool-0", name: "weather", input: { city: "Lisbon" } }
        }),
        expect.objectContaining({
          type: "realtime-tool-call",
          toolCall: { id: "qwen-realtime-tool-1", name: "weather", input: { city: "Buenos Aires" } }
        }),
        expect.objectContaining({
          type: "realtime-tool-call",
          toolCall: { id: "qwen-realtime-tool-2", name: "weather", input: { city: "Rome" } }
        }),
        expect.objectContaining({
          type: "realtime-tool-call",
          toolCall: { id: "qwen-realtime-tool-3", name: "weather", input: { city: "Paris" } }
        }),
        expect.objectContaining({ type: "realtime-response-complete", reason: "completed" }),
        expect.objectContaining({ type: "realtime-end", reason: "finished" })
      ])
    );
  });

  it("exposes Qwen realtime and package-specific rerank helpers", async () => {
    const sent: Record<string, unknown>[] = [];
    let finishReceive: ((value: undefined) => void) | undefined;
    const receive = new Promise<undefined>((resolve) => {
      finishReceive = resolve;
    });
    const connection: RealtimeConnection = {
      async sendJson(payload) {
        sent.push(payload);
      },
      async recvJson() {
        return receive;
      },
      async close() {
        finishReceive?.(undefined);
      }
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
