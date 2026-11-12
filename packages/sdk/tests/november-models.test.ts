import { expect, it } from "vitest";
import { defaultModelCatalog } from "../src/catalog.js";

it("records November models with current direct-host prices and conservative output limits", () => {
  for (const modelId of ["claude-fable-5-2", "claude-mythos-5-2"]) {
    expect(defaultModelCatalog.find("anthropic", modelId)).toMatchObject({ inputCostPer1kTokens: .008, cachedInputCostPer1kTokens: .0002, outputCostPer1kTokens: .04, maxOutputTokens: 128000 });
    expect(defaultModelCatalog.find("vertex", modelId)?.inputCostPer1kTokens).toBeUndefined();
    expect(defaultModelCatalog.find("bedrock", `global.anthropic.${modelId}`)).toBeDefined();
  }
  expect(defaultModelCatalog.find("gemini", "gemini-4-carbon")).toMatchObject({ contextWindowTokens: 1048576, contextWindowType: "combined", maxOutputTokens: 65536, inputCostPer1kTokens: .002, cachedInputCostPer1kTokens: .0001, outputCostPer1kTokens: .01, pricingTerms: { validThrough: "2026-11-30" } });
  expect(defaultModelCatalog.find("gemini", "gemini-omni-1.2-flash")).toBeDefined();
  expect(defaultModelCatalog.find("gemini", "gemini-omni-1.1-flash")).toBeDefined();
});

it.each(["gemini", "vertex"])("records Hydrogen limits and standard prices on %s", (provider) => {
  const entry = defaultModelCatalog.find(provider, "gemini-4-hydrogen");
  expect(entry).toMatchObject({ contextWindowTokens: 1048576, contextWindowType: "combined", maxOutputTokens: 65536,
    inputCostPer1kTokens: .0015, cachedInputCostPer1kTokens: .000075, outputCostPer1kTokens: .0075,
    pricingTerms: { verifiedAt: "2026-11-12" } });
  expect(entry?.pricingTerms?.validThrough).toBeUndefined();
  if (provider === "vertex") expect(entry?.pricingTerms?.notes).toContain("Non-global");
});
