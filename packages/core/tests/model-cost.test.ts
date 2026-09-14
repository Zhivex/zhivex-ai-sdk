import { expect, it } from "vitest";
import { createModelCatalog } from "../src/catalog.js";
import { calculateModelCost } from "../src/model-cost.js";
const catalog = createModelCatalog([{ provider: "test", modelId: "model", inputCostPer1kTokens: 2, cachedInputCostPer1kTokens: .5, cacheWriteCostPer1kTokens: 3, outputCostPer1kTokens: 6, longContextPricing: { inputTokenThreshold: 1000, inputMultiplier: 2, outputMultiplier: 1.5 } }], { snapshotVersion: "fixture-1", pricing: { version: "price-1", currency: "USD", unit: "per_1k_tokens", source: "fixture" } });
const base = { catalog, provider: "test", modelId: "model", reasoningAccounting: "included" as const };
it("values cache without double counting input and reasoning", () => {
  const value = calculateModelCost({ ...base, usage: { inputTokens: 1000, cachedInputTokens: 200, cacheWriteTokens: 100, outputTokens: 100, reasoningTokens: 40, totalTokens: 1100 } });
  expect(value.amount).toBeCloseTo(2.4); expect(value.status).toBe("known"); expect(value.longContext).toBe(false);
  expect(value.components.input?.tokens).toBe(700); expect(value.currency).toBe("USD");
  const longer = calculateModelCost({ ...base, usage: { inputTokens: 1001, cachedInputTokens: 200, cacheWriteTokens: 100, outputTokens: 100 } });
  expect(longer.amount).toBeCloseTo(4.504); expect(longer.longContext).toBe(true);
});
it("distinguishes unknown counters, prices, and absent provenance from free usage", () => {
  expect(calculateModelCost(base).amount).toBeNull();
  expect(() => calculateModelCost({ ...base, unknownPolicy: "reject" })).toThrow("unknown");
  expect(calculateModelCost({ ...base, modelId: "missing", usage: { inputTokens: 100, outputTokens: 20 }, cacheAssumption: "none" }).amount).toBeNull();
  expect(calculateModelCost({ ...base, usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }).amount).toBe(0);
  expect(calculateModelCost({ ...base, usage: { inputTokens: 100, outputTokens: 20 }, cacheAssumption: "none" }).status).toBe("estimated");
});
it("rejects impossible counters and keeps fast-tier costs unknown", () => {
  expect(() => calculateModelCost({ ...base, usage: { inputTokens: 10, cachedInputTokens: 20 } })).toThrow();
  expect(() => calculateModelCost({ ...base, usage: { inputTokens: NaN } })).toThrow();
  expect(calculateModelCost({ ...base, usage: { inputTokens: 10, outputTokens: 10, speed: "fast" }, cacheAssumption: "none" }).amount).toBeNull();
});

it("requires explicit reasoning accounting and supports additional reasoning", () => {
  const usage = { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 5 };
  expect(calculateModelCost({ ...base, usage, reasoningAccounting: undefined }).amount).toBeNull();
  expect(calculateModelCost({ ...base, usage, reasoningAccounting: "included" }).amount).toBeCloseTo(.26);
  expect(calculateModelCost({ ...base, usage, reasoningAccounting: "additional" }).amount).toBeCloseTo(.29);
});
