import { defineModelCatalogFragment } from "../fragment.js";

export const xaiCatalogFragment = defineModelCatalogFragment({
  provider: "xai",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "xai",
      "modelId": "grok-4.5",
      "inputCostPer1kTokens": 0.002,
      "outputCostPer1kTokens": 0.006,
      "costPer1kTokens": 0.002,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    }
  ]
});
