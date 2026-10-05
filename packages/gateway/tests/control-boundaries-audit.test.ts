import { expect, it, vi } from "vitest";
import { createGateway, createGatewayBudgetStore, createGatewayCircuitBreaker, createGatewayMetrics } from "../src/index.js";
import { createMockLanguageModel } from "../../core/src/testing.js";
const first = { provider: "gemini" as const, modelId: "first" };
const second = { ...first, modelId: "second" }, third = { ...first, modelId: "third" };
const request = { primary: first, messages: [{ role: "user" as const, content: "hello" }] };

it("computes multi-sample latency, TTFT and throughput independently of cache/cancellation", () => {
  let now = 0;
  const metrics = createGatewayMetrics({ now: () => now });
  for (const [latency, ttft, tokens] of [[300, 100, 5], [100, 20, 9], [200, 50, 4]]) {
    const handle = metrics.begin(first)!;
    now += ttft!; handle.firstText(); now += latency! - ttft!; handle.end("success", tokens);
  }
  const cached = metrics.begin(first)!; now += 10000; cached.end("cache");
  const cancelled = metrics.begin(first)!; now += 10000; cancelled.end("cancelled");
  expect(metrics.snapshot(first)).toMatchObject({ sampleCount: 5, successes: 3, cancellations: 1, p50LatencyMs: 200, p95LatencyMs: 300, p95TtftMs: 100, p50TokensPerSecond: 20 });
});
it("evicts the least recently used idle metrics target without evicting active work", () => {
  let now = 0; const metrics = createGatewayMetrics({ now: () => now, maxTargets: 2 });
  metrics.begin(first)!.end("success"); now++;
  metrics.begin(second)!.end("success"); now++;
  const active = metrics.begin(third)!;
  expect(metrics.snapshot(first)).toBeUndefined();
  expect(metrics.snapshot(second)).toBeDefined();
  expect(metrics.snapshot(third)?.inFlight).toBe(1);
  active.end("success");
});
it("evicts only closed idle circuits and isolates asynchronous observer rejection", async () => {
  let now = 0;
  const onStateChange = vi.fn(async () => { throw new Error("observer unavailable"); });
  const breaker = createGatewayCircuitBreaker({ now: () => now, maxTargets: 2, failureThreshold: 1, onStateChange });
  breaker.acquire(first)!.end("success"); now++;
  breaker.acquire(second)!.end("success"); now++;
  breaker.acquire(third)!.end("retryable-error");
  await Promise.resolve(); await Promise.resolve();
  expect(breaker.snapshot(first)).toBeUndefined();
  expect(breaker.snapshot(second)?.state).toBe("closed");
  expect(breaker.snapshot(third)?.state).toBe("open");
  expect(onStateChange).toHaveBeenCalledOnce();
  breaker.acquire(first)!.end("success");
  expect(breaker.snapshot(third)?.state).toBe("open");
});
it("cancels undispatched budget reservations idempotently while keeping settled spend", async () => {
  const budget = createGatewayBudgetStore({ limit: 10, currency: "USD" });
  const first = await budget.reserve({ scope: "tenant", currency: "USD", amount: 6 });
  first.cancel(); first.cancel(); first.settle(6);
  expect(budget.snapshot("tenant")).toEqual({ spent: 0, reserved: 0, uncertain: 0, remaining: 10 });
  const second = await budget.reserve({ scope: "tenant", currency: "USD", amount: 6 });
  second.settle(4); second.cancel();
  expect(budget.snapshot("tenant")).toEqual({ spent: 4, reserved: 0, uncertain: 0, remaining: 6 });
});
it("cache write outages never turn completed provider output into a retry", async () => {
  const model = createMockLanguageModel(); model.generate = vi.fn(async () => ({ text: "OK", messages: [] }));
  const set = vi.fn(async () => { throw new Error("store unavailable"); });
  const gateway = createGateway({ adapters: { gemini: { name: "fixture", languageModel: () => model } }, cache: { scope: "auth", store: { get: async () => undefined, set } } });
  expect((await gateway.generate({ ...request, cacheScope: "tenant" })).text).toBe("OK");
  await gateway.flushControls();
  expect(set).toHaveBeenCalledOnce();
  expect(model.generate).toHaveBeenCalledOnce();
  expect(gateway.diagnostics().pendingCacheWrites).toBe(0);
});
it("releases a failed coalesced cache flight so the next request can recover", async () => {
  const model = createMockLanguageModel(); model.generate = vi.fn().mockRejectedValueOnce(new Error("upstream unavailable")).mockResolvedValue({ text: "recovered", messages: [] });
  const gateway = createGateway({ adapters: { gemini: { name: "fixture", languageModel: () => model } }, maxRetries: 0, cache: { scope: "auth", store: { get: async () => undefined, set: async () => {} } } });
  await expect(gateway.generate({ ...request, cacheScope: "tenant" })).rejects.toThrow("upstream unavailable");
  expect((await gateway.generate({ ...request, cacheScope: "tenant" })).text).toBe("recovered");
  await gateway.flushControls();
  expect(gateway.diagnostics().inFlightCacheKeys).toBe(0);
  expect(model.generate).toHaveBeenCalledTimes(2);
});
