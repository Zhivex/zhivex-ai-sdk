import { defineModelCatalogFragment } from "../fragment.js";

export const deepseekCatalogFragment = defineModelCatalogFragment({
  provider: "deepseek",
  revision: "2026-08-30",
  verifiedAt: "2026-08-30",
  pricingEffectiveAt: "2026-08-30",
  sources: [
    "https://api-docs.deepseek.com/news/news260821",
    "https://api-docs.deepseek.com/guides/vision/",
    "https://api-docs.deepseek.com/guides/files_api/",
    "https://api-docs.deepseek.com/quick_start/pricing"
  ],
  entries: [
    {
      "provider": "deepseek",
      "modelId": "deepseek-v4-flash-vision-exp",
      "inputCostPer1kTokens": 0.00014,
      "cachedInputCostPer1kTokens": 0.0000028,
      "outputCostPer1kTokens": 0.00028,
      "costPer1kTokens": 0.00014,
      "recommendedFor": [
        "chat",
        "reasoning",
        "vision",
        "speed",
        "tools"
      ]
    },
    {
      "provider": "deepseek",
      "modelId": "deepseek-v4-flash",
      "inputCostPer1kTokens": 0.00014,
      "cachedInputCostPer1kTokens": 0.0000028,
      "outputCostPer1kTokens": 0.00028,
      "costPer1kTokens": 0.00014,
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning",
        "speed"
      ]
    },
    {
      "provider": "deepseek",
      "modelId": "deepseek-v4-pro",
      "inputCostPer1kTokens": 0.000435,
      "cachedInputCostPer1kTokens": 0.000003625,
      "outputCostPer1kTokens": 0.00087,
      "costPer1kTokens": 0.000435,
      "recommendedFor": [
        "chat",
        "tools",
        "reasoning"
      ]
    }
  ]
});
