import { expect, it, vi } from "vitest";
import { createInMemoryGenerateCache, createModelCatalog, type LanguageModel, type ModelGenerateInput } from "@zhivex-ai/core";
import { createMockLanguageModel } from "../../core/src/testing.js";
import { createGateway, createGatewayAdmissionController, createGatewayBudgetStore, createGatewayMetrics, createGatewayCircuitBreaker, GatewayDeadlineError, createGatewayRoutingPolicy } from "../src/index.js";
import { scoreAdaptiveTarget } from "../src/adaptive-routing.js";
const target = { provider: "gemini" as const, modelId: "fixture" };
const request = { primary: target, messages: [{ role: "user" as const, content: "hello" }], maxTokens: 20 };
const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0 };
const response = { text: "done", messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "done" }] }], usage };
const fixture = () => createMockLanguageModel({ responses: Array.from({ length: 20 }, () => structuredClone(response)), streamEvents: [[{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop", usage }]] });
const adapter = (model: LanguageModel) => ({ gemini: { name: "fixture", languageModel: () => model } });
const catalog = createModelCatalog([{ ...target, inputCostPer1kTokens: 1, outputCostPer1kTokens: 1 }], { snapshotVersion: "test", pricing: { version: "1", currency: "USD", unit: "per_1k_tokens" } });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
it("uses conservative cold-start and TTFT independently of total latency", () => {
  const policy = createGatewayRoutingPolicy("interactive", { minSamples: 1, weights: { latency: 1, cost: 0, quality: 0, load: 0, errorRate: 0 } });
  const metrics = { inFlight: 0, sampleCount: 10, successes: 10, errors: 0, cancellations: 0, p95LatencyMs: 10000, p95TtftMs: 100 };
  expect(scoreAdaptiveTarget(policy, target, "chat", metrics).score).toBe(-.1);
  expect(scoreAdaptiveTarget(policy, target, "chat").score).toBe(-1);
  expect(scoreAdaptiveTarget({ ...policy, minQuality: .8 }, target, "chat", metrics).exclusions).toContain("quality-floor");
});
it("isolates metrics, circuits and adapter selection by deployment", async () => {
  const a = { ...target, deploymentId: "a" }, b = { ...target, deploymentId: "b" };
  const metrics = createGatewayMetrics(); metrics.begin(a)!.end("error"); expect(metrics.snapshot(b)).toBeUndefined();
  const circuitBreaker = createGatewayCircuitBreaker({ failureThreshold: 1 }); circuitBreaker.acquire(a)!.end("retryable-error");
  const good = fixture(); good.generate = vi.fn(good.generate);
  const gateway = createGateway({ adapters: {}, deployments: { a: { provider: "gemini", adapter: adapter(fixture()).gemini }, b: { provider: "gemini", adapter: adapter(good).gemini } }, circuitBreaker });
  const result = await gateway.generate({ ...request, primary: a, fallbacks: [b] });
  expect(result.attempts.at(-1)?.deploymentId).toBe("b"); expect(good.generate).toHaveBeenCalledTimes(1);
  await expect(gateway.generate({ ...request, primary: { ...target, deploymentId: "unknown" } })).rejects.toThrow("no adapter");
});
it("caps concurrency, bounds queues, handles cancellation and retains RPM usage", async () => {
  const controller = createGatewayAdmissionController({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 200, requestsPerMinute: 2 });
  const lease = await controller.acquire({ target, tokens: 1 });
  const abort = new AbortController(); const waiting = controller.acquire({ target, tokens: 1, signal: abort.signal });
  await expect(controller.acquire({ target, tokens: 1 })).rejects.toThrow("capacity");
  abort.abort(); await expect(waiting).rejects.toThrow(); lease.release();
  (await controller.acquire({ target, tokens: 1 })).release();
  await expect(controller.acquire({ target, tokens: 1 })).rejects.toThrow("capacity");
});
it("requires bounded output for TPM, reconciles tokens and does not reset limits on eviction", async () => {
  let now = 0;
  const controller = createGatewayAdmissionController({ maxConcurrent: 1, tokensPerMinute: 10, maxTargets: 1, now: () => now });
  await expect(controller.acquire({ target })).rejects.toThrow("token reservation");
  (await controller.acquire({ target, tokens: 8 })).release(3);
  (await controller.acquire({ target, tokens: 7 })).release();
  await expect(controller.acquire({ target, tokens: 1 })).rejects.toThrow("capacity");
  await expect(controller.acquire({ target: { ...target, modelId: "other" }, tokens: 1 })).rejects.toThrow("capacity");
  now = 60000; (await controller.acquire({ target: { ...target, modelId: "other" }, tokens: 10 })).release();
});
it.each([false, true])("releases admission on deadline even if provider ignores abort (stream=%s)", async stream => {
  const model = fixture(); let signal: AbortSignal | undefined;
  model.generate = async input => { signal = input.abortSignal; return new Promise(() => {}); };
  model.stream = async input => { signal = input.abortSignal; return { async *[Symbol.asyncIterator]() { yield { type: "text-delta" as const, textDelta: "first" }; await new Promise(() => {}); } }; };
  const admission = createGatewayAdmissionController({ maxConcurrent: 1 });
  const gateway = createGateway({ adapters: adapter(model), admission, timeoutMs: 25, maxRetries: 0 });
  await expect(stream ? gateway.streamText(request).collect() : gateway.generate(request)).rejects.toBeInstanceOf(GatewayDeadlineError);
  expect(signal?.aborted).toBe(true);
  (await admission.acquire({ target, tokens: 1 })).release();
});
it("shares the deadline across fallback and respects the server ceiling", async () => {
  let calls = 0;
  const model = fixture(); model.generate = async () => { calls++; await pause(20); throw new Error("503"); };
  const gateway = createGateway({ adapters: adapter(model), timeoutMs: 30, retryBackoffMs: 1000 });
  await expect(gateway.generate({ ...request, timeoutMs: 10000 })).rejects.toBeInstanceOf(GatewayDeadlineError);
  expect(calls).toBe(1);
});
it("does not let background observers block successful generation and bounds their queue", async () => {
  const gateway = createGateway({ adapters: adapter(fixture()), observerMode: "background", observerQueueCapacity: 1, observerTimeoutMs: 25, onAttempt: () => new Promise(() => {}) });
  await Promise.all([gateway.generate(request), gateway.generate(request), gateway.generate(request)]);
  expect(gateway.diagnostics().pendingObservers).toBe(1); expect(gateway.diagnostics().droppedObservers).toBe(2);
  await gateway.flushObservers(); expect(gateway.diagnostics().pendingObservers).toBe(0);
});
it("reserves atomically, preserves uncertain spend and refuses scope eviction", async () => {
  const store = createGatewayBudgetStore({ limit: 1, currency: "USD", maxScopes: 1 });
  const reserve = { scope: "tenant", currency: "USD", amount: .6 };
  const results = await Promise.allSettled([store.reserve(reserve), store.reserve(reserve)]);
  expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
  const success = results.find(x => x.status === "fulfilled")!; if (success.status === "fulfilled") success.value.settle(null);
  expect(store.snapshot("tenant").uncertain).toBe(.6);
  await expect(store.reserve({ ...reserve, scope: "other" })).rejects.toThrow("budget");
});
it.each([false, true])("settles actual usage after provider completion (stream=%s)", async stream => {
  const store = createGatewayBudgetStore({ limit: 1, currency: "USD" });
  const gateway = createGateway({ adapters: adapter(fixture()), modelCatalog: catalog, budget: { store, currency: "USD", reserveAmount: .5 } });
  await (stream ? gateway.streamText({ ...request, budgetScope: "tenant" }).collect() : gateway.generate({ ...request, budgetScope: "tenant" }));
  expect(store.snapshot("tenant")).toMatchObject({ spent: .02, reserved: 0, uncertain: 0 });
  await expect(gateway.generate(request)).rejects.toThrow("budget");
});
it("keeps unknown failures reserved and prevents fallback spending beyond the remaining budget", async () => {
  const store = createGatewayBudgetStore({ limit: .5, currency: "USD" });
  const model = fixture(); model.generate = vi.fn(async () => { throw new Error("503"); });
  const gateway = createGateway({ adapters: adapter(model), modelCatalog: catalog, budget: { store, currency: "USD", reserveAmount: .5 }, retryBackoffMs: 0 });
  await expect(gateway.generate({ ...request, budgetScope: "tenant" })).rejects.toThrow("budget");
  expect(model.generate).toHaveBeenCalledTimes(1); expect(store.snapshot("tenant").uncertain).toBe(.5);
});
it("caches exact text without billing a hit and isolates tenant/deployment scopes", async () => {
  const model = fixture(); model.generate = vi.fn(model.generate);
  const gateway = createGateway({ adapters: adapter(model), modelCatalog: catalog, costAccounting: {}, cache: { store: createInMemoryGenerateCache(), scope: "credential-v1" } });
  const a = { ...request, cacheScope: "tenant-a" };
  await gateway.generate(a); const hit = await gateway.generate(a);
  expect(model.generate).toHaveBeenCalledTimes(1); expect(hit.attempts[0]?.cacheHit).toBe(true); expect(hit.attempts[0]?.cost?.amount).toBe(0);
  await gateway.generate({ ...request, cacheScope: "tenant-b" }); expect(model.generate).toHaveBeenCalledTimes(2);
});
it("coalesces simultaneous cache misses without letting one caller cancel another", async () => {
  const model = fixture(); let upstreamSignal: AbortSignal | undefined;
  model.generate = vi.fn(async (input: ModelGenerateInput) => { upstreamSignal = input.abortSignal; await pause(25); input.abortSignal?.throwIfAborted(); return response; });
  const gateway = createGateway({ adapters: adapter(model), cache: { store: createInMemoryGenerateCache(), scope: "credential" } });
  const abort = new AbortController(); const a = gateway.generate({ ...request, cacheScope: "tenant", abortSignal: abort.signal });
  const b = gateway.generate({ ...request, cacheScope: "tenant" });
  await pause(5); abort.abort(); await expect(a).rejects.toThrow(); expect(upstreamSignal?.aborted).toBe(false);
  expect((await b).text).toBe("done"); expect(model.generate).toHaveBeenCalledTimes(1);
});
it("explores allowed cold destinations periodically without bypassing capability checks", async () => {
  const policy = createGatewayRoutingPolicy("interactive", { minSamples: 1, explorationEvery: 2, weights: { latency: 1, cost: 0, quality: 0, load: 0, errorRate: 0 } });
  const metrics = { begin: () => undefined, snapshot: (t: typeof target) => t.modelId === "fixture" ? { inFlight: 0, sampleCount: 1, successes: 1, errors: 0, cancellations: 0, p95TtftMs: 100 } : undefined };
  const gateway = createGateway({ adapters: adapter(fixture()), metrics, adaptiveRouting: policy });
  const input = { ...request, fallbacks: [{ ...target, modelId: "cold" }] };
  expect((await gateway.generate(input)).modelUsed).toBe("fixture");
  const second = await gateway.generate(input); expect(second.modelUsed).toBe("cold"); expect(second.routeDecision.adaptive?.exploration).toBe(true);
});
it("reuses an eligible affinity destination within the configured score loss and tenant scope", async () => {
  const metrics = { begin: () => undefined, snapshot: () => ({ inFlight: 0, sampleCount: 1, successes: 1, errors: 0, cancellations: 0, p95TtftMs: 100 }) };
  const gateway = createGateway({ adapters: adapter(fixture()), metrics, affinity: { maxEntries: 1 }, adaptiveRouting: createGatewayRoutingPolicy("interactive", { minSamples: 1, weights: { latency: 1, cost: 0, quality: 0, load: 0, errorRate: 0 } }) });
  const other = { ...target, modelId: "other" };
  await gateway.generate({ ...request, primary: other, fallbacks: [target], cacheScope: "tenant-a", affinityKey: "conversation" });
  const second = await gateway.generate({ ...request, fallbacks: [other], cacheScope: "tenant-a", affinityKey: "conversation" });
  expect(second.modelUsed).toBe("other"); expect(second.routeDecision.adaptive?.affinity).toBe(true);
  expect((await gateway.generate({ ...request, fallbacks: [other], cacheScope: "tenant-b", affinityKey: "conversation" })).modelUsed).toBe("fixture");
  expect(gateway.diagnostics().affinityEntries).toBe(1);
});
it("records throughput from successful streams and excludes cached latency", () => {
  let now = 0; const metrics = createGatewayMetrics({ now: () => now });
  const live = metrics.begin(target)!; now = 100; live.firstText(); now = 1100; live.end("success", 101);
  const cached = metrics.begin(target)!; now = 1101; cached.end("cache", 101);
  expect(metrics.snapshot(target)).toMatchObject({ p50TokensPerSecond: 100, p95LatencyMs: 1100, successes: 1 });
});
it("releases streaming resources on iterator return and preserves uncertain spend", async () => {
  const model = fixture(); model.stream = async () => ({ async *[Symbol.asyncIterator]() { yield { type: "text-delta" as const, textDelta: "hello" }; await new Promise(() => {}); } });
  const admission = createGatewayAdmissionController({ maxConcurrent: 1 });
  const store = createGatewayBudgetStore({ limit: 1, currency: "USD" });
  const gateway = createGateway({ adapters: adapter(model), admission, modelCatalog: catalog, budget: { store, currency: "USD", reserveAmount: .5 } });
  const result = gateway.streamText({ ...request, budgetScope: "tenant" });
  const iterator = result.textStream[Symbol.asyncIterator](); await iterator.next(); await iterator.return!();
  await expect(result.collect()).rejects.toThrow();
  (await admission.acquire({ target, tokens: 1 })).release();
  expect(store.snapshot("tenant")).toMatchObject({ reserved: 0, uncertain: .5 });
});
it("does not repeat provider work when budget settlement fails and blocks further reservations", async () => {
  const model = fixture(); model.generate = vi.fn(model.generate);
  const store = { reserve: async () => ({ settle() { throw new Error("backend down"); }, cancel() {} }) };
  const gateway = createGateway({ adapters: adapter(model), modelCatalog: catalog, budget: { store, currency: "USD", reserveAmount: .5 } });
  expect((await gateway.generate({ ...request, budgetScope: "tenant" })).text).toBe("done");
  expect(gateway.diagnostics().settlementFailures).toBe(1);
  await expect(gateway.generate({ ...request, budgetScope: "tenant" })).rejects.toThrow("budget");
  expect(model.generate).toHaveBeenCalledTimes(1);
});
it("aborts a shared cache miss when all subscribers leave and releases admission", async () => {
  const model = fixture(); let signal: AbortSignal | undefined;
  model.generate = async input => { signal = input.abortSignal; return new Promise(() => {}); };
  const admission = createGatewayAdmissionController({ maxConcurrent: 1 });
  const gateway = createGateway({ adapters: adapter(model), admission, cache: { store: createInMemoryGenerateCache(), scope: "credential" } });
  await expect(gateway.generate({ ...request, cacheScope: "tenant", timeoutMs: 20 })).rejects.toBeInstanceOf(GatewayDeadlineError);
  await pause(0); expect(signal?.aborted).toBe(true); expect(gateway.diagnostics().inFlightCacheKeys).toBe(0);
  (await admission.acquire({ target, tokens: 1 })).release();
});
it("bypasses cache for provider-specific inputs", async () => {
  const model = fixture(); model.generate = vi.fn(model.generate);
  const gateway = createGateway({ adapters: adapter(model), cache: { store: createInMemoryGenerateCache(), scope: "credential" } });
  await gateway.generate({ ...request, cacheScope: "tenant", providerOptions: { custom: true } });
  await gateway.generate({ ...request, cacheScope: "tenant", providerOptions: { custom: true } });
  expect(model.generate).toHaveBeenCalledTimes(2);
});
it("does not retry successful work when cache writes or resource settlements hang", async () => {
  const model = fixture(); model.generate = vi.fn(model.generate);
  const gateway = createGateway({ adapters: adapter(model), modelCatalog: catalog, resourceTimeoutMs: 10,
    budget: { currency: "USD", reserveAmount: .5, store: { reserve: async () => ({ settle: () => new Promise<void>(() => {}), cancel() {} }) } },
    cache: { scope: "credential", store: { get: () => undefined, set: () => new Promise<void>(() => {}) } }, attemptTimeoutMs: 30 });
  expect((await gateway.generate({ ...request, cacheScope: "tenant", budgetScope: "tenant" })).text).toBe("done");
  await gateway.flushControls();
  expect(gateway.diagnostics().settlementFailures).toBe(1); expect(model.generate).toHaveBeenCalledTimes(1);
});
it("a stalled cache read becomes a miss but cancellation never dispatches late work", async () => {
  const model = fixture(); model.generate = vi.fn(model.generate);
  const gateway = createGateway({ adapters: adapter(model), cache: { scope: "credential", timeoutMs: 5, store: { get: () => new Promise(() => {}), set() {} } } });
  expect((await gateway.generate({ ...request, cacheScope: "tenant" })).text).toBe("done");
  expect(model.generate).toHaveBeenCalledTimes(1);
  await expect(gateway.generate({ ...request, cacheScope: "tenant", timeoutMs: 1 })).rejects.toBeInstanceOf(GatewayDeadlineError);
  await pause(10); expect(model.generate).toHaveBeenCalledTimes(1);
});
it("releases late remote admission leases without dispatching after cancellation", async () => {
  const release = vi.fn(); const model = fixture(); model.generate = vi.fn(model.generate);
  const gateway = createGateway({ adapters: adapter(model), admission: { acquire: async () => { await pause(20); return { release }; } } });
  await expect(gateway.generate({ ...request, timeoutMs: 5 })).rejects.toBeInstanceOf(GatewayDeadlineError);
  await pause(25); expect(release).toHaveBeenCalledTimes(1); expect(model.generate).not.toHaveBeenCalled();
});
it("releases admission while a remote budget reservation is still pending", async () => {
  const release = vi.fn(), cancel = vi.fn(); const model = fixture(); model.generate = vi.fn(model.generate);
  const gateway = createGateway({ adapters: adapter(model), admission: { acquire: async () => ({ release }) }, modelCatalog: catalog,
    budget: { currency: "USD", reserveAmount: .5, store: { reserve: async () => { await pause(25); return { cancel, settle() {} }; } } } });
  await expect(gateway.generate({ ...request, budgetScope: "tenant", timeoutMs: 5 })).rejects.toBeInstanceOf(GatewayDeadlineError);
  expect(release).toHaveBeenCalledTimes(1);
  await pause(30); expect(cancel).toHaveBeenCalledTimes(1); expect(model.generate).not.toHaveBeenCalled();
});
it.each(["generateObject", "streamObject", "runAgent", "streamAgent"] as const)("applies the global deadline to %s", async method => {
  const { z } = await import("zod");
  const model = fixture(); model.generate = async () => new Promise(() => {}); model.stream = async () => new Promise(() => {});
  const gateway = createGateway({ adapters: adapter(model), timeoutMs: 10 });
  const result = method === "generateObject" ? gateway.generateObject({ ...request, schema: z.object({ text: z.string() }), mode: "prompted" })
    : method === "streamObject" ? gateway.streamObject({ ...request, schema: z.object({ text: z.string() }), mode: "prompted" }).collect()
    : method === "runAgent" ? gateway.runAgent({ primary: target, prompt: "hello" })
    : gateway.streamAgent({ primary: target, prompt: "hello" }).collect();
  await expect(result).rejects.toBeInstanceOf(GatewayDeadlineError);
});
