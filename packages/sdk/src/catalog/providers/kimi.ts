import { defineModelCatalogFragment } from "../fragment.js";

export const kimiCatalogFragment = defineModelCatalogFragment({
  provider: "kimi",
  revision: "2026-10-13",
  verifiedAt: "2026-10-13",
  pricingEffectiveAt: "2026-08-16",
  sources: [
    "https://platform.kimi.ai/docs/models",
    "https://platform.kimi.ai/docs/platform-changelog",
    "https://platform.kimi.ai/docs/guide/use-reasoning-effort",
    "catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "kimi",
      "modelId": "kimi-k3",
      "inputCostPer1kTokens": 0.003,
      "cachedInputCostPer1kTokens": 0.0003,
      "outputCostPer1kTokens": 0.015,
      "costPer1kTokens": 0.003,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "kimi",
      "modelId": "kimi-k2.7-code",
      "aliases": [
        "kimi-k2.7-code-highspeed"
      ],
      "costPer1kTokens": 0.002,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "kimi",
      "modelId": "kimi-k2.6",
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
