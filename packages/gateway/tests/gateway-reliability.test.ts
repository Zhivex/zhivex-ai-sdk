import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ProviderHTTPError,
  createInMemoryAgentRunStore,
  tool,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ProviderAdapter
} from "@zhivex-ai/core";
import { createGateway } from "../src/index.ts";

const capabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false,
  ...overrides
});

const agentCapabilities = (): ModelCapabilities =>
  capabilities({
    streaming: true,
    tools: true,
    structuredOutput: true,
    jsonMode: true,
    toolChoice: true,
    reasoning: true,
    webSearch: true,
    agentCapabilities: {
      supportTier: "tier-b",
      toolChoiceNone: true,
      approvalRequests: false,
      hostedWebSearch: true,
      hostedFileSearch: false,
      remoteMcp: false,
      computerUse: false,
      codeExecution: false,
      toolsets: true
    }
  });

const createAdapter = (
  generateImpl: (input: ModelGenerateInput) => Promise<{ text: string }>,
  modelCapabilities: ModelCapabilities = capabilities()
): ProviderAdapter => ({
  name: "reliability-test",
  languageModel(modelId) {
    return {
      provider: "reliability-test",
      modelId,
      capabilities: modelCapabilities,
      async generate(input) {
        const result = await generateImpl(input);
        return {
          messages: [{ role: "assistant", parts: [{ type: "text", text: result.text }] }],
          text: result.text,
          finishReason: "stop"
        };
      }
    };
  }
});

const createStreamingAdapter = (
  streamImpl: (input: ModelGenerateInput) => Promise<AsyncIterable<
    | { type: "text-delta"; textDelta: string }
    | { type: "finish"; finishReason: "stop" }
  >>
): ProviderAdapter => ({
  name: "reliability-stream-test",
  languageModel(modelId) {
    return {
      provider: "reliability-stream-test",
      modelId,
      capabilities: agentCapabilities(),
      async generate() {
        return {
          messages: [{ role: "assistant", parts: [{ type: "text", text: "unused" }] }],
          text: "unused",
          finishReason: "stop"
        };
      },
      stream: streamImpl
    };
  }
});

const request = {
  messages: [{ role: "user" as const, content: "hello" }]
};

describe("gateway reliability", () => {
  it("aborts the provider operation when an attempt times out", async () => {
    let observedSignal: AbortSignal | undefined;
    let providerCompleted = false;

    const slowGenerate = vi.fn(
      (input: ModelGenerateInput) =>
        new Promise<{ text: string }>((resolve, reject) => {
          observedSignal = input.abortSignal;
          const completionTimer = setTimeout(() => {
            providerCompleted = true;
            resolve({ text: "too late" });
          }, 80);

          input.abortSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(completionTimer);
              reject(input.abortSignal?.reason ?? new DOMException("Aborted", "AbortError"));
            },
            { once: true }
          );
        })
    );

    const gateway = createGateway({
      adapters: {
        openai: createAdapter(slowGenerate)
      },
      attemptTimeoutMs: 10,
      maxRetries: 0
    });

    await expect(
      gateway.generate({
        ...request,
        primary: { provider: "openai", modelId: "slow-model" }
      })
    ).rejects.toThrow(/timed out/i);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(slowGenerate).toHaveBeenCalledTimes(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(providerCompleted).toBe(false);
  });

  it("retries typed retryable ProviderHTTPError responses", async () => {
    const generate = vi
      .fn<(input: ModelGenerateInput) => Promise<{ text: string }>>()
      .mockRejectedValueOnce(new ProviderHTTPError("Bad gateway", 502))
      .mockResolvedValueOnce({ text: "recovered" });

    const gateway = createGateway({
      adapters: {
        openai: createAdapter(generate)
      },
      maxRetries: 1,
      retryBackoffMs: 0
    });

    const result = await gateway.generate({
      ...request,
      primary: { provider: "openai", modelId: "retry-model" }
    });

    expect(result.text).toBe("recovered");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.attempts).toMatchObject([
      { ok: false, retry: 0, reasonCode: "provider-error" },
      { ok: true, retry: 1, reasonCode: "provider-success" }
    ]);
  });

  it("rejects targets with unknown cost by default when a budget is set", async () => {
    const unknownCostGenerate = vi.fn(async () => ({ text: "unknown cost" }));
    const knownCostGenerate = vi.fn(async () => ({ text: "known cost" }));
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(unknownCostGenerate),
        ollama: createAdapter(knownCostGenerate)
      },
      providerCostsPer1kTokens: {
        ollama: 0
      },
      maxRetries: 0
    });

    const result = await gateway.generate({
      ...request,
      primary: { provider: "openai", modelId: "unknown-cost-model" },
      fallbacks: [{ provider: "ollama", modelId: "known-cost-model" }],
      maxCostPer1kTokens: 0.01
    });

    expect(result.providerUsed).toBe("ollama");
    expect(unknownCostGenerate).not.toHaveBeenCalled();
    expect(knownCostGenerate).toHaveBeenCalledTimes(1);
    expect(result.attempts[0]).toMatchObject({
      provider: "openai",
      ok: false,
      reasonCode: "cost-budget"
    });
  });

  it("allows targets with unknown cost when unknownCostPolicy is allow", async () => {
    const generate = vi.fn(async () => ({ text: "allowed" }));
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(generate)
      },
      unknownCostPolicy: "allow",
      maxRetries: 0
    });

    const result = await gateway.generate({
      ...request,
      primary: { provider: "openai", modelId: "unknown-cost-model" },
      maxCostPer1kTokens: 0.01
    });

    expect(result.text).toBe("allowed");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("supports a custom finite routing score", async () => {
    const primaryGenerate = vi.fn(async () => ({ text: "primary" }));
    const preferredGenerate = vi.fn(async () => ({ text: "preferred" }));
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(primaryGenerate),
        gemini: createAdapter(preferredGenerate)
      },
      scoreTarget({ target }) {
        return target.provider === "gemini" ? 100 : 0;
      }
    });

    const result = await gateway.generate({
      ...request,
      primary: { provider: "openai", modelId: "primary-model" },
      fallbacks: [{ provider: "gemini", modelId: "preferred-model" }]
    });

    expect(result.providerUsed).toBe("gemini");
    expect(preferredGenerate).toHaveBeenCalledTimes(1);
    expect(primaryGenerate).not.toHaveBeenCalled();
  });

  it("skips a target without tool-choice support and uses a compatible fallback", async () => {
    const primaryGenerate = vi.fn(async () => ({ text: "must not run" }));
    const fallbackGenerate = vi.fn(async () => ({ text: "compatible fallback" }));
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(primaryGenerate, capabilities({ tools: true, toolChoice: false })),
        gemini: createAdapter(fallbackGenerate, capabilities({ tools: true, toolChoice: true }))
      },
      maxRetries: 0
    });

    const result = await gateway.generate({
      ...request,
      primary: { provider: "openai", modelId: "tools-without-choice" },
      fallbacks: [{ provider: "gemini", modelId: "tools-with-choice" }],
      tools: {
        noop: tool({
          name: "noop",
          schema: z.object({}),
          execute: () => ({ ok: true })
        })
      },
      toolChoice: "required"
    });

    expect(result.providerUsed).toBe("gemini");
    expect(result.text).toBe("compatible fallback");
    expect(primaryGenerate).not.toHaveBeenCalled();
    expect(fallbackGenerate).toHaveBeenCalledTimes(1);
    expect(result.attempts[0]).toMatchObject({
      provider: "openai",
      ok: false,
      reasonCode: "model-capabilities"
    });
  });

  it("skips a non-vision model and preserves the image for a capable fallback", async () => {
    const textOnlyGenerate = vi.fn(async () => ({ text: "image was lost" }));
    const visionGenerate = vi.fn(async (input: ModelGenerateInput) => {
      expect(input.messages[0]?.parts).toContainEqual({
        type: "image",
        image: "data:image/png;base64,aGVsbG8=",
        mediaType: "image/png"
      });
      return { text: "image received" };
    });
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(textOnlyGenerate, capabilities({ vision: false })),
        gemini: createAdapter(visionGenerate, capabilities({ vision: true }))
      },
      maxRetries: 0
    });

    const result = await gateway.generate({
      primary: { provider: "openai", modelId: "text-only-model" },
      fallbacks: [{ provider: "gemini", modelId: "vision-model" }],
      messages: [
        {
          role: "user",
          content: "describe this image",
          images: [{ dataUrl: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" }]
        }
      ]
    });

    expect(result.providerUsed).toBe("gemini");
    expect(textOnlyGenerate).not.toHaveBeenCalled();
    expect(visionGenerate).toHaveBeenCalledTimes(1);
    expect(result.attempts[0]).toMatchObject({
      provider: "openai",
      ok: false,
      reasonCode: "model-capabilities"
    });
  });

  it("falls back when the primary agent provider fails", async () => {
    const primaryGenerate = vi.fn(async () => {
      throw new Error("primary agent failed");
    });
    const fallbackGenerate = vi.fn(async () => ({ text: "fallback agent" }));
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(primaryGenerate, agentCapabilities()),
        gemini: createAdapter(fallbackGenerate, agentCapabilities())
      },
      maxRetries: 0
    });

    const result = await gateway.runAgent({
      primary: { provider: "openai", modelId: "primary-agent-model" },
      fallbacks: [{ provider: "gemini", modelId: "fallback-agent-model" }],
      prompt: "finish the task"
    });

    expect(result.providerUsed).toBe("gemini");
    expect(result.outputText).toBe("fallback agent");
    expect(primaryGenerate).toHaveBeenCalledTimes(1);
    expect(fallbackGenerate).toHaveBeenCalledTimes(1);
    expect(result.attempts).toMatchObject([
      { provider: "openai", ok: false, reasonCode: "provider-error" },
      { provider: "gemini", ok: true, reasonCode: "provider-success" }
    ]);
  });

  it("keeps one durable agent run and executes a tool once when a later model step falls back", async () => {
    const store = createInMemoryAgentRunStore();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let sideEffects = 0;
    let runStarts = 0;

    const primary: ProviderAdapter = {
      name: "primary-agent",
      languageModel(modelId) {
        return {
          provider: "primary-agent",
          modelId,
          capabilities: agentCapabilities(),
          async generate() {
            primaryCalls += 1;
            if (primaryCalls === 1) {
              return {
                messages: [{
                  role: "assistant",
                  parts: [{
                    type: "tool-call",
                    toolCall: {
                      id: "provider-call-1",
                      name: "write_once",
                      input: { value: "x" }
                    }
                  }]
                }],
                finishReason: "tool-calls" as const
              };
            }
            throw new ProviderHTTPError("Primary failed after the tool step", 400);
          }
        };
      }
    };
    const fallback = createAdapter(async () => {
      fallbackCalls += 1;
      return { text: "completed on fallback" };
    }, agentCapabilities());

    const gateway = createGateway({
      adapters: {
        openai: primary,
        gemini: fallback
      },
      maxRetries: 0
    });

    const result = await gateway.runAgent({
      primary: { provider: "openai", modelId: "primary-agent-model" },
      fallbacks: [{ provider: "gemini", modelId: "fallback-agent-model" }],
      prompt: "perform one durable write",
      runId: "gateway-safe-fallback",
      idempotencyKey: "gateway-safe-fallback-key",
      store,
      maxSteps: 2,
      tools: {
        write_once: tool({
          name: "write_once",
          schema: z.object({ value: z.string() }),
          execute() {
            sideEffects += 1;
            return { written: true };
          }
        })
      },
      onTelemetryEvent(event) {
        if (event.type === "run-start") {
          runStarts += 1;
        }
      }
    });

    expect(result.status).toBe("completed");
    expect(result.outputText).toBe("completed on fallback");
    expect(result.providerUsed).toBe("gemini");
    expect(result.state.runId).toBe("gateway-safe-fallback");
    expect((await store.load("gateway-safe-fallback"))?.runId).toBe(result.state.runId);
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(1);
    expect(sideEffects).toBe(1);
    expect(runStarts).toBe(1);
  });

  it("falls back for an agent stream before the first provider event", async () => {
    const primaryStream = vi.fn(async () => {
      throw new ProviderHTTPError("Primary stream unavailable", 503);
    });
    const fallbackStream = vi.fn(async () =>
      (async function* () {
        yield { type: "text-delta" as const, textDelta: "fallback stream" };
        yield { type: "finish" as const, finishReason: "stop" as const };
      })()
    );
    const gateway = createGateway({
      adapters: {
        openai: createStreamingAdapter(primaryStream),
        gemini: createStreamingAdapter(fallbackStream)
      },
      maxRetries: 0
    });

    const result = gateway.streamAgent({
      primary: { provider: "openai", modelId: "primary-stream-model" },
      fallbacks: [{ provider: "gemini", modelId: "fallback-stream-model" }],
      prompt: "stream with fallback"
    });
    const final = await result.collect();

    expect(final.outputText).toBe("fallback stream");
    expect(final.providerUsed).toBe("gemini");
    expect(primaryStream).toHaveBeenCalledTimes(1);
    expect(fallbackStream).toHaveBeenCalledTimes(1);
  });

  it("does not mix providers after an agent stream emits its first provider event", async () => {
    const primaryStream = vi.fn(async () =>
      (async function* () {
        yield { type: "text-delta" as const, textDelta: "committed" };
        throw new Error("stream failed after first event");
      })()
    );
    const fallbackStream = vi.fn(async () =>
      (async function* () {
        yield { type: "text-delta" as const, textDelta: "must not appear" };
        yield { type: "finish" as const, finishReason: "stop" as const };
      })()
    );
    const gateway = createGateway({
      adapters: {
        openai: createStreamingAdapter(primaryStream),
        gemini: createStreamingAdapter(fallbackStream)
      },
      maxRetries: 0
    });

    const result = gateway.streamAgent({
      primary: { provider: "openai", modelId: "primary-stream-model" },
      fallbacks: [{ provider: "gemini", modelId: "fallback-stream-model" }],
      prompt: "do not mix providers"
    });

    await expect(result.collect()).rejects.toThrow("stream failed after first event");
    expect(primaryStream).toHaveBeenCalledTimes(1);
    expect(fallbackStream).not.toHaveBeenCalled();
  });

  it("does not repeat successful provider work when an attempt observer throws", async () => {
    const generate = vi.fn(async () => ({ text: "success" }));
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(generate)
      },
      onAttempt() {
        throw new Error("observer unavailable");
      }
    });

    const result = await gateway.generate({
      ...request,
      primary: { provider: "openai", modelId: "single-call-model" }
    });

    expect(result.text).toBe("success");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("bounds attempt and route observers and aborts their observer signals", async () => {
    let attemptSignal: AbortSignal | undefined;
    let routeSignal: AbortSignal | undefined;
    let resolveAttemptAborted!: () => void;
    let resolveRouteAborted!: () => void;
    const attemptAborted = new Promise<void>((resolve) => {
      resolveAttemptAborted = resolve;
    });
    const routeAborted = new Promise<void>((resolve) => {
      resolveRouteAborted = resolve;
    });
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(
          async () => ({ text: "success" }),
          agentCapabilities()
        )
      },
      observerTimeoutMs: 50,
      onAttempt(attempt) {
        attemptSignal = attempt.abortSignal;
        attempt.abortSignal.addEventListener("abort", resolveAttemptAborted, {
          once: true
        });
        return new Promise<void>(() => undefined);
      },
      onAgentRoute(selection) {
        routeSignal = selection.abortSignal;
        selection.abortSignal.addEventListener("abort", resolveRouteAborted, {
          once: true
        });
        return new Promise<void>(() => undefined);
      }
    });

    const resultPromise = gateway.runAgent({
      primary: { provider: "openai", modelId: "observer-model" },
      prompt: "finish despite unavailable telemetry"
    });
    const firstCompletion = await Promise.race([
      resultPromise.then(() => "result"),
      attemptAborted.then(() => "observer-timeout")
    ]);
    const result = await resultPromise;

    expect(firstCompletion).toBe("result");
    expect(result.outputText).toBe("success");
    await Promise.all([attemptAborted, routeAborted]);
    expect(attemptSignal?.aborted).toBe(true);
    expect(routeSignal?.aborted).toBe(true);
  });

  it("enforces fallback, retry, total-attempt, target, and cost limits", async () => {
    const generate = vi.fn(async () => {
      throw new ProviderHTTPError("retry later", 503);
    });
    const limitedGateway = createGateway({
      adapters: {
        openai: createAdapter(generate)
      },
      maxRetries: 1,
      maxTotalAttempts: 1,
      retryBackoffMs: 0
    });

    await expect(
      limitedGateway.generate({
        ...request,
        primary: { provider: "openai", modelId: "limited-model" }
      })
    ).rejects.toThrow("maximum of 1 provider attempts");
    expect(generate).toHaveBeenCalledTimes(1);

    const gateway = createGateway({
      adapters: {
        openai: createAdapter(async () => ({ text: "unused" }))
      }
    });
    const tooManyFallbacks = Array.from({ length: 9 }, (_, index) => ({
      provider: "openai" as const,
      modelId: `fallback-${index}`
    }));

    await expect(
      gateway.generate({
        ...request,
        primary: { provider: "openai", modelId: "primary" },
        fallbacks: tooManyFallbacks
      })
    ).rejects.toThrow("configured maximum is 8");
    await expect(
      gateway.generate({
        ...request,
        primary: { provider: "openai", modelId: "bad\nmodel" }
      })
    ).rejects.toThrow("without control characters");
    await expect(
      gateway.generate({
        ...request,
        primary: { provider: "openai", modelId: "primary" },
        maxCostPer1kTokens: Number.POSITIVE_INFINITY
      })
    ).rejects.toThrow("finite non-negative");

    const invalidRetryGateway = createGateway({
      adapters: {
        openai: createAdapter(async () => ({ text: "unused" }))
      },
      maxRetries: 6
    });
    await expect(
      invalidRetryGateway.generate({
        ...request,
        primary: { provider: "openai", modelId: "primary" }
      })
    ).rejects.toThrow("between 0 and 5");
  });

  it("aborts a provider stream that exceeds the idle timeout after its first event", async () => {
    let observedSignal: AbortSignal | undefined;
    const stream = vi.fn(async (input: ModelGenerateInput) => {
      observedSignal = input.abortSignal;
      return (async function* () {
        yield { type: "text-delta" as const, textDelta: "started" };
        await new Promise<void>((_resolve, reject) => {
          const rejectWithAbort = () =>
            reject(
              input.abortSignal?.reason ??
                new DOMException("Aborted", "AbortError")
            );
          if (input.abortSignal?.aborted) {
            rejectWithAbort();
          } else {
            input.abortSignal?.addEventListener("abort", rejectWithAbort, {
              once: true
            });
          }
        });
      })();
    });
    const gateway = createGateway({
      adapters: {
        openai: createStreamingAdapter(stream)
      },
      streamIdleTimeoutMs: 10,
      maxRetries: 0
    });

    const result = gateway.streamText({
      ...request,
      primary: { provider: "openai", modelId: "idle-stream" }
    });

    await expect(result.collect()).rejects.toThrow(/idle/i);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("stops retry and fallback when the caller aborts during backoff", async () => {
    const controller = new AbortController();
    const primaryGenerate = vi.fn(async () => {
      throw new ProviderHTTPError("retry later", 503);
    });
    const fallbackGenerate = vi.fn(async () => ({ text: "must not run" }));
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(primaryGenerate),
        gemini: createAdapter(fallbackGenerate)
      },
      maxRetries: 2,
      retryBackoffMs: 100,
      onAttempt(attempt) {
        if (attempt.reasonCode === "provider-error") {
          controller.abort(new DOMException("Caller aborted during backoff", "AbortError"));
        }
      }
    });

    await expect(
      gateway.generate({
        ...request,
        primary: { provider: "openai", modelId: "primary-model" },
        fallbacks: [{ provider: "gemini", modelId: "fallback-model" }],
        abortSignal: controller.signal
      })
    ).rejects.toThrow(/aborted during backoff/i);

    expect(primaryGenerate).toHaveBeenCalledTimes(1);
    expect(fallbackGenerate).not.toHaveBeenCalled();
  });

  it("does not retry or fall back after the caller aborts an agent run", async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const primaryGenerate = vi.fn(
      (input: ModelGenerateInput) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          markStarted?.();
          const rejectWithAbort = () =>
            reject(input.abortSignal?.reason ?? new DOMException("Aborted", "AbortError"));

          if (input.abortSignal?.aborted) {
            rejectWithAbort();
            return;
          }
          input.abortSignal?.addEventListener("abort", rejectWithAbort, { once: true });
        })
    );
    const fallbackGenerate = vi.fn(async () => ({ text: "must not run" }));
    const gateway = createGateway({
      adapters: {
        openai: createAdapter(primaryGenerate, agentCapabilities()),
        gemini: createAdapter(fallbackGenerate, agentCapabilities())
      },
      maxRetries: 2,
      retryBackoffMs: 0
    });

    const result = gateway.runAgent({
      primary: { provider: "openai", modelId: "primary-agent-model" },
      fallbacks: [{ provider: "gemini", modelId: "fallback-agent-model" }],
      prompt: "cancel this",
      abortSignal: controller.signal
    });

    await started;
    controller.abort(new DOMException("Caller aborted", "AbortError"));

    await expect(result).rejects.toThrow();
    expect(primaryGenerate).toHaveBeenCalledTimes(1);
    expect(fallbackGenerate).not.toHaveBeenCalled();
  });
});
