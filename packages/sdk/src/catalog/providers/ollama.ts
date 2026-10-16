import { defineModelCatalogFragment } from "../fragment.js";

export const ollamaCatalogFragment = defineModelCatalogFragment({
  provider: "ollama",
  revision: "2026-10-16",
  verifiedAt: "2026-10-16",
  pricingEffectiveAt: "2026-10-16",
  sources: [
    "https://ollama.com/library/qwen3.8",
    "https://ollama.com/library/muse-spark-open",
    "https://research.meta.ai/blog/muse-spark-open",
    "catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "ollama",
      "modelId": "qwen3.8",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "ollama",
      "modelId": "gemma4",
      "costPer1kTokens": 0,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "ollama",
      "modelId": "qwen3.5",
      "costPer1kTokens": 0,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "ollama",
      "modelId": "qwen3",
      "costPer1kTokens": 0,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools"
      ]
    },
    {
      "provider": "ollama",
      "modelId": "gpt-oss",
      "costPer1kTokens": 0,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools"
      ]
    },
    {
      "provider": "ollama",
      "modelId": "muse-glimmer:30b",
      "costPer1kTokens": 0,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "ollama",
      "modelId": "muse-glimmer:30b-mlx",
      "costPer1kTokens": 0,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "ollama",
      "modelId": "muse-spark-open",
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
      "provider": "ollama",
      "modelId": "embeddinggemma",
      "costPer1kTokens": 0
    },
    {
      "provider": "ollama",
      "modelId": "llama3.2",
      "costPer1kTokens": 0,
      "recommendedFor": [
        "chat",
        "speed"
      ]
    }
  ]
});
