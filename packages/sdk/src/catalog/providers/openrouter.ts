import { defineModelCatalogFragment } from "../fragment.js";

export const openrouterCatalogFragment = defineModelCatalogFragment({
  provider: "openrouter",
  revision: "2026-10-16",
  verifiedAt: "2026-10-16",
  pricingEffectiveAt: "2026-10-16",
  sources: [
    "https://openrouter.ai/api/v1/models",
    "https://openrouter.ai/meta/muse-spark-open",
    "https://research.meta.ai/blog/muse-spark-open",
    "https://dev.meta.ai/docs/muse-spark-open",
    "catalog-release:2026-08-16"
  ],
  entries: [
    {
      "provider": "openrouter",
      "modelId": "openai/gpt-6.1-sol",
      "inputCostPer1kTokens": 0.002,
      "cachedInputCostPer1kTokens": 0.0001,
      "cacheWriteCostPer1kTokens": 0.0025,
      "outputCostPer1kTokens": 0.01,
      "longContextPricing": {
        "inputTokenThreshold": 272000,
        "inputMultiplier": 2,
        "outputMultiplier": 1.5
      },
      "recommendedFor": ["chat", "reasoning", "tools", "vision"]
    },
    {
      "provider": "openrouter",
      "modelId": "anthropic/claude-sonnet-5.5",
      "inputCostPer1kTokens": 0.002,
      "cachedInputCostPer1kTokens": 0.0001,
      "cacheWriteCostPer1kTokens": 0.0025,
      "outputCostPer1kTokens": 0.01,
      "recommendedFor": ["chat", "reasoning", "tools", "vision"]
    },
    {
      "provider": "openrouter",
      "modelId": "anthropic/claude-haiku-5.5",
      "inputCostPer1kTokens": 0.0001,
      "cachedInputCostPer1kTokens": 0.00001,
      "cacheWriteCostPer1kTokens": 0.000125,
      "outputCostPer1kTokens": 0.0005,
      "longContextPricing": {
        "inputTokenThreshold": 100000,
        "inputMultiplier": 5,
        "outputMultiplier": 5
      },
      "recommendedFor": ["chat", "reasoning", "speed", "tools", "vision"]
    },
    {
      "provider": "openrouter",
      "modelId": "x-ai/grok-4.7",
      "inputCostPer1kTokens": 0.002,
      "cachedInputCostPer1kTokens": 0.0005,
      "outputCostPer1kTokens": 0.006,
      "longContextPricing": {
        "inputTokenThreshold": 200000,
        "inputMultiplier": 2,
        "outputMultiplier": 2
      },
      "recommendedFor": ["chat", "reasoning", "tools", "vision"]
    },
    {
      "provider": "openrouter",
      "modelId": "meta/muse-wonder",
      "inputCostPer1kTokens": 0.004,
      "cachedInputCostPer1kTokens": 0.0002,
      "outputCostPer1kTokens": 0.02,
      "recommendedFor": ["chat", "reasoning", "tools", "vision"]
    },
    {
      "provider": "openrouter",
      "modelId": "google/gemini-3.8-flash",
      "inputCostPer1kTokens": 0.00075,
      "cachedInputCostPer1kTokens": 0.000075,
      "outputCostPer1kTokens": 0.00375,
      "recommendedFor": ["chat", "reasoning", "speed", "tools", "vision"]
    },
    {
      "provider": "openrouter",
      "modelId": "google/gemini-nano-banana-2.1",
      "recommendedFor": ["vision"]
    },
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
      "modelId": "meta/muse-spark-open",
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
      "costPer1kTokens": 0.0007
    }
  ]
});
