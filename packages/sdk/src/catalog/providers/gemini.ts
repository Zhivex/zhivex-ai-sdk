import { defineModelCatalogFragment } from "../fragment.js";

export const geminiCatalogFragment = defineModelCatalogFragment({
  provider: "gemini",
  revision: "2026-10-19",
  verifiedAt: "2026-10-19",
  pricingEffectiveAt: "2026-08-30",
  sources: [
    "https://ai.google.dev/gemini-api/docs/models",
    "https://ai.google.dev/gemini-api/docs/changelog",
    "https://ai.google.dev/gemini-api/docs/latest-model",
    "https://ai.google.dev/gemini-api/docs/pricing",
    "https://ai.google.dev/gemini-api/docs/deprecations"
  ],
  entries: [
    {
      provider: "gemini",
      modelId: "gemini-4-argon",
      // Current introductory price through 2026-11-30. The catalog stores one rate;
      // from 2026-12-01 the published price is $4/$20 per 1M tokens and $0.20 cached.
      inputCostPer1kTokens: 0.002,
      cachedInputCostPer1kTokens: 0.0001,
      outputCostPer1kTokens: 0.01,
      recommendedFor: ["chat", "reasoning", "vision", "tools"]
    },
    { provider: "gemini", modelId: "gemini-3.8-live" },
    { provider: "gemini", modelId: "gemini-3.8-live-extended-thinking" },
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
      "modelId": "gemini-nano-banana-2.1",
      "recommendedFor": [
        "vision",
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.8-flash-tts",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.8-flash-lite-tts",
      "recommendedFor": [
        "speed"
      ]
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.7-flash",
      "inputCostPer1kTokens": 0.0015,
      "cachedInputCostPer1kTokens": 0.00015,
      "outputCostPer1kTokens": 0.0075,
      "lifecycle": {
        "deprecatedAt": "2026-10-08",
        "source": "https://ai.google.dev/gemini-api/docs/changelog"
      }
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
      "lifecycle": {
        "deprecatedAt": "2026-10-08",
        "source": "https://ai.google.dev/gemini-api/docs/changelog"
      }
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
      "lifecycle": {
        "deprecatedAt": "2026-10-06",
        "source": "https://ai.google.dev/gemini-api/docs/changelog"
      }
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
      "lifecycle": {
        "retiredAt": "2027-03-15",
        "source": "https://ai.google.dev/gemini-api/docs/deprecations"
      }
    },
    {
      "provider": "gemini",
      "modelId": "gemini-3.1-flash-live-preview",
      "lifecycle": {
        "retiredAt": "2026-11-17",
        "source": "https://ai.google.dev/gemini-api/docs/deprecations"
      }
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
      "lifecycle": {
        "retiredAt": "2026-11-17",
        "source": "https://ai.google.dev/gemini-api/docs/deprecations"
      }
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
      "lifecycle": {
        "retiredAt": "2026-08-31",
        "source": "https://ai.google.dev/gemini-api/docs/deprecations"
      }
    },
    {
      "provider": "gemini",
      "modelId": "veo-3.1-generate-preview",
      "lifecycle": {
        "retiredAt": "2026-10-22",
        "source": "https://ai.google.dev/gemini-api/docs/deprecations"
      }
    },
    {
      "provider": "gemini",
      "modelId": "veo-3.1-fast-generate-preview",
      "lifecycle": {
        "retiredAt": "2026-10-22",
        "source": "https://ai.google.dev/gemini-api/docs/deprecations"
      }
    },
    {
      "provider": "gemini",
      "modelId": "veo-3.1-lite-generate-preview",
      "lifecycle": {
        "retiredAt": "2026-10-22",
        "source": "https://ai.google.dev/gemini-api/docs/deprecations"
      }
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
      "lifecycle": {
        "deprecatedAt": "2026-09-30",
        "retiredAt": "2026-10-22",
        "source": "https://ai.google.dev/gemini-api/docs/deprecations"
      }
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
