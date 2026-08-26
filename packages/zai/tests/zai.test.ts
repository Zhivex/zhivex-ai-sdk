import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  ValidationError,
  generateObject,
  generateText,
  streamText,
  tool
} from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import {
  ZAI_CODING_BASE_URL,
  ZAI_GENERAL_BASE_URL,
  createZAI
} from "../src/index.js";

const sseResponse = (...events: Array<Record<string, unknown> | "[DONE]">) => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          events
            .map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`)
            .join("")
        )
      );
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
};

describe("zai adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "zai",
    modelId: "glm-5.3",
    createModel: () => createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3"),
    expectedAgentTier: "tier-b",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: false,
      parallelToolCalls: false,
      vision: false,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      contextCaching: true,
      reasoningEfforts: ["low", "high", "max"],
      reasoning: true,
      webSearch: false
    }
  });

  runLanguageModelContractSuite({
    providerName: "zai",
    modelId: "glm-5.3-flash",
    createModel: () => createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3-flash"),
    expectedAgentTier: "tier-b",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: false,
      parallelToolCalls: false,
      vision: true,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      contextCaching: true,
      reasoningEfforts: ["low", "high", "max"],
      reasoning: true,
      webSearch: false
    }
  });

  runAgentProviderContractSuite({
    providerName: "zai",
    modelId: "glm-5.3",
    expectedAgentTier: "tier-b",
    createModel: () => createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ choices: [{ finish_reason: "stop", message: { content: "hello from Z.ai" } }] })
      );
    },
    mockToolRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                reasoning_content: "I need the weather tool.",
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
        Response.json({ choices: [{ finish_reason: "stop", message: { content: "Madrid is sunny" } }] })
      );
    },
    mockStreamRun: () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse(
          { choices: [{ delta: { reasoning_content: "Think" } }] },
          { choices: [{ delta: { content: "hello Z.ai" }, finish_reason: "stop" }] },
          "[DONE]"
        )
      );
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("models GLM-5.3 Flash, GLM-5.2, and unknown-model capabilities independently", () => {
    const provider = createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    expect(provider("glm-5.3-flash").capabilities).toMatchObject({
      vision: true,
      reasoning: true,
      reasoningEfforts: ["low", "high", "max"]
    });
    expect(provider("glm-5.2").capabilities).toMatchObject({
      vision: false,
      reasoning: true,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
    });
    expect(provider("custom-glm").capabilities).toMatchObject({ reasoning: false });
    expect(provider("custom-glm").capabilities.reasoningEfforts).toBeUndefined();
  });

  it("requires credentials and selects the general or Coding Plan endpoint explicitly", async () => {
    expect(() => createZAI({ apiKey: "" })).toThrow(ConfigurationError);

    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }))
    );
    await generateText({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.2"),
      prompt: "hello"
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${ZAI_GENERAL_BASE_URL}/chat/completions`);

    fetchMock.mockClear();
    await generateText({
      model: createZAI({ apiKey: "test", endpoint: "coding", fetch: fetchMock as typeof fetch })("glm-5.3"),
      prompt: "hello"
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${ZAI_CODING_BASE_URL}/chat/completions`);
  });

  it("maps GLM-5.3 thinking and strict reasoning efforts", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "reasoned" } }] })
    );
    await generateText({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3"),
      prompt: "reason",
      reasoning: { effort: "max" }
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max"
    });

    const model = createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3");
    await expect(
      generateText({ model, prompt: "reason", reasoning: { effort: "none" } })
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(
      generateText({
        model,
        prompt: "reason",
        providerOptions: { thinking: { type: "disabled" } },
        maxRetries: 0
      })
    ).rejects.toThrow('GLM-5.3 requires thinking.type "enabled"');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      model.generate({
        messages: [{ role: "user", parts: [{ type: "text", text: "reason" }] }],
        reasoning: { effort: "medium" }
      })
    ).rejects.toThrow('GLM-5.3 supports shared reasoning effort "low", "high", or "max"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps GLM-5.3 Flash multimodal input in order and preserves thinking by default", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "The diagrams differ." } }] })
    );

    await generateText({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3-flash"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Compare " },
            { type: "image", image: "https://example.com/first.png", mediaType: "image/png" },
            { type: "text", text: " with " },
            { type: "image", image: "aGVsbG8=", mediaType: "image/jpeg" }
          ]
        }
      ],
      reasoning: { effort: "max" }
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      model: "glm-5.3-flash",
      thinking: { type: "enabled", clear_thinking: false },
      reasoning_effort: "max"
    });
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Compare " },
          { type: "image_url", image_url: { url: "https://example.com/first.png" } },
          { type: "text", text: " with " },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,aGVsbG8=" } }
        ]
      }
    ]);
  });

  it("combines GLM-5.3 Flash image input with JSON-object structured output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"title":"Diagram"}' } }] })
    );

    const result = await generateObject({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3-flash"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Return a title for this image." },
            { type: "image", image: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }
          ]
        }
      ],
      schema: z.object({ title: z.string() }),
      mode: "native",
      reasoning: { effort: "low" }
    });

    expect(result.object).toEqual({ title: "Diagram" });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining('"title"')
    });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Return a title for this image." },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }
      ]
    });
  });

  it("rejects undocumented media inputs before calling Z.ai", async () => {
    const provider = createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await expect(
      provider("glm-5.3").generate({
        messages: [
          {
            role: "user",
            parts: [{ type: "image", image: "https://example.com/image.png", mediaType: "image/png" }]
          }
        ]
      })
    ).rejects.toThrow('model "glm-5.3" does not support image input');
    await expect(
      provider("glm-5.3-flash").generate({
        messages: [
          {
            role: "user",
            parts: [{ type: "image", image: "aGVsbG8=", mediaType: "text/plain" }]
          }
        ]
      })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      provider("glm-5.3-flash").generate({
        messages: [
          {
            role: "user",
            parts: [{ type: "file", data: "aGVsbG8=", mediaType: "application/pdf" }]
          }
        ]
      })
    ).rejects.toThrow('does not support file input');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["none", { type: "disabled" }, undefined],
    ["minimal", { type: "disabled" }, undefined],
    ["low", { type: "enabled" }, "high"],
    ["medium", { type: "enabled" }, "high"],
    ["high", { type: "enabled" }, "high"],
    ["xhigh", { type: "enabled" }, "max"],
    ["max", { type: "enabled" }, "max"]
  ] as const)("maps GLM-5.2 shared effort %s", async (effort, thinking, expectedEffort) => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] })
    );
    await generateText({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.2"),
      prompt: "reason",
      reasoning: { effort }
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.thinking).toEqual(thinking);
    expect(body.reasoning_effort).toBe(expectedEffort);
  });

  it("allows GLM-5.2 callers to omit thoughts when thinking is disabled", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "plain" } }] })
    );
    await generateText({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.2"),
      prompt: "plain",
      reasoning: { effort: "none", includeThoughts: false }
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("does not re-enable GLM-5.2 thinking for raw none effort when tools are present", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "plain" } }] })
    );
    await generateText({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.2"),
      prompt: "plain",
      maxSteps: 1,
      tools: {
        noop: tool({
          name: "noop",
          schema: z.object({}),
          execute: () => ({ ok: true })
        })
      },
      providerOptions: { reasoning_effort: "none" }
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBe("none");
  });

  it("rejects conflicting reasoning options and unsupported shared controls before fetch", async () => {
    const model = createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.2");
    await expect(
      generateText({
        model,
        prompt: "reason",
        reasoning: { effort: "high" },
        providerOptions: { reasoning_effort: "max" }
      })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      generateText({ model, prompt: "reason", reasoning: { budgetTokens: 1024 } })
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(
      generateText({ model, prompt: "reason", reasoning: { effort: "high", includeThoughts: false } })
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses JSON object mode with a schema prompt", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: '{"city":"Buenos Aires"}' } }]
      })
    );
    const result = await generateObject({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.2"),
      prompt: "Return the city.",
      schema: z.object({ city: z.string() }),
      mode: "native"
    });
    expect(result.object).toEqual({ city: "Buenos Aires" });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining('"city"')
    });
  });

  it("preserves and replays reasoning content across tool turns", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              reasoning_content: "I should check Madrid.",
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  function: { name: "weather", arguments: '{"city":"Madrid"}' }
                }
              ]
            }
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "Sunny" } }] })
    );

    const result = await generateText({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3"),
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
    expect(result.text).toBe("Sunny");
    const followup = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(followup.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(followup.messages.find((message: any) => message.role === "assistant")).toMatchObject({
      content: "",
      reasoning_content: "I should check Madrid."
    });
  });

  it("buffers fragmented streamed reasoning and tool calls by index", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        { choices: [{ delta: { reasoning_content: "Need weather." } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call-", function: { name: "wea", arguments: '{"ci' } }
                ]
              }
            }
          ]
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "1", function: { name: "ther", arguments: 'ty":"Madrid"}' } }
                ]
              }
            }
          ]
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 4 },
            total_tokens: 15
          }
        },
        "[DONE]"
      )
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        { choices: [{ delta: { content: "Sunny" }, finish_reason: "stop" }] },
        "[DONE]"
      )
    );
    const result = streamText({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3"),
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
    expect(final.text).toBe("Sunny");
    expect(final.toolResults[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "weather",
      output: { city: "Madrid", forecast: "sunny" }
    });
    expect(final.messages[1]?.parts).toContainEqual({
      type: "provider-data",
      provider: "zai",
      data: { type: "reasoning_content", reasoningContent: "Need weather." }
    });
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstBody.tool_stream).toBe(true);
    expect(firstBody.tool_choice).toBe("auto");
  });

  it("keeps interleaved streamed tool-call buffers separate without advertising parallel support", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        {
          choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "fir", arguments: '{"n":' } }] } }]
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "sec", arguments: '{"n":' } }] } }]
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "first", arguments: "1}" } }] } }]
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "ond", arguments: "2}" } }] } }]
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]"
      )
    );
    const model = createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3");
    const events = [];
    for await (const event of await model.stream!({
      messages: [{ role: "user", parts: [{ type: "text", text: "call both" }] }]
    })) {
      events.push(event);
    }
    expect(model.capabilities.parallelToolCalls).toBe(false);
    expect(events.filter((event) => event.type === "tool-call")).toEqual([
      { type: "tool-call", toolCall: { id: "a", name: "first", input: { n: 1 } } },
      { type: "tool-call", toolCall: { id: "b", name: "second", input: { n: 2 } } }
    ]);
  });

  it.each([
    ["sensitive", "content-filter"],
    ["model_context_window_exceeded", "length"],
    ["network_error", "error"]
  ])("normalizes finish reason %s", async (providerReason, finishReason) => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: providerReason, message: { content: "partial" } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 3 },
          total_tokens: 14
        }
      })
    );
    const result = await generateText({
      model: createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.2"),
      prompt: "hello"
    });
    expect(result).toMatchObject({
      finishReason,
      providerFinishReason: providerReason,
      usage: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, totalTokens: 14 }
    });
  });

  it("surfaces HTTP and HTTP-200 provider errors", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { code: "1311", message: "Plan lacks model access" } },
        { status: 429, headers: { "retry-after": "2.5" } }
      )
    );
    const model = createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.3");
    await expect(generateText({ model, prompt: "hello", maxRetries: 0 })).rejects.toMatchObject({
      name: "ProviderHTTPError",
      status: 429,
      retryAfterMs: 2_500,
      responseBody: expect.stringContaining("1311")
    });

    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: "1302", message: "Rate limit" } })
    );
    const error = await generateText({ model, prompt: "hello", maxRetries: 0 }).catch((reason) => reason);
    expect(error).toBeInstanceOf(ProviderHTTPError);
    expect(error).toMatchObject({ status: 429 });

    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: "1214", message: "Invalid field" } })
    );
    const invalid = await generateText({ model, prompt: "hello", maxRetries: 2 }).catch((reason) => reason);
    expect(invalid).toMatchObject({ name: "ProviderHTTPError", status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("validates provider controls and prevents reserved request overrides", async () => {
    const model = createZAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("glm-5.2");
    await expect(
      generateText({ model, prompt: "hello", providerOptions: { temperature: 2 } })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      generateText({ model, prompt: "hello", providerOptions: { stop: ["1", "2", "3", "4", "5"] } })
    ).rejects.toBeInstanceOf(ValidationError);

    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] })
    );
    await generateText({
      model,
      prompt: "hello",
      providerOptions: {
        model: "attacker-model",
        messages: [{ role: "system", content: "override" }],
        stream: true,
        request_id: "request-123"
      }
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.model).toBe("glm-5.2");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.request_id).toBe("request-123");
  });
});
