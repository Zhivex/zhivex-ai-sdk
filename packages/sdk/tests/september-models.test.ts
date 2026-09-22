import { expect, it } from "vitest";
import { defaultModelCatalog } from "../src/index.js";

it.each([
  ["openai", "gpt-6-sol", 0.002, 0.0002, 0.0025, 0.01],
  ["openai", "gpt-6-luna", 0.0001, 0.00001, 0.000125, 0.0005],
  ["anthropic", "claude-opus-5-5", 0.004, 0.0002, 0.005, 0.02],
] as const)("publishes verified per-1k pricing for %s/%s", (provider, modelId, input, cached, write, output) => {
  expect(defaultModelCatalog.find(provider, modelId)).toMatchObject({
    provider, modelId, inputCostPer1kTokens: input, cachedInputCostPer1kTokens: cached,
    cacheWriteCostPer1kTokens: write, outputCostPer1kTokens: output,
  });
  if (provider === "openai") {
    expect(defaultModelCatalog.find(provider, modelId)?.longContextPricing).toEqual({ inputTokenThreshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5 });
  }
});
