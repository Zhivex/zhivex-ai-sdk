import { defineModelCatalogFragment } from "../fragment.js";

export const geminiCatalogFragment = defineModelCatalogFragment({
  provider: "gemini",
  revision: "2026-09-04",
  verifiedAt: "2026-09-04",
  pricingEffectiveAt: "2026-08-30",
  sources: [
    "https://ai.google.dev/gemini-api/docs/models",
    "https://ai.google.dev/gemini-api/docs/changelog",
    "https://ai.google.dev/gemini-api/docs/latest-model",
    "https://ai.google.dev/gemini-api/docs/pricing"
  ],
  entries: [
    {
      "provider": "gemini",
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
      "provider": "gemini",
      "modelId": "lyria-3.5"
    },
    {
      "provider": "gemini",
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
      "provider": "gemini",
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
      "provider": "gemini",
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
      "provider": "gemini",
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
      "provider": "gemini",
      "modelId": "gemini-3.1-pro-preview",
      "recommendedFor": [
        "chat",
        "reasoning",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.1-pro-preview-customtools",
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3-flash-preview",
      "recommendedFor": [
        "chat",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.1-flash-lite",
      "recommendedFor": [
        "chat",
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.1-flash-lite-image",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.1-flash-image",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3-pro-image",
      "recommendedFor": [
        "vision",
        "reasoning"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-2.5-flash-image",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.1-flash-live-preview",
      "recommendedFor": [
        "speed",
        "vision",
        "tools"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.5-live-translate-preview",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.5-transcribe",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.5-transcribe-live",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.1-flash-tts-preview",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-embedding-2",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-robotics-er-1.6-preview",
      "recommendedFor": [
        "vision",
        "reasoning"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "veo-3.1-generate-preview",
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "veo-3.1-fast-generate-preview",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "veo-3.1-lite-generate-preview",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-omni-1.1-flash",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-omni-flash-preview",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "lyria-3-clip-preview"
    },
    {
      "provider": "gemini",
      "modelId": "lyria-3-pro-preview"
    },
    {
      "provider": "gemini",
      "modelId": "lyria-realtime-exp",
      "recommendedFor": [
        "speed"
      ]
    }
  ]
});
