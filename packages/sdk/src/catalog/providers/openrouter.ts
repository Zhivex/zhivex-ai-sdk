import { defineModelCatalogFragment } from "../fragment.js";

export const openrouterCatalogFragment = defineModelCatalogFragment({
  provider: "openrouter",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "openrouter",
      "modelId": "meta/muse-spark-1.2",
      "inputCostPer1kTokens": 0.00125,
      "cachedInputCostPer1kTokens": 0.00015,
      "outputCostPer1kTokens": 0.00425,
      "costPer1kTokens": 0.00125,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "openrouter",
      "modelId": "meta/muse-glimmer-30b",
      "inputCostPer1kTokens": 0.00035,
      "cachedInputCostPer1kTokens": 0.00004,
      "outputCostPer1kTokens": 0.0015,
      "costPer1kTokens": 0.00035,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "openrouter",
      "modelId": "openai/gpt-4o-mini",
      "costPer1kTokens": 0.0007,
      "recommendedFor": [
        "chat",
        "tools"
      ]
    }
  ]
});
