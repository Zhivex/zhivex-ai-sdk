import { defineModelCatalogFragment } from "../fragment.js";

export const metaCatalogFragment = defineModelCatalogFragment({
  provider: "meta",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "meta",
      "modelId": "muse-spark-1.2",
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
      "provider": "meta",
      "modelId": "muse-spark-1.2-contributor",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "meta",
      "modelId": "muse-spark-1.1",
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
    }
  ]
});
