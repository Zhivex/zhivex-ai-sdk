import { describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  ProviderToolCallError,
  UnsupportedFeatureError,
  createTextMessage,
  generateText,
  streamText,
  wrapLanguageModel
} from "@zhivex-ai/core";

import {
  AzureOpenAIAuthenticationError,
  AzureOpenAIContentFilterError,
  azureEntraTokenProvider,
  createAzureOpenAI
} from "../src/index.ts";

const chat = (extra: Record<string, unknown> = {}) => Response.json({
  choices: [{ finish_reason: "stop", message: { content: "ok" } }],
  usage: {
    prompt_tokens: 5,
    completion_tokens: 3,
    total_tokens: 8,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 1 }
  },
  ...extra
});

const bodyOf = (fetcher: ReturnType<typeof vi.fn>) =>
  JSON.parse(String((fetcher.mock.calls.at(-1)?.[1] as RequestInit).body));

const headersOf = (fetcher: ReturnType<typeof vi.fn>) =>
  (fetcher.mock.calls.at(-1)?.[1] as RequestInit).headers as Record<string, string>;

describe("Azure OpenAI audit fixes", () => {
  it("sends a bearer token from tokenProvider and refreshes it per request", async () => {
    const fetcher = vi.fn().mockImplementation(() => chat());
    let issued = 0;
    const provider = createAzureOpenAI({
      endpoint: "https://example.openai.azure.com",
      tokenProvider: () => `token-${++issued}`,
      fetch: fetcher
    });
    await generateText({ model: provider("gpt-4o-mini"), prompt: "one" });
    await generateText({ model: provider("gpt-4o-mini"), prompt: "two" });
    expect(headersOf(fetcher).authorization).toBe("Bearer token-2");
    expect(headersOf(fetcher)["api-key"]).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects apiKey together with tokenProvider and ignores the env key when a provider is set", () => {
    expect(() => createAzureOpenAI({
      apiKey: "key",
      endpoint: "https://example.openai.azure.com",
      tokenProvider: () => "token"
    })).toThrow(/mutually exclusive/);
    const previous = process.env.AZURE_OPENAI_API_KEY;
    process.env.AZURE_OPENAI_API_KEY = "env-key";
    try {
      const fetcher = vi.fn().mockImplementation(() => chat());
      const provider = createAzureOpenAI({
        endpoint: "https://example.openai.azure.com",
        tokenProvider: azureEntraTokenProvider({
          getToken: async () => ({ token: "entra-token" })
        }),
        fetch: fetcher
      });
      return generateText({ model: provider("gpt-4o-mini"), prompt: "hello" }).then(() => {
        expect(headersOf(fetcher).authorization).toBe("Bearer entra-token");
      });
    } finally {
      if (previous === undefined) delete process.env.AZURE_OPENAI_API_KEY;
      else process.env.AZURE_OPENAI_API_KEY = previous;
    }
  });

  it("uses the deployment base model for reasoning token limits without putting baseModel in the body", async () => {
    const fetcher = vi.fn().mockImplementation(() => chat());
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      deployments: { "prod-chat": { model: "gpt-5" } },
      fetch: fetcher
    });
    await generateText({
      model: provider("prod-chat"),
      prompt: "hello",
      maxTokens: 32
    });
    const body = bodyOf(fetcher);
    expect(body.max_completion_tokens).toBe(32);
    expect(body.max_tokens).toBeUndefined();
    expect(body.baseModel).toBeUndefined();
    expect(body.model).toBe("prod-chat");
    expect(provider("prod-chat").capabilities.reasoning).toBe(true);
  });

  it("sends max_completion_tokens for gpt-5 even without a reasoning config", async () => {
    const fetcher = vi.fn().mockImplementation(() => chat());
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetcher
    });
    await generateText({ model: provider("gpt-5"), prompt: "hello", maxTokens: 20 });
    expect(bodyOf(fetcher)).toMatchObject({ max_completion_tokens: 20 });
    expect(bodyOf(fetcher).max_tokens).toBeUndefined();
    expect(bodyOf(fetcher).reasoning_effort).toBeUndefined();
  });

  it("keeps max_tokens for gpt-4o-mini", async () => {
    const fetcher = vi.fn().mockImplementation(() => chat());
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetcher
    });
    await generateText({ model: provider("gpt-4o-mini"), prompt: "hello", maxTokens: 20 });
    expect(bodyOf(fetcher)).toMatchObject({ max_tokens: 20 });
    expect(bodyOf(fetcher).max_completion_tokens).toBeUndefined();
  });

  it("calls Responses at /openai/v1/responses with the deployment name when apiVersion is set", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 2 } }
    }));
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      apiVersion: "2024-10-21",
      fetch: fetcher
    });
    const result = await generateText({
      model: provider("my-astra"),
      prompt: "hello",
      providerOptions: { apiMode: "responses", baseModel: "gpt-6-astra" }
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://example.openai.azure.com/openai/v1/responses");
    expect(bodyOf(fetcher).model).toBe("my-astra");
    expect(bodyOf(fetcher).baseModel).toBeUndefined();
    expect(result.usage).toMatchObject({ cachedInputTokens: 1, reasoningTokens: 2 });
  });

  it("reads retry-after-ms and retries by default", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("slow", { status: 429, headers: { "retry-after-ms": "0" } }))
      .mockResolvedValueOnce(chat());
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetcher
    });
    const result = await generateText({ model: provider("gpt-4o-mini"), prompt: "hello" });
    expect(result.text).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.mocked(Math.random).mockRestore();
  });

  it("classifies content_filter 400 as a typed non-retryable error", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "content_filter", message: "filtered" }
    }), { status: 400, headers: { "content-type": "application/json" } }));
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetcher
    });
    await expect(generateText({
      model: provider("gpt-4o-mini"),
      prompt: "hello",
      maxRetries: 2
    })).rejects.toBeInstanceOf(AzureOpenAIContentFilterError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies 401 as an authentication error and does not retry it", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("denied", { status: 401 }));
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetcher
    });
    await expect(generateText({ model: provider("gpt-4o-mini"), prompt: "hello" }))
      .rejects.toBeInstanceOf(AzureOpenAIAuthenticationError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not release tool calls when a Responses stream fails", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      [
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"weather","arguments":""}}',
        'data: {"type":"response.function_call_arguments.done","item_id":"item_1","arguments":"{\\"city\\":\\"Madrid\\"}"}',
        'data: {"type":"response.failed","response":{"status":"failed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}'
      ].join("\n\n") + "\n\n"
    ));
    const model = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetcher
    })("gpt-6-astra");
    const events = [];
    await expect((async () => {
      for await (const event of await model.stream!({ messages: [createTextMessage("user", "weather")], maxRetries: 0 })) {
        events.push(event);
      }
    })()).rejects.toBeInstanceOf(ProviderToolCallError);
    expect(events.some((event) => event.type === "tool-call")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "error", usage: { totalTokens: 4 } });
  });

  it("fails a Responses stream that never reaches a terminal event", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
    ));
    const model = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetcher
    })("gpt-6-astra");
    await expect((async () => {
      for await (const _event of await model.stream!({ messages: [createTextMessage("user", "hello")], maxRetries: 0 })) {
        // drain
      }
    })()).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("validates reasoning effort against a per-call baseModel on an opaque deployment", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
    }));
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      deployments: { prod: { model: "gpt-4o-mini" } },
      fetch: fetcher
    });
    const model = provider("prod");
    expect(model.capabilities.reasoningEfforts).toBeUndefined();
    await expect(generateText({
      model,
      prompt: "hello",
      reasoning: { effort: "max" }
    })).rejects.toThrow(/does not support reasoning effort "max"/);
    expect(fetcher).not.toHaveBeenCalled();

    const call = {
      messages: [createTextMessage("user", "hello")],
      reasoning: { effort: "max" as const },
      providerOptions: { baseModel: "gpt-6-astra" },
      maxRetries: 0
    };
    const wrapped = wrapLanguageModel(model, [{ name: "noop" }]);
    let coreHonorsPerCallBaseModel = true;
    try {
      await generateText({
        model: wrapped,
        prompt: "hello",
        reasoning: { effort: "max" },
        providerOptions: { baseModel: "gpt-6-astra" }
      });
    } catch (error) {
      // Published core 1.30.1 validates construction-time capabilities and does not call resolveCapabilities.
      // Workspace core must still accept the per-call base model through generateText.
      if (process.env.ZHIVEX_MINIMUM_CORE_PACKAGE !== "azure-openai") {
        throw error;
      }
      coreHonorsPerCallBaseModel = false;
      expect(error).toBeInstanceOf(UnsupportedFeatureError);
      expect((error as Error).message).toMatch(/does not support reasoning effort "max"/);
      await model.generate(call);
    }
    expect(bodyOf(fetcher).reasoning).toEqual({ effort: "max" });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://example.openai.azure.com/openai/v1/responses");

    fetcher.mockResolvedValueOnce(new Response(
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}\n\n'
    ));
    if (coreHonorsPerCallBaseModel) {
      await streamText({
        model: provider("my-deploy"),
        prompt: "hello",
        reasoning: { effort: "max" },
        providerOptions: { baseModel: "gpt-6-astra" }
      }).collect();
    } else {
      const events = [];
      for await (const event of await provider("my-deploy").stream!(call)) {
        events.push(event);
      }
      expect(events.some((event) => event.type === "text-delta")).toBe(true);
    }
    expect(bodyOf(fetcher).reasoning).toEqual({ effort: "max" });
  });

  it("maps cached and reasoning tokens on chat completions", async () => {
    const fetcher = vi.fn().mockImplementation(() => chat());
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetcher
    });
    const result = await generateText({ model: provider("gpt-4o-mini"), prompt: "hello" });
    expect(result.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 3,
      cachedInputTokens: 2,
      reasoningTokens: 1
    });
  });

  it("maps incomplete_details reasons on Responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output_text: "partial"
    }));
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetcher
    });
    const result = await generateText({
      model: provider("gpt-6-astra"),
      prompt: "hello"
    });
    expect(result.finishReason).toBe("content-filter");
  });
});
