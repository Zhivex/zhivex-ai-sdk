import { defineModelCatalogFragment } from "../fragment.js";

export const openaiCatalogFragment = defineModelCatalogFragment({
  provider: "openai",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "openai",
      "modelId": "gpt-5.6-sol",
      "aliases": [
        "gpt-5.6"
      ],
      "inputCostPer1kTokens": 0.005,
      "cachedInputCostPer1kTokens": 0.0005,
      "cacheWriteCostPer1kTokens": 0.00625,
      "outputCostPer1kTokens": 0.03,
      "costPer1kTokens": 0.005,
      "longContextPricing": {
        "inputTokenThreshold": 272000,
        "inputMultiplier": 2,
        "outputMultiplier": 1.5
      },
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-5.6-terra",
      "inputCostPer1kTokens": 0.002,
      "cachedInputCostPer1kTokens": 0.0002,
      "cacheWriteCostPer1kTokens": 0.0025,
      "outputCostPer1kTokens": 0.012,
      "costPer1kTokens": 0.002,
      "longContextPricing": {
        "inputTokenThreshold": 272000,
        "inputMultiplier": 2,
        "outputMultiplier": 1.5
      },
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-5.6-luna",
      "inputCostPer1kTokens": 0.0002,
      "cachedInputCostPer1kTokens": 0.00002,
      "cacheWriteCostPer1kTokens": 0.00025,
      "outputCostPer1kTokens": 0.0012,
      "costPer1kTokens": 0.0002,
      "longContextPricing": {
        "inputTokenThreshold": 272000,
        "inputMultiplier": 2,
        "outputMultiplier": 1.5
      },
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-5.5",
      "costPer1kTokens": 0.005,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-5.4",
      "costPer1kTokens": 0.0025,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-5.4-mini",
      "costPer1kTokens": 0.00075,
      "recommendedFor": [
        "chat",
        "tools",
        "speed",
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-4o-mini",
      "costPer1kTokens": 0.0006,
      "recommendedFor": [
        "chat",
        "tools",
        "speed"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-image-2",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-realtime-2.1",
      "recommendedFor": [
        "chat",
        "tools",
        "speed",
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-realtime-2.1-mini",
      "recommendedFor": [
        "chat",
        "tools",
        "speed",
        "vision"
      ]
    }
  ]
});
