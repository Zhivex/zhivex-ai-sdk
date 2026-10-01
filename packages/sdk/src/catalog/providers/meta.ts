import { defineModelCatalogFragment } from "../fragment.js";

export const metaCatalogFragment = defineModelCatalogFragment({
  provider: "meta",
  revision: "2026-10-01",
  verifiedAt: "2026-10-01",
  pricingEffectiveAt: "2026-08-16",
  sources: [
    "https://research.meta.ai/blog/introducing-muse-spark-1-3",
    "https://dev.meta.ai/docs/models",
    "catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "meta",
      "modelId": "muse-spark-1.3",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "meta",
      "modelId": "muse-spark-1.3-contributor",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
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
