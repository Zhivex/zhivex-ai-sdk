import { defineModelCatalogFragment } from "../fragment.js";

export const zaiCatalogFragment = defineModelCatalogFragment({
  provider: "zai",
  revision: "2026-08-26",
  verifiedAt: "2026-08-26",
  pricingEffectiveAt: "2026-08-26",
  sources: [
    "https://docs.z.ai/guides/vlm/glm-5.3-flash",
    "https://docs.z.ai/guides/overview/pricing"
  ],
  entries: [
    {
      "provider": "zai",
      "modelId": "glm-5.3-flash",
      "inputCostPer1kTokens": 0.00015,
      "cachedInputCostPer1kTokens": 0.00003,
      "outputCostPer1kTokens": 0.0005,
      "costPer1kTokens": 0.00015,
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning",
        "vision",
        "speed"
      ]
    },
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
