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

it("applies an inclusive long-context threshold at the boundary", () => {
  const inclusive = createModelCatalog([{
    provider: "test",
    modelId: "inclusive",
    inputCostPer1kTokens: 2,
    cachedInputCostPer1kTokens: 0.5,
    outputCostPer1kTokens: 6,
    longContextPricing: { inputTokenThreshold: 1000, inputTokenThresholdInclusive: true, inputMultiplier: 2, outputMultiplier: 2 }
  }], { snapshotVersion: "fixture-1", pricing: { version: "price-1", currency: "USD", unit: "per_1k_tokens", source: "fixture" } });
  const atThreshold = calculateModelCost({
    catalog: inclusive,
    provider: "test",
    modelId: "inclusive",
    reasoningAccounting: "included",
    usage: { inputTokens: 1000, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 100 }
  });
  expect(atThreshold.longContext).toBe(true);
  expect(atThreshold.components.cachedInput?.ratePer1kTokens).toBe(1);
  expect(inclusive.find("test", "inclusive")?.longContextPricing?.inputTokenThresholdInclusive).toBe(true);
});

it("prices 12-hour cache writes at 2.5x input and keeps an unsplit write on the catalog rate", () => {
  const guide = createModelCatalog([{
    provider: "openai",
    modelId: "guide",
    inputCostPer1kTokens: 0.001,
    cachedInputCostPer1kTokens: 0.0001,
    cacheWriteCostPer1kTokens: 0.00125,
    outputCostPer1kTokens: 0
  }], { snapshotVersion: "fixture-1", pricing: { version: "price-1", currency: "USD", unit: "per_1k_tokens", source: "fixture" } });
  const priced = calculateModelCost({
    catalog: guide,
    provider: "openai",
    modelId: "guide",
    reasoningAccounting: "included",
    usage: {
      inputTokens: 12000,
      cachedInputTokens: 4000,
      cacheWriteTokens: 7000,
      cacheWriteTokensDetails: { ttl30mTokens: 3000, ttl12hTokens: 4000 },
      outputTokens: 0
    }
  });
  expect(priced.amount).toBeCloseTo(0.01515);
  expect(priced.components.input).toMatchObject({ tokens: 1000, amount: 0.001 });
  expect(priced.components.cachedInput).toMatchObject({ tokens: 4000, amount: 0.0004 });
  expect(priced.components.cacheWrite).toMatchObject({ tokens: 7000, amount: 0.01375 });
  expect(priced.cacheWriteDetails?.ttl30m.amount).toBeCloseTo(0.00375);
  expect(priced.cacheWriteDetails?.ttl12h.amount).toBeCloseTo(0.01);

  const plain = calculateModelCost({ ...base, usage: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 300, outputTokens: 0 } });
  const thirtyMinute = calculateModelCost({
    ...base,
    usage: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 300, cacheWriteTokensDetails: { ttl30mTokens: 300, ttl12hTokens: 0 }, outputTokens: 0 }
  });
  expect(thirtyMinute.components.cacheWrite).toEqual(plain.components.cacheWrite);
  expect(thirtyMinute.amount).toBeCloseTo(plain.amount!);

  const twelveHour = calculateModelCost({
    ...base,
    usage: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 300, cacheWriteTokensDetails: { ttl30mTokens: 0, ttl12hTokens: 300 }, outputTokens: 0 }
  });
  expect(twelveHour.components.cacheWrite?.amount).toBeCloseTo(1.5);
  expect(twelveHour.components.cacheWrite?.ratePer1kTokens).toBeCloseTo(5);

  const mixed = calculateModelCost({
    ...base,
    usage: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 300, cacheWriteTokensDetails: { ttl30mTokens: 100, ttl12hTokens: 200 }, outputTokens: 0 }
  });
  expect(mixed.components.cacheWrite?.amount).toBeCloseTo(1.3);

  const longWrite = calculateModelCost({
    ...base,
    usage: { inputTokens: 1001, cachedInputTokens: 0, cacheWriteTokens: 100, cacheWriteTokensDetails: { ttl12hTokens: 100 }, outputTokens: 0 }
  });
  expect(longWrite.longContext).toBe(true);
  expect(longWrite.components.cacheWrite?.amount).toBeCloseTo(1);

  const missingInput = createModelCatalog([{
    provider: "test", modelId: "no-input", cacheWriteCostPer1kTokens: 3, outputCostPer1kTokens: 6
  }], { snapshotVersion: "fixture-1", pricing: { version: "price-1", currency: "USD", unit: "per_1k_tokens", source: "fixture" } });
  const unknownTwelve = calculateModelCost({
    catalog: missingInput,
    provider: "test",
    modelId: "no-input",
    usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 10, cacheWriteTokensDetails: { ttl12hTokens: 10 }, outputTokens: 0 }
  });
  expect(unknownTwelve.amount).toBeNull();
  expect(unknownTwelve.unknownReasons).toContain("cacheWrite12h-price-missing");

  const noWriteRate = createModelCatalog([{
    provider: "test", modelId: "no-write", inputCostPer1kTokens: 2, cachedInputCostPer1kTokens: 0.5, outputCostPer1kTokens: 6
  }], { snapshotVersion: "fixture-1", pricing: { version: "price-1", currency: "USD", unit: "per_1k_tokens", source: "fixture" } });
  const twelveOnly = calculateModelCost({
    catalog: noWriteRate,
    provider: "test",
    modelId: "no-write",
    reasoningAccounting: "included",
    usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 40, cacheWriteTokensDetails: { ttl30mTokens: 0, ttl12hTokens: 40 }, outputTokens: 0 }
  });
  expect(twelveOnly.status).toBe("known");
  expect(twelveOnly.components.cacheWrite?.amount).toBeCloseTo(0.2);

  expect(() => calculateModelCost({
    ...base,
    usage: { inputTokens: 10, cacheWriteTokens: 4, cacheWriteTokensDetails: { ttl30mTokens: 1, ttl12hTokens: 1 }, outputTokens: 0 }
  })).toThrow(/do not match/);
  expect(() => calculateModelCost({
    ...base,
    usage: { inputTokens: 10, cacheWriteTokens: 1, cacheWriteTokensDetails: { ttl30mTokens: 1, extra: 1 } as never, outputTokens: 0 }
  })).toThrow(/cacheWriteTokensDetails/);
  expect(() => calculateModelCost({
    ...base,
    usage: { inputTokens: 10, cacheWriteTokens: 0, cacheWriteTokensDetails: {}, outputTokens: 0 }
  })).toThrow(/cacheWriteTokensDetails/);
});

it("requires explicit reasoning accounting and supports additional reasoning", () => {
  const usage = { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 5 };
  expect(calculateModelCost({ ...base, usage, reasoningAccounting: undefined }).amount).toBeNull();
  expect(calculateModelCost({ ...base, usage, reasoningAccounting: "included" }).amount).toBeCloseTo(.26);
  expect(calculateModelCost({ ...base, usage, reasoningAccounting: "additional" }).amount).toBeCloseTo(.29);
});
