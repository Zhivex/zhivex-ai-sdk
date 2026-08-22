import { defineModelCatalogFragment } from "../fragment.js";

export const anthropicCatalogFragment = defineModelCatalogFragment({
  provider: "anthropic",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "anthropic",
      "modelId": "claude-sonnet-5",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "anthropic",
      "modelId": "claude-fable-5",
      "aliases": [
        "claude-mythos-class"
      ],
      "costPer1kTokens": 0.01,
      "recommendedFor": [
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "anthropic",
      "modelId": "claude-mythos-5",
      "costPer1kTokens": 0.01,
      "recommendedFor": [
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "anthropic",
      "modelId": "claude-opus-5",
      "inputCostPer1kTokens": 0.005,
      "cachedInputCostPer1kTokens": 0.0005,
      "cacheWriteCostPer1kTokens": 0.00625,
      "outputCostPer1kTokens": 0.025,
      "costPer1kTokens": 0.005,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "anthropic",
      "modelId": "claude-opus-4-8",
      "aliases": [
        "claude-opus-4-7"
      ],
      "costPer1kTokens": 0.005,
      "recommendedFor": [
        "reasoning",
        "tools"
      ]
    },
    {
      "provider": "anthropic",
      "modelId": "claude-haiku-4-5-20251001",
      "aliases": [
        "claude-haiku-4-5"
      ],
      "costPer1kTokens": 0.001,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision"
      ]
    }
  ]
});
