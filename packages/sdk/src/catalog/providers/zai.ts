import { defineModelCatalogFragment } from "../fragment.js";

export const zaiCatalogFragment = defineModelCatalogFragment({
  provider: "zai",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "zai",
      "modelId": "glm-5.3",
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning"
      ]
    },
    {
      "provider": "zai",
      "modelId": "glm-5.2",
      "inputCostPer1kTokens": 0.0014,
      "cachedInputCostPer1kTokens": 0.00026,
      "outputCostPer1kTokens": 0.0044,
      "costPer1kTokens": 0.0014,
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning"
      ]
    }
  ]
});
