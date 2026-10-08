import { expect, it } from "vitest";
import { defaultModelCatalog } from "../src/index.js";

it.each([
  ["openai", "gpt-6-sol", 0.002, 0.0002, 0.0025, 0.01],
  ["openai", "gpt-6-luna", 0.0001, 0.00001, 0.000125, 0.0005],
  ["anthropic", "claude-sonnet-5-5", 0.002, 0.0002, 0.0025, 0.01],
  ["anthropic", "claude-opus-5-5", 0.004, 0.0002, 0.005, 0.02],
  ["anthropic", "claude-haiku-5-5", 0.0001, 0.00001, 0.000125, 0.0005],
] as const)("publishes verified per-1k pricing for %s/%s", (provider, modelId, input, cached, write, output) => {
  expect(defaultModelCatalog.find(provider, modelId)).toMatchObject({
    provider, modelId, inputCostPer1kTokens: input, cachedInputCostPer1kTokens: cached,
    cacheWriteCostPer1kTokens: write, outputCostPer1kTokens: output,
  });
  if (provider === "openai") {
    expect(defaultModelCatalog.find(provider, modelId)?.longContextPricing).toEqual({ inputTokenThreshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5 });
  }
  if (modelId === "claude-haiku-5-5") {
    expect(defaultModelCatalog.find(provider, modelId)?.longContextPricing).toEqual({ inputTokenThreshold: 100000, inputMultiplier: 5, outputMultiplier: 5 });
  }
});

it("keeps Sonnet/Haiku 5.5 cloud pricing distinct and retains Sonnet 5 / Haiku 4.5", () => {
  expect(defaultModelCatalog.find("vertex", "claude-sonnet-5-5")).toMatchObject({ provider: "vertex", modelId: "claude-sonnet-5-5" });
  expect(defaultModelCatalog.find("vertex", "claude-haiku-5-5")).toMatchObject({ provider: "vertex", modelId: "claude-haiku-5-5" });
  expect(defaultModelCatalog.find("vertex", "claude-haiku-5-5")?.inputCostPer1kTokens).toBeUndefined();
  expect(defaultModelCatalog.find("bedrock", "anthropic.claude-haiku-5-5")?.modelId).toBe("anthropic.claude-haiku-5-5");
  expect(defaultModelCatalog.find("anthropic", "claude-sonnet-5")?.modelId).toBe("claude-sonnet-5");
  expect(defaultModelCatalog.find("anthropic", "claude-haiku-4-5")?.modelId).toBe("claude-haiku-4-5-20251001");
});
