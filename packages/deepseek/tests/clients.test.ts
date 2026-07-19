import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeepSeekClients } from "../src/clients.js";

const sseResponse = (...events: Array<Record<string, unknown> | "[DONE]">) => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          events.map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join("")
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

describe("DeepSeek provider-specific clients", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires an API key", () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect(() => createDeepSeekClients()).toThrow("Missing DeepSeek API key.");
    } finally {
      if (previous === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previous;
      }
    }
  });

  it("generates a typed FIM completion through the beta endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            index: 0,
            text: "return fib(a - 1) + fib(a - 2)\n",
            finish_reason: "stop",
            logprobs: {
              text_offset: [0],
              token_logprobs: [-0.1],
              tokens: ["return"],
              top_logprobs: [{ return: -0.1 }]
            }
          }
        ],
        usage: {
          prompt_tokens: 12,
          prompt_cache_hit_tokens: 8,
          prompt_cache_miss_tokens: 4,
          completion_tokens: 6,
          total_tokens: 18,
          completion_tokens_details: { reasoning_tokens: 2 }
        }
      })
    );

    const clients = createDeepSeekClients({
      apiKey: "secret",
      baseURL: "https://stable.example/v1/",
      betaBaseURL: "https://beta.example/beta/",
      fetch: fetchMock as typeof fetch
    });
    const result = await clients.fim.generate({
      prompt: "def fib(a):\n",
      suffix: "\nprint(fib(5))",
      echo: true,
      logprobs: 5,
      maxTokens: 128,
      stop: ["```"],
      temperature: 0.2,
      topP: 0.9
    });

    expect(result).toMatchObject({
      text: "return fib(a - 1) + fib(a - 2)\n",
      finishReason: "stop",
      providerFinishReason: "stop",
      usage: {
        inputTokens: 12,
        cachedInputTokens: 8,
        outputTokens: 6,
        reasoningTokens: 2,
        totalTokens: 18
      },
      choices: [
        {
          index: 0,
          finishReason: "stop",
          logprobs: { tokens: ["return"] }
        }
      ]
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://beta.example/beta/completions");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: "Bearer secret", "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "deepseek-v4-pro",
      prompt: "def fib(a):\n",
      suffix: "\nprint(fib(5))",
      echo: true,
      logprobs: 5,
      max_tokens: 128,
      stop: ["```"],
      temperature: 0.2,
      top_p: 0.9,
      stream: false
    });
  });

  it.each([
    ["model", { prompt: "x", model: "deepseek-v4-flash" }, "only model"],
    ["maxTokens low", { prompt: "x", maxTokens: 0 }, "between 1 and 4096"],
    ["maxTokens high", { prompt: "x", maxTokens: 4097 }, "between 1 and 4096"],
    ["maxTokens fractional", { prompt: "x", maxTokens: 1.5 }, "between 1 and 4096"],
    ["logprobs low", { prompt: "x", logprobs: -1 }, "between 0 and 20"],
    ["logprobs high", { prompt: "x", logprobs: 21 }, "between 0 and 20"],
    ["temperature", { prompt: "x", temperature: 2.1 }, "between 0 and 2"],
    ["topP", { prompt: "x", topP: -0.1 }, "between 0 and 1"],
    ["stop type", { prompt: "x", stop: ["ok", 1] }, "string or an array"],
    ["stop count", { prompt: "x", stop: Array.from({ length: 17 }, (_, index) => `${index}`) }, "at most 16"]
  ])("validates FIM %s before making a request", async (_name, input, message) => {
    const clients = createDeepSeekClients({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(clients.fim.generate(input as any)).rejects.toThrow(String(message));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries retryable FIM HTTP responses", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({ choices: [{ index: 0, text: "done", finish_reason: "stop" }] })
      );
    const clients = createDeepSeekClients({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      clients.fim.generate({ prompt: "complete", maxRetries: 1, retryBackoffMs: 0 })
    ).resolves.toMatchObject({ text: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable FIM HTTP responses", async () => {
    fetchMock.mockResolvedValue(new Response("invalid", { status: 422 }));
    const clients = createDeepSeekClients({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      clients.fim.generate({ prompt: "complete", maxRetries: 3, retryBackoffMs: 0 })
    ).rejects.toMatchObject({ status: 422 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams every FIM choice and emits one usage-bearing finish", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        { choices: [{ index: 0, text: "const ", finish_reason: null }], usage: null },
        { choices: [{ index: 0, text: "answer = 42;", finish_reason: "stop" }], usage: null },
        {
          choices: [],
          usage: {
            prompt_tokens: 7,
            prompt_cache_hit_tokens: 5,
            prompt_cache_miss_tokens: 2,
            completion_tokens: 4,
            total_tokens: 11,
            completion_tokens_details: { reasoning_tokens: 0 }
          }
        },
        "[DONE]"
      )
    );
    const clients = createDeepSeekClients({
      apiKey: "test",
      betaBaseURL: "https://api.example/beta",
      fetch: fetchMock as typeof fetch
    });

    const events = [];
    for await (const event of await clients.fim.stream({ prompt: "const " })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", textDelta: "const ", index: 0 },
      { type: "text-delta", textDelta: "answer = 42;", index: 0 },
      {
        type: "finish",
        finishReason: "stop",
        providerFinishReason: "stop",
        usage: {
          inputTokens: 7,
          cachedInputTokens: 5,
          outputTokens: 4,
          reasoningTokens: 0,
          totalTokens: 11
        }
      }
    ]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example/beta/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "deepseek-v4-pro",
      prompt: "const ",
      stream: true,
      stream_options: { include_usage: true }
    });
  });

  it("retries a streaming 503 before exposing the iterable", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(
        sseResponse({ choices: [{ index: 0, text: "ok", finish_reason: "stop" }] }, "[DONE]")
      );
    const clients = createDeepSeekClients({ apiKey: "test", fetch: fetchMock as typeof fetch });

    const events = [];
    for await (const event of await clients.fim.stream({ prompt: "x", maxRetries: 1, retryBackoffMs: 0 })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", textDelta: "ok", index: 0 },
      { type: "finish", finishReason: "stop", providerFinishReason: "stop", usage: undefined }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lists models from the stable endpoint with retry and normalized fields", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("timeout", { status: 408 }))
      .mockResolvedValueOnce(
        Response.json({
          object: "list",
          data: [
            { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
            { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" }
          ]
        })
      );
    const clients = createDeepSeekClients({
      apiKey: "secret",
      baseURL: "https://api.example/v1/",
      betaBaseURL: "https://unused.example/beta",
      fetch: fetchMock as typeof fetch
    });

    const result = await clients.models.list({ maxRetries: 1, retryBackoffMs: 0 });

    expect(result.models).toEqual([
      { id: "deepseek-v4-flash", object: "model", ownedBy: "deepseek" },
      { id: "deepseek-v4-pro", object: "model", ownedBy: "deepseek" }
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.example/v1/models");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer secret"
    });
  });

  it("gets and normalizes the account balance", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "110.00",
            granted_balance: "10.00",
            topped_up_balance: "100.00"
          }
        ]
      })
    );
    const clients = createDeepSeekClients({
      apiKey: "secret",
      baseURL: "https://api.example/",
      fetch: fetchMock as typeof fetch
    });

    await expect(clients.balance.get()).resolves.toMatchObject({
      isAvailable: true,
      balances: [
        {
          currency: "USD",
          totalBalance: "110.00",
          grantedBalance: "10.00",
          toppedUpBalance: "100.00"
        }
      ]
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example/user/balance");
  });

  it("does not duplicate the beta segment when baseURL already targets beta", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ index: 0, text: "ok", finish_reason: "stop" }] })
    );
    const clients = createDeepSeekClients({
      apiKey: "test",
      baseURL: "https://api.deepseek.com/beta/",
      fetch: fetchMock as typeof fetch
    });

    await clients.fim.generate({ prompt: "complete" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/beta/completions");
  });

  it("does not retry a non-retryable models error", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const clients = createDeepSeekClients({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(clients.models.list({ maxRetries: 2, retryBackoffMs: 0 })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cleans up completed request timeouts", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url: string | URL | Request, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return Promise.resolve(Response.json({ object: "list", data: [] }));
    });
    const clients = createDeepSeekClients({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await clients.models.list({ timeoutMs: 50 });
    vi.advanceTimersByTime(100);

    expect(requestSignal?.aborted).toBe(false);
  });
});
