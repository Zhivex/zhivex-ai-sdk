import { expect, it, vi } from "vitest";
import { createGateway, createGatewayMetrics } from "../src/index.js";
import { createMockLanguageModel } from "../../core/src/testing.js";
const target = { provider: "gemini" as const, modelId: "fixture" };
const request = { primary: target, messages: [{ role: "user" as const, content: "hello" }] };
it("expires samples and bounds targets and sample storage with an injected clock", () => {
  let now = 0;
  const metrics = createGatewayMetrics({ now: () => now, windowMs: 10, maxTargets: 1, maxSamplesPerTarget: 2 });
  expect(metrics.snapshot(target)).toBeUndefined();
  const first = metrics.begin(target)!;
  expect(metrics.begin({ ...target, modelId: "other" })).toBeUndefined();
  expect(metrics.snapshot(target)?.inFlight).toBe(1);
  now = 2; first.firstText(); now = 5; first.end("success"); first.end("error");
  expect(metrics.snapshot(target)).toMatchObject({ inFlight: 0, sampleCount: 1, p95LatencyMs: 5, p95TtftMs: 2, errors: 0 });
  metrics.begin(target)!.end("error"); metrics.begin(target)!.end("cancelled");
  expect(metrics.snapshot(target)).toMatchObject({ sampleCount: 2, errors: 1, cancellations: 1 });
  now = 16;
  expect(metrics.snapshot(target)).toMatchObject({ sampleCount: 0, p95LatencyMs: undefined });
  metrics.begin({ ...target, modelId: "other" })!.end("success");
  expect(metrics.snapshot(target)).toBeUndefined();
});
it.each(["success", "failure", "timeout", "abort"])("releases in-flight on %s", async outcome => {
  const metrics = createGatewayMetrics(), model = createMockLanguageModel(), controller = new AbortController();
  model.generate = async () => {
    expect(metrics.snapshot(target)?.inFlight).toBe(1);
    if (outcome === "failure") throw new Error("fixture failure");
    if (outcome === "timeout") return new Promise(() => {});
    if (outcome === "abort") { controller.abort(); return new Promise(() => {}); }
    return { text: "done", messages: [] };
  };
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model } }, metrics, maxRetries: 0, attemptTimeoutMs: 5 });
  await gateway.generate({ ...request, abortSignal: controller.signal }).catch(() => {});
  expect(metrics.snapshot(target)).toMatchObject({ inFlight: 0, sampleCount: 1, successes: outcome === "success" ? 1 : 0, cancellations: outcome === "abort" ? 1 : 0, errors: ["failure", "timeout"].includes(outcome) ? 1 : 0 });
});
it("separates first text from full stream completion", async () => {
  let now = 0; const metrics = createGatewayMetrics({ now: () => now });
  const model = createMockLanguageModel();
  model.stream = async () => (async function* () { now = 2; yield { type: "text-delta" as const, textDelta: "ok" }; now = 10; yield { type: "finish" as const, finishReason: "stop" as const }; })();
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model } }, metrics });
  await gateway.streamText(request).collect();
  expect(metrics.snapshot(target)).toMatchObject({ inFlight: 0, p95TtftMs: 2, p95LatencyMs: 10, successes: 1 });
});
it("ignores broken metrics and asynchronous observers without retrying the provider", async () => {
  const model = createMockLanguageModel(); model.generate = vi.fn(async () => ({ text: "done", messages: [] }));
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model } }, metrics: { begin: () => { throw new Error("observer"); }, snapshot: () => undefined }, onAttempt: async () => { throw new Error("observer"); } });
  expect((await gateway.generate(request)).text).toBe("done"); expect(model.generate).toHaveBeenCalledTimes(1);
});
it("releases a stream abandoned through iterator.return", async () => {
  const metrics = createGatewayMetrics(), model = createMockLanguageModel();
  model.stream = async () => (async function* () { yield { type: "text-delta" as const, textDelta: "ok" }; await new Promise(() => {}); })();
  const gateway = createGateway({ adapters: { gemini: { name: "test", languageModel: () => model } }, metrics });
  const result = gateway.streamText(request);
  const iterator = result.eventStream[Symbol.asyncIterator]();
  await iterator.next(); await iterator.return?.();
  await expect(result.collect()).rejects.toThrow();
  expect(metrics.snapshot(target)?.cancellations).toBe(1);
  expect(metrics.snapshot(target)?.inFlight).toBe(0);
});
