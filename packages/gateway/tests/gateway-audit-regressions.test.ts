import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool, ProviderHTTPError, type LanguageModel, type ModelCapabilities, type ModelGenerateInput, type ProviderAdapter, type StreamEvent } from "@zhivex-ai/core";
import { createGateway } from "../src/index.js";

const capabilities: ModelCapabilities = {
  streaming: true, tools: false, structuredOutput: false, jsonMode: true,
  toolChoice: false, parallelToolCalls: false, vision: false, files: false,
  audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false
};
const success = () => ({ text: '{"ok":true}', finishReason: "stop" as const, messages: [] });
const adapter = (overrides: Partial<LanguageModel> = {}): ProviderAdapter => ({
  name: "audit",
  languageModel: (modelId) => ({ provider: "openai", modelId, capabilities, generate: async () => success(), ...overrides })
});
const request = {
  messages: [{ role: "user" as const, content: "hello" }],
  primary: { provider: "openai" as const, modelId: "primary" },
  fallbacks: [{ provider: "qwen" as const, modelId: "fallback" }]
};
const schema = z.object({ ok: z.boolean() });
afterEach(() => vi.useRealTimers());

it.each([false, true])("auto resolves object mode per destination, streaming=%s", async (streaming) => {
  for (const primaryNative of [false, true]) {
    const received: ModelGenerateInput[] = [];
    const fallbackNative = !primaryNative;
    const gateway = createGateway({ maxRetries: 0, scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0, adapters: {
      openai: adapter({ capabilities: { ...capabilities, structuredOutput: primaryNative },
        generate: async () => { throw new Error("unavailable"); }, stream: async () => { throw new Error("unavailable"); } }),
      qwen: adapter({ capabilities: { ...capabilities, structuredOutput: fallbackNative, jsonMode: !fallbackNative },
        generate: async (input) => { received.push(input); return success(); },
        stream: async (input) => { received.push(input); return (async function* () { yield { type: "text-delta" as const, textDelta: success().text }; yield { type: "finish" as const, finishReason: "stop" as const }; })(); }
      })
    } });
    const req = { ...request, schema, mode: "auto" as const, schemaName: "Answer", schemaDescription: "An answer" };
    const result = streaming ? await gateway.streamObject(req).collect() : await gateway.generateObject(req);
    expect(result.object).toEqual({ ok: true });
    expect(result.objectMode).toBe(fallbackNative ? "native" : "prompted");
    expect(received).toHaveLength(1);
    if (fallbackNative) expect(received[0]?.structuredOutput).toMatchObject({ mode: "native", name: "Answer" });
    else {
      expect(received[0]?.structuredOutput).toBeUndefined();
      expect(JSON.stringify(received[0]?.messages)).toContain("JSON Schema");
      expect(JSON.stringify(received[0]?.messages)).toContain("An answer");
    }
    expect(request.messages).toEqual([{ role: "user", content: "hello" }]);
  }
});

it("keeps explicit native mode strict", async () => {
  const generate = vi.fn(async () => success());
  const gateway = createGateway({ maxRetries: 0, adapters: { openai: adapter({ generate }) } });
  await expect(gateway.generateObject({ ...request, fallbacks: [], schema, mode: "native" })).rejects.toThrow("native structured output");
  expect(generate).not.toHaveBeenCalled();
});

it("sanitizes model construction diagnostics in results and observers", async () => {
  const onAttempt = vi.fn();
  const gateway = createGateway({ maxRetries: 0, onAttempt, adapters: {
    openai: { name: "broken", languageModel() { throw new Error("https://example.invalid/?api_key=FAKE_CANARY Bearer FAKE_BEARER"); } }, qwen: adapter()
  } });
  const result = await gateway.generate(request);
  expect(JSON.stringify(result.attempts)).not.toContain("FAKE_");
  expect(JSON.stringify(onAttempt.mock.calls)).not.toContain("FAKE_");
  expect(result.attempts[0]?.errorMessage).toContain("[REDACTED]");
});

it("rejects an idle stream even when its iterator ignores cancellation", async () => {
  let signal: AbortSignal | undefined;
  const onAttempt = vi.fn();
  const gateway = createGateway({ streamIdleTimeoutMs: 10, maxRetries: 0, onAttempt, adapters: { openai: adapter({
    stream: async (input) => { signal = input.abortSignal; return (async function* () { yield { type: "text-delta" as const, textDelta: "partial" }; await new Promise(() => undefined); })(); }
  }) } });
  const result = gateway.streamText({ ...request, fallbacks: [] });
  await expect(result.collect()).rejects.toThrow(/idle/);
  expect(signal?.aborted).toBe(true);
  expect(onAttempt.mock.calls.map(([attempt]) => attempt.reasonCode)).toEqual(["provider-error"]);
});

it.each([false, true])("records terminal failure without fallback after output, errorEvent=%s", async (errorEvent) => {
  const onAttempt = vi.fn();
  const fallback = vi.fn(async () => success());
  const gateway = createGateway({ maxRetries: 2, onAttempt, adapters: {
    openai: adapter({ stream: async () => (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "partial" };
      if (errorEvent) yield { type: "error", error: new Error("stream failed") };
      else throw new Error("stream failed");
    })() }), qwen: adapter({ generate: fallback, stream: vi.fn(async () => { throw new Error("fallback must not run"); }) })
  } });
  await expect(gateway.streamText(request).collect()).rejects.toThrow("stream failed");
  expect(onAttempt.mock.calls.map(([attempt]) => attempt.reasonCode)).toEqual(["provider-error"]);
  expect(fallback).not.toHaveBeenCalled();
});

it("cleanup errors cannot mask stream failures", async () => {
  let calls = 0;
  const gateway = createGateway({ maxRetries: 0, adapters: { openai: adapter({ stream: async () => ({
    [Symbol.asyncIterator]() { return {
      async next(): Promise<IteratorResult<StreamEvent>> { if (calls++ === 0) return { done: false, value: { type: "text-delta", textDelta: "partial" } }; throw new Error("original failure"); },
      return() { throw new Error("cleanup failure"); }
    }; }
  }) }) } });
  await expect(gateway.streamText({ ...request, fallbacks: [] }).collect()).rejects.toThrow("original failure");
});

it.each([false, true])("honors bounded Retry-After and caller cancellation, streaming=%s", async (streaming) => {
  vi.useFakeTimers();
  const call = vi.fn(async () => { throw new ProviderHTTPError("rate limited", 429, { retryAfterMs: 120_000 }); });
  const controller = new AbortController();
  const gateway = createGateway({ retryBackoffMs: 0, maxRetries: 2, adapters: { openai: adapter({ generate: call, stream: call }) } });
  const req = { ...request, fallbacks: [], abortSignal: controller.signal };
  const pending = streaming ? gateway.streamText(req).collect() : gateway.generate(req);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(59_999);
  expect(call).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(call).toHaveBeenCalledTimes(2);
  // Cancellation must interrupt the next server-directed wait.
  controller.abort(new Error("cancelled"));
  await rejected;
});

it("auto fallback preserves completed tool effects in one generation loop", async () => {
  let calls = 0;
  const execute = vi.fn(() => ({ written: true }));
  const fallback = vi.fn(async (input: ModelGenerateInput) => {
    expect(input.messages.some(message => message.role === "tool")).toBe(true);
    expect(input.structuredOutput).toBeUndefined();
    return success();
  });
  const gateway = createGateway({ maxRetries: 0, adapters: {
    openai: adapter({ capabilities: { ...capabilities, tools: true, structuredOutput: true }, generate: async () => {
      if (calls++ === 0) return { finishReason: "tool-calls", messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "write-1", name: "write", input: {} } }] }] };
      throw new ProviderHTTPError("unavailable", 503);
    } }),
    qwen: adapter({ capabilities: { ...capabilities, tools: true }, generate: fallback })
  } });
  const result = await gateway.generateObject({ ...request, schema, mode: "auto", maxSteps: 2,
    tools: { write: tool({ name: "write", schema: z.object({}), execute }) }
  });
  expect(result.object).toEqual({ ok: true });
  expect(result.objectMode).toBe("prompted");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(fallback).toHaveBeenCalledTimes(1);
});

it("records stream success only after completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const onAttempt = vi.fn();
  const gateway = createGateway({ onAttempt, adapters: { openai: adapter({ stream: async () => (async function* () {
    yield { type: "text-delta" as const, textDelta: "partial" };
    await gate;
    yield { type: "finish" as const, finishReason: "stop" as const };
  })() }) } });
  const stream = gateway.streamText({ ...request, fallbacks: [] });
  for await (const event of stream.eventStream) {
    if (event.type === "text-delta") {
      expect(onAttempt).not.toHaveBeenCalled();
      release();
    }
  }
  const result = await stream.collect();
  expect(result.attempts.map(attempt => attempt.reasonCode)).toEqual(["provider-success"]);
});

it("cancellation rejects an uncooperative active stream and sanitizes its diagnostic", async () => {
  const controller = new AbortController();
  const onAttempt = vi.fn();
  const gateway = createGateway({ onAttempt, adapters: { openai: adapter({ stream: async () => (async function* () {
    yield { type: "text-delta" as const, textDelta: "partial" };
    await new Promise(() => undefined);
  })() }) } });
  const stream = gateway.streamText({ ...request, fallbacks: [], abortSignal: controller.signal });
  const failure = new Error("cancelled Bearer FAKE_CANCEL_TOKEN");
  const pending = stream.collect().catch(error => error);
  for await (const event of stream.eventStream) {
    if (event.type === "text-delta") controller.abort(failure);
  }
  expect(await pending).toBe(failure);
  expect(onAttempt.mock.calls.map(([attempt]) => attempt.reasonCode)).toEqual(["request-aborted"]);
  expect(JSON.stringify(onAttempt.mock.calls)).not.toContain("FAKE_CANCEL_TOKEN");
});
