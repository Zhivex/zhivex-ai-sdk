import { expect, it } from "vitest";
import { defaultModelCatalog as catalog } from "../src/catalog.js";
it("captures verified current provider rates and promotion terms without substituting future rates", () => {
  for (const [provider, id, input, cached, output] of [
    ["openai", "gpt-5.6-sol", .004, .0004, .02],
    ["meta", "muse-spark-1.3", .00125, .00015, .00425],
    ["meta", "muse-spark-1.3-contributor", .0001, .000002, .0002],
    ["zai", "glm-5.3", .0014, .00026, .0044],
    ["zai", "glm-5.3-flashx", .00037, .000075, .00125],
    ["zai", "glm-5.3-flashx-legal", .00037, .000075, .00125],
    ["gemini", "gemini-4-argon", .002, .0001, .01],
    ["gemini", "gemini-3.8-flash", .00075, .000075, .00375]
  ] as const) expect(catalog.find(provider, id)).toMatchObject({ inputCostPer1kTokens: input, cachedInputCostPer1kTokens: cached, outputCostPer1kTokens: output });
  expect(catalog.find("openai", "gpt-5.6-sol")).toMatchObject({ cacheWriteCostPer1kTokens: .005, pricingTerms: { guaranteedThrough: "2026-11-21" } });
  expect(catalog.find("openai", "gpt-5.6-sol")?.pricingTerms).not.toHaveProperty("validThrough");
  expect(catalog.find("gemini", "gemini-4-argon")?.pricingTerms?.validThrough).toBe("2026-11-30");
  expect(catalog.find("gemini", "gemini-3.8-flash")?.pricingTerms?.validThrough).toBe("2026-12-31");
  for (const model of ["qwen-audio-3.1-tts-flash", "qwen-audio-3.1-tts-plus", "qwen-audio-3.1-tts-next"]) expect(catalog.find("qwen", model)).toBeDefined();
});
