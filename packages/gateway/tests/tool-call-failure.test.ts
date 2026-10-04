import { describe, expect, it, vi } from "vitest";
import { createModelCatalog, ProviderToolCallError, type StreamEvent } from "@zhivex-ai/core";
import { createMockLanguageModel } from "../../core/src/testing.js";
import { createGateway, GatewayError, type GatewayAttempt } from "../src/index.js";

const usage = { inputTokens: 10, outputTokens: 3, totalTokens: 13 };
const request = {
  primary: { provider: "openai" as const, modelId: "test" },
  fallbacks: [{ provider: "anthropic" as const, modelId: "test" }],
  messages: [{ role: "user" as const, content: "hello" }]
};
const fixture = (error: ProviderToolCallError, mode: "generate" | "stream-open" | "stream-first") => {
  const model = createMockLanguageModel();
  model.generate = vi.fn(async () => { throw error; });
  model.stream = vi.fn(async () => {
    if (mode === "stream-open") throw error;
    return (async function* (): AsyncGenerator<StreamEvent> { throw error; })();
  });
  const fallback = createMockLanguageModel({ responses: [{ text: "safe", messages: [], usage }], streamEvents: [[{ type: "text-delta", textDelta: "safe" }, { type: "finish", finishReason: "stop", usage }]] });
  const fallbackGenerate = vi.spyOn(fallback, "generate");
  const fallbackStream = vi.spyOn(fallback, "stream");
  const attempts: unknown[] = [];
  const gateway = createGateway({ maxRetries: 2, retryBackoffMs: 0, adapters: {
    openai: { name: "openai", languageModel: () => model },
    anthropic: { name: "anthropic", languageModel: () => fallback }
  }, onAttempt: attempt => { attempts.push(attempt); } });
  const run = () => mode === "generate" ? gateway.generate(request) : gateway.streamText(request).collect();
  return { model, fallbackGenerate, fallbackStream, attempts, run };
};

describe("typed provider tool-call failures", () => {
  it.each(["generate", "stream-open", "stream-first"] as const)("preserves unsafe %s failure and forbids replay", async mode => {
    const error = new ProviderToolCallError({ provider: "openai", transport: "responses", diagnosticCode: "unsafe-tool-call", reason: "invalid_json", effectsPossible: true, retryable: true, usage });
    const f = fixture(error, mode);
    await expect(f.run()).rejects.toBe(error);
    expect(mode === "generate" ? f.model.generate : f.model.stream).toHaveBeenCalledTimes(1);
    expect(f.fallbackGenerate).not.toHaveBeenCalled();
    expect(f.fallbackStream).not.toHaveBeenCalled();
    expect(f.attempts).toHaveLength(1);
    expect(f.attempts[0]).toMatchObject({ ok: false, usage });
  });
  it.each(["generate", "stream-open", "stream-first"] as const)("allows explicitly safe %s retry and fallback", async mode => {
    const error = new ProviderToolCallError({ provider: "openai", diagnosticCode: "invalid-tool-call", reason: "invalid_json", retryable: true, effectsPossible: false, usage });
    const f = fixture(error, mode);
    await expect(f.run()).resolves.toMatchObject({ text: "safe" });
    expect(mode === "generate" ? f.model.generate : f.model.stream).toHaveBeenCalledTimes(3);
    expect(f.attempts.slice(0, 3)).toEqual(expect.arrayContaining([expect.objectContaining({ usage })]));
  });
  it("does not retry an explicitly nonretryable failure with no effects", async () => {
    const error = new ProviderToolCallError({ provider: "openai", diagnosticCode: "invalid-tool-call", reason: "invalid_json", usage });
    const f = fixture(error, "generate");
    await expect(f.run()).rejects.toBe(error);
    expect(f.model.generate).toHaveBeenCalledTimes(1);
    expect(f.fallbackGenerate).not.toHaveBeenCalled();
  });

  it.each(["generate", "stream-open", "stream-first"] as const)("retains the final typed %s error when safe fallbacks are exhausted", async mode => {
    const primaryError = new ProviderToolCallError({ provider: "openai", diagnosticCode: "primary-invalid-tool", reason: "invalid_json", retryable: true, usage });
    const finalError = new ProviderToolCallError({ provider: "anthropic", transport: "messages", diagnosticCode: "fallback-invalid-tool", reason: "invalid_json", retryable: true, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 }, cause: new Error("offline validation failure") });
    const f = fixture(primaryError, mode);
    f.fallbackGenerate.mockRejectedValue(finalError);
    f.fallbackStream.mockImplementation(async () => {
      if (mode === "stream-open") throw finalError;
      return (async function* (): AsyncGenerator<StreamEvent> { throw finalError; })();
    });
    await expect(f.run()).rejects.toBe(finalError);
    expect(mode === "generate" ? f.model.generate : f.model.stream).toHaveBeenCalledTimes(3);
    expect(mode === "generate" ? f.fallbackGenerate : f.fallbackStream).toHaveBeenCalledTimes(3);
    expect(f.attempts).toHaveLength(6);
    expect(f.attempts.at(-1)).toMatchObject({ ok: false, usage: finalError.usage });
  });

  it("does not substitute an earlier typed error for a later generic provider failure", async () => {
    const error = new ProviderToolCallError({ provider: "openai", diagnosticCode: "primary-invalid-tool", reason: "invalid_json", retryable: true, usage });
    const f = fixture(error, "generate");
    f.fallbackGenerate.mockRejectedValue(new Error("Final fallback failed."));
    await expect(f.run()).rejects.toBeInstanceOf(GatewayError);
    expect(f.fallbackGenerate).toHaveBeenCalledTimes(1);
  });

  for (const accounting of [false, true]) {
    for (const priorFinish of [false, true]) {
      it.each(["throw", "error-event"] as const)(`records confirmed usage after stream output (${accounting ? "cost accounting" : "no cost accounting"}, ${priorFinish ? "earlier finish usage" : "no earlier usage"}, %s)`, async mode => {
        const confirmed = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          ...(priorFinish ? {} : { totalTokens: usage.totalTokens }), cachedInputTokens: 0, cacheWriteTokens: 0 };
        const error = new ProviderToolCallError({ provider: "openai", diagnosticCode: "terminal-invalid-tool", reason: "invalid_json", retryable: true, usage: confirmed });
        const model = createMockLanguageModel();
        model.stream = vi.fn(async () => (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text-delta", textDelta: "partial" };
          if (priorFinish) yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, reasoningTokens: 1 } };
          if (mode === "error-event") yield { type: "error", error };
          else throw error;
        })());
        const fallback = createMockLanguageModel();
        const fallbackStream = vi.spyOn(fallback, "stream");
        const attempts: GatewayAttempt[] = [];
        const modelCatalog = createModelCatalog([{ provider: "openai", modelId: "test", inputCostPer1kTokens: 1, outputCostPer1kTokens: 2 }], { snapshotVersion: "offline", pricing: { version: "1", unit: "per_1k_tokens", currency: "USD" } });
        const gateway = createGateway({ maxRetries: 2, retryBackoffMs: 0,
          scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0,
          ...(accounting ? { modelCatalog, costAccounting: {} } : {}),
          adapters: { openai: { name: "openai", languageModel: () => model }, anthropic: { name: "anthropic", languageModel: () => fallback } },
          onAttempt: attempt => { attempts.push(attempt); }
        });
        await expect(gateway.streamText(request).collect()).rejects.toBe(error);
        expect(model.stream).toHaveBeenCalledTimes(1);
        expect(fallbackStream).not.toHaveBeenCalled();
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ ok: false, reasonCode: "provider-error" });
        expect(attempts[0]!.usage).toEqual(confirmed);
        if (accounting) {
          expect(attempts[0]!.cost).toMatchObject({ status: "known", currency: "USD" });
          expect(attempts[0]!.cost!.amount).toBeCloseTo(0.016);
        } else expect(attempts[0]!.cost).toBeUndefined();
      });
    }
  }

  it.each([false, true])("uses earlier finish usage only when the typed stream error has no usage (prior finish=%s)", async priorFinish => {
    const error = new ProviderToolCallError({ provider: "openai", diagnosticCode: "terminal-invalid-tool", reason: "invalid_json", retryable: true });
    const model = createMockLanguageModel();
    model.stream = vi.fn(async () => (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "partial" };
      if (priorFinish) yield { type: "finish", finishReason: "stop", usage: { ...usage, cachedInputTokens: 0, cacheWriteTokens: 0 } };
      throw error;
    })());
    const attempts: GatewayAttempt[] = [];
    const gateway = createGateway({ modelCatalog: createModelCatalog([{ provider: "openai", modelId: "test", inputCostPer1kTokens: 1, outputCostPer1kTokens: 2 }], { pricing: { version: "1", unit: "per_1k_tokens", currency: "USD" } }), costAccounting: {},
      adapters: { openai: { name: "openai", languageModel: () => model } },
      onAttempt: attempt => { attempts.push(attempt); }
    });
    await expect(gateway.streamText({ ...request, fallbacks: [] }).collect()).rejects.toBe(error);
    expect(model.stream).toHaveBeenCalledTimes(1);
    if (priorFinish) {
      expect(attempts[0]!.usage).toEqual({ ...usage, cachedInputTokens: 0, cacheWriteTokens: 0 });
      expect(attempts[0]!.cost!.amount).toBeCloseTo(0.016);
    } else {
      expect(attempts[0]!.usage).toBeUndefined();
      expect(attempts[0]!.cost).toMatchObject({ status: "unknown", amount: null });
    }
  });

  for (const accounting of [false, true]) {
    for (const priorFinish of [false, true]) {
      for (const usageComplete of [false, true]) {
        it.each(["throw", "error-event"] as const)(`preserves post-open request receipts (accounting=${accounting}, priorFinish=${priorFinish}, complete=${usageComplete}, %s)`, async mode => {
          const confirmedUsage = { inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedInputTokens: 0, cacheWriteTokens: 0 };
          const earlierUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, reasoningTokens: 1 };
          const error = new ProviderToolCallError({ provider: "openai", transport: "responses", diagnosticCode: "OFFLINE_REQUEST_RECEIPT",
            reason: "response_failed", retryable: true, effectsPossible: true, confirmedUsage, usageComplete, providerRequestCount: 2 });
          const model = createMockLanguageModel();
          model.stream = vi.fn(async () => (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "text-delta", textDelta: "partial" };
            if (priorFinish) yield { type: "finish", finishReason: "stop", usage: earlierUsage };
            if (mode === "error-event") yield { type: "error", error };
            else throw error;
          })());
          const fallback = createMockLanguageModel();
          const fallbackStream = vi.spyOn(fallback, "stream");
          const attempts: GatewayAttempt[] = [];
          const modelCatalog = createModelCatalog([{ provider: "openai", modelId: "test", inputCostPer1kTokens: 1, outputCostPer1kTokens: 2 }],
            { pricing: { version: "1", unit: "per_1k_tokens", currency: "USD" } });
          const gateway = createGateway({ maxRetries: 2, retryBackoffMs: 0,
            scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0,
            ...(accounting ? { modelCatalog, costAccounting: {} } : {}),
            adapters: { openai: { name: "openai", languageModel: () => model }, anthropic: { name: "anthropic", languageModel: () => fallback } },
            onAttempt: attempt => { attempts.push(attempt); }
          });
          await expect(gateway.streamText(request).collect()).rejects.toBe(error);
          expect(model.stream).toHaveBeenCalledTimes(1);
          expect(fallbackStream).not.toHaveBeenCalled();
          expect(attempts).toHaveLength(1);
          expect(attempts[0]).toMatchObject({ ok: false, reasonCode: "provider-error", confirmedUsage, usageComplete, providerRequestCount: 2 });
          // Complete terminal counters supersede earlier finish usage. An
          // uncertain lower bound is retained separately, never promoted to usage.
          expect(attempts[0]!.usage).toEqual(usageComplete ? confirmedUsage : priorFinish ? earlierUsage : undefined);
        });
      }
    }
  }
});
