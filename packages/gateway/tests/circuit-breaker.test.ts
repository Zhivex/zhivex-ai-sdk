import { expect, it, vi } from "vitest";
import { ProviderHTTPError, ValidationError } from "@zhivex-ai/core";
import { createGateway, createGatewayCircuitBreaker, GatewayCircuitOpenError } from "../src/index.js";
import { createMockLanguageModel } from "../../core/src/testing.js";
const target = { provider: "gemini" as const, modelId: "fixture" };
const request = { primary: target, messages: [{ role: "user" as const, content: "hello" }] };
it("opens, limits recovery probes, and ignores stale in-flight results", () => {
  let now = 0; const breaker = createGatewayCircuitBreaker({ now: () => now, failureThreshold: 1, cooldownMs: 10, maxCooldownMs: 30 });
  const failure = breaker.acquire(target)!, stale = breaker.acquire(target)!;
  failure.end("retryable-error", 20);
  stale.end("success");
  expect(breaker.snapshot(target)).toMatchObject({ state: "open", openUntil: 20 });
  now = 19; expect(breaker.acquire(target)).toBeUndefined();
  now = 20; const probe = breaker.acquire(target)!; expect(probe).toBeDefined();
  expect(breaker.acquire(target)).toBeUndefined();
  probe.end("retryable-error", 1000);
  expect(breaker.snapshot(target)?.openUntil).toBe(50);
  now = 50; breaker.acquire(target)!.end("success");
  expect(breaker.snapshot(target)).toMatchObject({ state: "closed", failures: 0, inFlight: 0 });
});
it("skips open destinations and returns a typed all-open failure", async () => {
  let now = 0; const circuitBreaker = createGatewayCircuitBreaker({ now: () => now, failureThreshold: 1, cooldownMs: 10 });
  const model = createMockLanguageModel(); model.generate = vi.fn(async () => { throw new ProviderHTTPError("unavailable", 503); });
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model } }, circuitBreaker, maxRetries: 3 });
  await expect(gateway.generate(request)).rejects.toThrow();
  await expect(gateway.generate(request)).rejects.toBeInstanceOf(GatewayCircuitOpenError);
  expect(model.generate).toHaveBeenCalledTimes(1);
  now = 10; model.generate = vi.fn(async () => ({ text: "recovered", messages: [] }));
  expect((await gateway.generate(request)).text).toBe("recovered");
  expect(circuitBreaker.snapshot(target)?.state).toBe("closed");
});
it.each([new ValidationError("invalid"), new ProviderHTTPError("unauthorized", 401)])("does not open on nonretryable failures: %s", async error => {
  const circuitBreaker = createGatewayCircuitBreaker({ failureThreshold: 1 });
  const model = createMockLanguageModel(); model.generate = async () => { throw error; };
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model } }, circuitBreaker, maxRetries: 0 });
  await gateway.generate(request).catch(() => {});
  expect(circuitBreaker.snapshot(target)).toMatchObject({ state: "closed", inFlight: 0, failures: 0 });
});
it("does not open on client cancellation and isolates state observers", async () => {
  const circuitBreaker = createGatewayCircuitBreaker({ failureThreshold: 1, onStateChange: () => { throw new Error("observer"); } });
  const controller = new AbortController();
  const model = createMockLanguageModel(); model.generate = async () => { controller.abort(); return new Promise(() => {}); };
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model } }, circuitBreaker });
  await gateway.generate({ ...request, abortSignal: controller.signal }).catch(() => {});
  expect(circuitBreaker.snapshot(target)).toMatchObject({ state: "closed", inFlight: 0, failures: 0 });
  circuitBreaker.acquire(target)!.end("retryable-error"); await Promise.resolve();
  expect(circuitBreaker.snapshot(target)?.state).toBe("open");
});
it("records streaming failures without falling back after output", async () => {
  const circuitBreaker = createGatewayCircuitBreaker({ failureThreshold: 1 });
  const model = createMockLanguageModel(); model.stream = async () => (async function* () { yield { type: "text-delta" as const, textDelta: "partial" }; throw new ProviderHTTPError("unavailable", 503); })();
  const fallback = createMockLanguageModel(); fallback.stream = vi.fn(fallback.stream!);
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model }, bedrock: { name: "other", languageModel: () => fallback } }, circuitBreaker, scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0 });
  await expect(gateway.streamText({ ...request, fallbacks: [{ provider: "bedrock", modelId: "fixture" }] }).collect()).rejects.toThrow("unavailable");
  expect(fallback.stream).not.toHaveBeenCalled(); expect(circuitBreaker.snapshot(target)?.state).toBe("open");
});
