import { defineModelCatalogFragment } from "../fragment.js";

export const azureOpenaiCatalogFragment = defineModelCatalogFragment({
  provider: "azure-openai",
  revision: "2026-10-15",
  verifiedAt: "2026-10-15",
  pricingEffectiveAt: "2026-08-16",
  sources: [
    "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure",
    "https://developers.openai.com/api/docs/deprecations",
    "catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "azure-openai",
      "modelId": "gpt-6.1-sol",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-6-sol",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-6-luna",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-6-astra",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-5.4",
      "recommendedFor": ["chat", "reasoning", "tools", "vision"]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-5.4-pro",
      "recommendedFor": ["chat", "reasoning", "tools", "vision"]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-5.4-mini",
      "recommendedFor": ["chat", "reasoning", "tools", "vision"]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-5.4-nano",
      "recommendedFor": ["chat", "reasoning", "speed", "tools", "vision"]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-5",
      "recommendedFor": ["chat", "reasoning", "tools", "vision"]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-5-mini",
      "recommendedFor": ["chat", "reasoning", "speed", "tools", "vision"]
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-5-nano",
      "recommendedFor": ["chat", "reasoning", "speed", "tools", "vision"]
    },
    {
      "provider": "azure-openai",
      "modelId": "text-embedding-3-small"
    },
    {
      "provider": "azure-openai",
      "modelId": "text-embedding-3-large"
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-4o-mini-tts"
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-4o-mini-transcribe"
    },
    {
      "provider": "azure-openai",
      "modelId": "gpt-4o-mini",
      "costPer1kTokens": 0.0006,
      "lifecycle": {
        "deprecatedAt": "2026-10-14",
        "retiredAt": "2027-01-14",
        "source": "https://developers.openai.com/api/docs/deprecations"
      }
    }
  ]
});
