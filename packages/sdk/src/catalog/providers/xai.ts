import { defineModelCatalogFragment } from "../fragment.js";

export const xaiCatalogFragment = defineModelCatalogFragment({
  provider: "xai",
  revision: "2026-08-30",
  verifiedAt: "2026-08-30",
  pricingEffectiveAt: "2026-08-30",
  sources: [
    "https://docs.x.ai/developers/grok-4-6",
    "https://docs.x.ai/developers/model-capabilities/text/reasoning"
  ],
  entries: [
    {
      "provider": "xai",
      "modelId": "grok-4.6",
      "inputCostPer1kTokens": 0.002,
      "outputCostPer1kTokens": 0.006,
      "costPer1kTokens": 0.002,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
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
