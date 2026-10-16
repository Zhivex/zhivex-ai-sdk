import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { ProviderHTTPError, createModelCatalog } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/core/testing";
import { createGateway } from "../src/index.js";
import * as gatewayAgents from "../src/agents.js";

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.trim().length / 4));
const target = { provider: "openai" as const, modelId: "fixture" };
const textResponse = {
  text: "done",
  messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "done" }] }],
  finishReason: "stop" as const
};

const model = (events?: Array<{ type: "text-delta"; textDelta: string } | { type: "finish"; finishReason: "stop" }>) =>
  createMockLanguageModel({
    provider: "openai",
    modelId: "fixture",
    capabilities: { streaming: true, tools: true, structuredOutput: true, jsonMode: true },
    responses: [textResponse],
    streamEvents: [events ?? [
      { type: "text-delta", textDelta: "done" },
      { type: "finish", finishReason: "stop" }
    ]]
  });

const adapter = (languageModel = model()) => ({ name: "fixture", languageModel: () => languageModel });

const withStringifyCount = async (match: (value: unknown) => boolean, run: () => Promise<void>) => {
  const original = JSON.stringify;
  let hits = 0;
  JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown) => {
    if (match(value)) hits += 1;
    return original(value as never, replacer as never, space as never);
  }) as typeof JSON.stringify;
  try {
    await run();
  } finally {
    JSON.stringify = original;
  }
  return hits;
};

describe("gateway efficiency", () => {
  it("aborts an idle stream with the same error shape", async () => {
    const hanging = createMockLanguageModel({ capabilities: { streaming: true } });
    hanging.stream = async () => (async function* () {
      yield { type: "text-delta" as const, textDelta: "partial" };
      await new Promise(() => undefined);
    })();
    const idleGateway = createGateway({
      maxRetries: 0,
      streamIdleTimeoutMs: 15,
      adapters: { openai: adapter(hanging) }
    });
    await expect(idleGateway.streamText({
      primary: target,
      messages: [{ role: "user", content: "hello" }]
    }).collect()).rejects.toMatchObject({
      name: "GatewayError",
      retryable: false,
      message: "Provider stream was idle for more than 15ms."
    });
  });

  it("does not allocate a timer per stream chunk", async () => {
    const countTimers = async (chunks: number) => {
      const events = [
        ...Array.from({ length: chunks }, (_, index) => ({ type: "text-delta" as const, textDelta: String(index) })),
        { type: "finish" as const, finishReason: "stop" as const }
      ];
      const spy = vi.spyOn(globalThis, "setTimeout");
      try {
        const gateway = createGateway({
          maxRetries: 0,
          streamIdleTimeoutMs: 60_000,
          adapters: { openai: adapter(model(events)) }
        });
        const result = await gateway.streamText({
          primary: target,
          messages: [{ role: "user", content: "hello" }]
        }).collect();
        expect(result.text).toContain("0");
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };

    const few = await countTimers(4);
    const many = await countTimers(40);
    expect(few).toBe(many);
    expect(many).toBeLessThan(8);
  });

  it("does not treat time between consumer reads as provider idle time", async () => {
    const gateway = createGateway({
      maxRetries: 0,
      streamIdleTimeoutMs: 20,
      adapters: {
        openai: adapter(model([
          { type: "text-delta", textDelta: "aa" },
          { type: "text-delta", textDelta: "bb" },
          { type: "text-delta", textDelta: "cc" },
          { type: "finish", finishReason: "stop" }
        ]))
      }
    });
    const stream = gateway.streamText({
      primary: target,
      messages: [{ role: "user", content: "hello" }]
    });
    let text = "";
    for await (const event of stream.eventStream) {
      if (event.type === "text-delta") {
        text += event.textDelta;
        await new Promise((resolve) => setTimeout(resolve, 45));
      }
    }
    expect(text).toBe("aabbcc");
    await expect(stream.collect()).resolves.toMatchObject({ text: "aabbcc" });
  });

  it("stringifies gateway messages once and keeps token estimates", async () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, parts: [{ type: "text" as const, text: "hi" }] }
    ];
    const systemPrompt = "sys";
    const inputText = `${systemPrompt}\nhello\n${JSON.stringify(messages[1]!.parts)}`.trim();
    const messagesJson = JSON.stringify(messages);
    const costInputTokens = estimateTokens([systemPrompt, messagesJson].filter(Boolean).join("\n"));
    const catalog = createModelCatalog(
      ["openai", "anthropic", "gemini"].map((provider) => ({
        provider, modelId: "fixture", inputCostPer1kTokens: 1, outputCostPer1kTokens: 2
      })),
      { snapshotVersion: "test", pricing: { version: "1", unit: "per_1k_tokens", currency: "USD" } }
    );
    const hits = await withStringifyCount((value) => value === messages, async () => {
      const gateway = createGateway({
        maxRetries: 0,
        modelCatalog: catalog,
        costAccounting: { expectedOutputTokens: 4 },
        adapters: {
          openai: adapter(model()),
          anthropic: adapter(model()),
          gemini: adapter(model())
        }
      });
      const result = await gateway.generate({
        primary: target,
        fallbacks: [
          { provider: "anthropic", modelId: "fixture" },
          { provider: "gemini", modelId: "fixture" }
        ],
        systemPrompt,
        messages
      });
      expect(result.usage).toMatchObject({
        inputTokens: estimateTokens(inputText),
        outputTokens: estimateTokens("done"),
        estimated: true
      });
      const inputComponents = result.routeDecision.estimatedCosts?.map((cost) => cost.components.input?.tokens);
      expect(inputComponents).toEqual([costInputTokens, costInputTokens, costInputTokens]);
    });
    expect(hits).toBe(1);
  });

  it("stringifies model messages once across retries and preserves admission tokens", async () => {
    let calls = 0;
    let seenMessages: unknown;
    const fixture = model();
    fixture.generate = async (input) => {
      calls += 1;
      seenMessages = input.messages;
      if (calls < 3) throw new ProviderHTTPError("unavailable", 503);
      return textResponse;
    };
    const reserved: Array<number | undefined> = [];
    const partsArrays: unknown[] = [];
    const hits = await withStringifyCount((value) => {
      if (Array.isArray(value) && value[0] && typeof value[0] === "object" && value[0] !== null && "parts" in value[0]) {
        partsArrays.push(value);
        return true;
      }
      return false;
    }, async () => {
      const gateway = createGateway({
        maxRetries: 2,
        retryBackoffMs: 0,
        retryRandom: () => 0,
        admission: {
          acquire: async ({ tokens }) => {
            reserved.push(tokens);
            return { release() {} };
          }
        },
        adapters: { openai: adapter(fixture) }
      });
      const result = await gateway.generate({
        primary: target,
        maxTokens: 8,
        messages: [{ role: "user", content: "hello" }]
      });
      expect(result.text).toBe("done");
    });
    expect(calls).toBe(3);
    expect(partsArrays.filter((value) => value === seenMessages)).toHaveLength(1);
    expect(hits).toBe(partsArrays.length);
    const expected = Math.ceil(JSON.stringify(seenMessages).length / 4) + 8;
    expect(reserved).toEqual([expected, expected, expected]);
  });

  it("loads the agent runtime from the agents entry on first agent use", async () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, { import: string }>;
    };
    expect(source).not.toMatch(/from\s+["']@zhivex-ai\/core\/agents["']/);
    expect(source).toMatch(/import\(\s*["']\.\/agents\.js["']\s*\)/);
    expect(manifest.exports["./agents"]?.import).toBe("./dist/agents.js");
    expect(readFileSync(new URL("../src/agents.ts", import.meta.url), "utf8")).toContain("@zhivex-ai/core/agents");

    const spy = vi.spyOn(gatewayAgents, "createAgent");
    spy.mockClear();
    const fixture = model();
    fixture.generate = async () => textResponse;
    fixture.stream = async () => (async function* () {
      yield { type: "text-delta" as const, textDelta: "done" };
      yield { type: "finish" as const, finishReason: "stop" };
    })();
    const gateway = createGateway({
      maxRetries: 0,
      adapters: { openai: adapter(fixture) }
    });
    await gateway.generate({
      primary: target,
      messages: [{ role: "user", content: "hello" }]
    });
    expect(spy).not.toHaveBeenCalled();
    const agent = await gateway.runAgent({
      primary: target,
      prompt: "hello"
    });
    expect(agent.outputText.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const streamed = await gateway.streamAgent({
      primary: target,
      prompt: "hello"
    }).collect();
    expect(streamed.outputText.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("surfaces a failed agent stream setup without unhandled rejections", async () => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => {
      rejections.push(error);
    };
    process.on("unhandledRejection", onRejection);
    const setupError = new RangeError("maxHistory must be a positive integer.");
    const spy = vi.spyOn(gatewayAgents, "streamAgent").mockImplementation(() => {
      throw setupError;
    });
    const gateway = createGateway({
      maxRetries: 0,
      adapters: { openai: adapter(model()) }
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const collected = gateway.streamAgent({ primary: target, prompt: "hello" });
      const eventIterator = collected.eventStream[Symbol.asyncIterator]();
      const textIterator = collected.textStream[Symbol.asyncIterator]();
      await expect(collected.collect()).rejects.toBe(setupError);
      await settle();
      expect(rejections).toEqual([]);

      await expect(eventIterator.next()).rejects.toBe(setupError);
      await expect(textIterator.next()).rejects.toBe(setupError);
      await expect(eventIterator.return?.()).rejects.toBe(setupError);
      await settle();
      expect(rejections).toEqual([]);

      const streamed = gateway.streamAgent({ primary: target, prompt: "hello" });
      await expect(streamed.eventStream[Symbol.asyncIterator]().next()).rejects.toBe(setupError);
      await expect(streamed.textStream[Symbol.asyncIterator]().next()).rejects.toBe(setupError);
      await settle();
      expect(rejections).toEqual([]);
    } finally {
      spy.mockRestore();
      process.off("unhandledRejection", onRejection);
    }
  });

  it("keeps jittered backoff inside the exponential ceiling and Retry-After cap", async () => {
    vi.useFakeTimers();
    try {
      const fail = () => {
        throw new ProviderHTTPError("unavailable", 503);
      };
      const upper = vi.fn(fail);
      const upperModel = model();
      upperModel.generate = upper;
      const bounded = createGateway({
        maxRetries: 3,
        retryBackoffMs: 200,
        retryRandom: () => 1,
        adapters: { openai: adapter(upperModel) }
      });
      const pending = bounded.generate({
        primary: target,
        messages: [{ role: "user", content: "hello" }]
      });
      const rejected = expect(pending).rejects.toThrow(/unavailable|attempts failed/i);
      await vi.advanceTimersByTimeAsync(199);
      expect(upper).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(upper).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(399);
      expect(upper).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(upper).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(799);
      expect(upper).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(upper).toHaveBeenCalledTimes(4);
      await rejected;

      const lowerModel = model();
      const lower = vi.fn(fail);
      lowerModel.generate = lower;
      const lowerGateway = createGateway({
        maxRetries: 1,
        retryBackoffMs: 5_000,
        retryRandom: () => 0,
        adapters: { openai: adapter(lowerModel) }
      });
      const lowerPending = lowerGateway.generate({
        primary: target,
        messages: [{ role: "user", content: "hello" }]
      });
      const lowerRejected = expect(lowerPending).rejects.toThrow(/unavailable|attempts failed/i);
      await vi.advanceTimersByTimeAsync(0);
      expect(lower).toHaveBeenCalledTimes(2);
      await lowerRejected;

      const hinted = vi.fn(async () => {
        throw new ProviderHTTPError("rate limited", 429, { retryAfterMs: 5_000 });
      });
      const hintedModel = model();
      hintedModel.generate = hinted;
      const hintedGateway = createGateway({
        maxRetries: 1,
        retryBackoffMs: 200,
        retryRandom: () => 0,
        adapters: { openai: adapter(hintedModel) }
      });
      const hintedPending = hintedGateway.generate({
        primary: target,
        messages: [{ role: "user", content: "hello" }]
      });
      const hintedRejected = expect(hintedPending).rejects.toThrow(/rate limited|attempts failed/i);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(hinted).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(hinted).toHaveBeenCalledTimes(2);
      await hintedRejected;

      const capped = vi.fn(async () => {
        throw new ProviderHTTPError("rate limited", 429, { retryAfterMs: 120_000 });
      });
      const cappedModel = model();
      cappedModel.generate = capped;
      const cappedGateway = createGateway({
        maxRetries: 1,
        retryBackoffMs: 30_000,
        retryRandom: () => 1,
        adapters: { openai: adapter(cappedModel) }
      });
      const cappedPending = cappedGateway.generate({
        primary: target,
        messages: [{ role: "user", content: "hello" }]
      });
      const cappedRejected = expect(cappedPending).rejects.toThrow(/rate limited|attempts failed/i);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(capped).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(capped).toHaveBeenCalledTimes(2);
      await cappedRejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
