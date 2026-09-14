import { expect, it } from "vitest";
import { calculateModelCost, createModelCatalog, type ModelCostValuation } from "../src/index.js";
it("exports a provenance-aware cost valuation", () => {
  const catalog = createModelCatalog([{ provider: "test", modelId: "fixture", inputCostPer1kTokens: 1, outputCostPer1kTokens: 2 }], { snapshotVersion: "1", pricing: { version: "1", unit: "per_1k_tokens", currency: "USD" } });
  const cost: ModelCostValuation = calculateModelCost({ catalog, provider: "test", modelId: "fixture", usage: { inputTokens: 1000, outputTokens: 1000 }, cacheAssumption: "none" });
  expect(cost.amount).toBe(3); expect(cost.status).toBe("estimated");
});
