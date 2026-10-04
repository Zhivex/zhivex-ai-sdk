import { describe, expect, it, vi } from "vitest";
import { ProviderToolCallError, type StreamEvent } from "@zhivex-ai/core";
import { createMockLanguageModel } from "../../core/src/testing.js";
import { createGateway } from "../src/index.js";

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
});
