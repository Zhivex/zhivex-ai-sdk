import { defineModelCatalogFragment } from "../fragment.js";

export const deepseekCatalogFragment = defineModelCatalogFragment({
  provider: "deepseek",
  revision: "2026-09-16",
  verifiedAt: "2026-09-16",
  sources: ["https://api-docs.deepseek.com/quick_start/pricing/", "https://api-docs.deepseek.com/guides/vision/"],
  // Peak/off-peak rates cannot be represented by a single timeless token price.
  // Leave costs unknown instead of valuing current requests with obsolete rates.
  entries: [
    {
      provider: "deepseek",
      modelId: "deepseek-flash",
      aliases: ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
      recommendedFor: ["chat", "reasoning", "vision", "speed", "tools"]
    },
    {
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      recommendedFor: ["chat", "reasoning", "tools"]
    }
  ]
});
