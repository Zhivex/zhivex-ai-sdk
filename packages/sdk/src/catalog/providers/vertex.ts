import { defineModelCatalogFragment } from "../fragment.js";

export const vertexCatalogFragment = defineModelCatalogFragment({
  provider: "vertex",
  revision: "2026-09-04",
  verifiedAt: "2026-09-04",
  pricingEffectiveAt: "2026-08-30",
  sources: [
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-7-flash",
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-7-flash"
  ],
  entries: [
    {
      "provider": "vertex",
      "modelId": "gemini-3.8-flash",
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.7-flash",
      "inputCostPer1kTokens": 0.0015,
      "cachedInputCostPer1kTokens": 0.00015,
      "outputCostPer1kTokens": 0.0075,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.6-flash",
      "inputCostPer1kTokens": 0.0015,
      "cachedInputCostPer1kTokens": 0.00015,
      "outputCostPer1kTokens": 0.0075,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.5-flash-lite",
      "inputCostPer1kTokens": 0.0003,
      "cachedInputCostPer1kTokens": 3e-05,
      "outputCostPer1kTokens": 0.0025,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.5-flash",
      "aliases": [
        "gemini-flash-latest"
      ],
      "inputCostPer1kTokens": 0.0015,
      "cachedInputCostPer1kTokens": 0.00015,
      "outputCostPer1kTokens": 0.009,
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.5-live-translate-preview",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-pro-preview",
      "recommendedFor": [
        "chat",
        "reasoning",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-flash-lite",
      "recommendedFor": [
        "chat",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-flash-lite-image",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-flash-image",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3-pro-image",
      "recommendedFor": [
        "vision",
        "reasoning"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-2.5-flash-image",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-live-2.5-flash-native-audio",
      "recommendedFor": [
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-3.1-flash-tts-preview",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "gemini-embedding-2",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "veo-3.1-generate-001",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "veo-3.1-fast-generate-001",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "veo-3.1-lite-generate-001",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "vertex",
      "modelId": "lyria-002"
    }
  ]
});
