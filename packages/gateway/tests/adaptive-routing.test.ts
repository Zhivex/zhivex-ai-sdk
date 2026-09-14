import { expect, it } from "vitest";
import { createModelCatalog } from "@zhivex-ai/core";
import { createGateway, createGatewayMetrics, createGatewayCircuitBreaker, type GatewayAdaptiveRoutingPolicy } from "../src/index.js";
import { createMockLanguageModel } from "../../core/src/testing.js";
const slow = { provider: "gemini" as const, modelId: "flash-pro" }, fast = { provider: "gemini" as const, modelId: "plain" };
const policy: GatewayAdaptiveRoutingPolicy = { version: "fixture-v1", weights: { latency: 1, cost: 0, quality: 0, load: 0, errorRate: 0 }, latencyScaleMs: 100, costScale: 1, coldStart: "reject", unknownCost: "reject", missingQuality: "reject" };
const adapters = { gemini: { name: "fixture", languageModel: (id: string) => createMockLanguageModel({ modelId: id, responses: [{ text: id, messages: [{ role: "assistant", parts: [{ type: "text", text: id }] }], finishReason: "stop" }] }) } };
const request = { primary: slow, fallbacks: [fast], messages: [{ role: "user" as const, content: "hello" }], maxTokens: 100 };
it("selects measured latency independently of model names and excludes expired samples", async () => {
  let now = 0; const metrics = createGatewayMetrics({ now: () => now, windowMs: 1000 });
  const a = metrics.begin(slow)!; now = 100; a.end("success");
  const b = metrics.begin(fast)!; now = 110; b.end("success");
  const gateway = createGateway({ adapters, metrics, adaptiveRouting: policy });
  const result = await gateway.generate(request);
  expect(result.modelUsed).toBe("plain"); expect(result.routeDecision.reasonCode).toBe("routing-adaptive");
  expect(result.routeDecision.adaptive?.policyVersion).toBe("fixture-v1");
  now = 2000;
  await expect(gateway.generate(request)).rejects.toThrow("health-unavailable");
});
it("selects costs or declared task quality with explicit missing policies", async () => {
  const catalog = createModelCatalog([{ ...slow, inputCostPer1kTokens: 1, outputCostPer1kTokens: 1 }, { ...fast, inputCostPer1kTokens: 10, outputCostPer1kTokens: 10 }], { snapshotVersion: "fixture", pricing: { version: "1", currency: "USD", unit: "per_1k_tokens" } });
  const costGateway = createGateway({ adapters, modelCatalog: catalog, costAccounting: {}, adaptiveRouting: { ...policy, weights: { ...policy.weights, latency: 0, cost: 1 } } });
  expect((await costGateway.generate(request)).modelUsed).toBe("flash-pro");
  const qualityGateway = createGateway({ adapters, adaptiveRouting: { ...policy, weights: { ...policy.weights, latency: 0, quality: 1 }, qualityProfiles: [{ target: fast, intent: "chat", score: .9, version: "eval-1" }] } });
  const result = await qualityGateway.generate(request);
  expect(result.modelUsed).toBe("plain");
  expect(result.routeDecision.adaptive?.candidates[0]?.exclusions).toContain("quality-unavailable");
});
it("filters open circuits before ordering and rechecks admission before calls", async () => {
  const circuitBreaker = createGatewayCircuitBreaker({ failureThreshold: 1 }); circuitBreaker.acquire(slow)!.end("retryable-error");
  const gateway = createGateway({ adapters, circuitBreaker, adaptiveRouting: { ...policy, coldStart: "allow" } });
  const result = await gateway.generate(request);
  expect(result.modelUsed).toBe("plain"); expect(result.routeDecision.adaptive?.candidates[0]?.exclusions).toContain("circuit-open");
});
it("preserves request order on ties and refuses ambiguous configuration", async () => {
  const gateway = createGateway({ adapters, adaptiveRouting: { ...policy, coldStart: "allow" } });
  expect((await gateway.generate({ ...request, primary: fast, fallbacks: [slow] })).modelUsed).toBe("plain");
  expect(() => createGateway({ adapters, adaptiveRouting: policy, scoreTarget: () => 1 })).toThrow("Choose adaptiveRouting");
});
