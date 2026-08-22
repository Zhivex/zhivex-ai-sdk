import { defineModelCatalogFragment } from "../fragment.js";

export const ollamaCatalogFragment = defineModelCatalogFragment({
  provider: "ollama",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
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
