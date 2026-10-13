import { defineModelCatalogFragment } from "../fragment.js";

export const metaCatalogFragment = defineModelCatalogFragment({
  provider: "meta",
  revision: "2026-10-13",
  verifiedAt: "2026-10-13",
  pricingEffectiveAt: "2026-10-13",
  sources: [
    "https://dev.meta.ai/docs/models",
    "https://dev.meta.ai/docs/pricing-rate-limits",
    "https://dev.meta.ai/resources/blog/build-with-muse-wonder",
    "https://research.meta.ai/blog/introducing-muse-spark-1-3",
    "catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "meta",
      "modelId": "muse-wonder-1.0",
      "inputCostPer1kTokens": 0.004,
      "cachedInputCostPer1kTokens": 0.0002,
      "outputCostPer1kTokens": 0.02,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
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
