import { defineModelCatalogFragment } from "../fragment.js";

export const openaiCatalogFragment = defineModelCatalogFragment({
  provider: "openai",
  revision: "2026-11-07",
  verifiedAt: "2026-11-07",
  pricingEffectiveAt: "2026-11-07",
  sources: [
    "https://developers.openai.com/api/docs/models/gpt-4o-mini",
    "https://developers.openai.com/api/docs/deprecations",
    "https://developers.openai.com/api/docs/guides/conversation-state",
    "https://developers.openai.com/api/docs/models/gpt-6-sol",
    "https://developers.openai.com/api/docs/models/gpt-6-luna",
    "https://developers.openai.com/api/docs/models/gpt-6-astra",
    "https://developers.openai.com/api/docs/models/gpt-6-cyber",
    "https://developers.openai.com/api/docs/guides/daybreak",
    "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    "https://developers.openai.com/api/docs/models/gpt-6.1-terra",
    "https://developers.openai.com/api/docs/pricing",
    "https://openai.com/index/introducing-gpt-6-1-terra",
    "https://developers.openai.com/api/docs/models/gpt-image-2.5-flare",
    "https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst",
    "https://developers.openai.com/api/docs/models/gpt-image-2.6-flare",
    "https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst",
    "https://developers.openai.com/api/docs/guides/image-generation",
    "https://developers.openai.com/api/docs/guides/image-prompting",
    "catalog-release:2026-08-16",
    "https://developers.openai.com/api/docs/guides/live"],
  entries: [
    {
      "provider": "openai",
      "modelId": "gpt-6.1-terra",
      "contextWindowTokens": 1050000,
      "contextWindowType": "combined",
      "maxInputTokens": 922000,
      "maxOutputTokens": 128000,
      "evidence": {
        "contextWindowTokens": { "source": "https://developers.openai.com/api/docs/models/gpt-6.1-terra", "sourceType": "primary", "verifiedAt": "2026-10-26" },
        "contextWindowType": { "source": "https://developers.openai.com/api/docs/models/gpt-6.1-terra", "sourceType": "primary", "verifiedAt": "2026-10-26" },
        "maxInputTokens": { "source": "https://developers.openai.com/api/docs/models/gpt-6.1-terra", "sourceType": "primary", "verifiedAt": "2026-10-26" },
        "maxOutputTokens": { "source": "https://developers.openai.com/api/docs/models/gpt-6.1-terra", "sourceType": "primary", "verifiedAt": "2026-10-26" },
        "inputCostPer1kTokens": { "source": "https://developers.openai.com/api/docs/pricing", "sourceType": "primary", "verifiedAt": "2026-10-26" },
        "outputCostPer1kTokens": { "source": "https://developers.openai.com/api/docs/pricing", "sourceType": "primary", "verifiedAt": "2026-10-26" }
      },
      "inputCostPer1kTokens": 0.001,
      "cachedInputCostPer1kTokens": 0.00005,
      "cacheWriteCostPer1kTokens": 0.00125,
      "outputCostPer1kTokens": 0.005,
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
      "modelId": "gpt-6.1-sol",
      "contextWindowTokens": 1050000,
      "contextWindowType": "combined",
      "maxInputTokens": 922000,
      "maxOutputTokens": 128000,
      "evidence": {
        "contextWindowTokens": { "source": "https://developers.openai.com/api/docs/models/gpt-6.1-sol", "sourceType": "primary", "verifiedAt": "2026-10-13" },
        "contextWindowType": { "source": "https://developers.openai.com/api/docs/models/gpt-6.1-sol", "sourceType": "primary", "verifiedAt": "2026-10-13" },
        "maxInputTokens": { "source": "https://developers.openai.com/api/docs/models/gpt-6.1-sol", "sourceType": "primary", "verifiedAt": "2026-10-13" },
        "maxOutputTokens": { "source": "https://developers.openai.com/api/docs/models/gpt-6.1-sol", "sourceType": "primary", "verifiedAt": "2026-10-13" }
      },
      "inputCostPer1kTokens": 0.002,
      "cachedInputCostPer1kTokens": 0.0001,
      "cacheWriteCostPer1kTokens": 0.0025,
      "outputCostPer1kTokens": 0.01,
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
      "modelId": "gpt-6-sol",
      "inputCostPer1kTokens": 0.002,
      "cachedInputCostPer1kTokens": 0.0002,
      "cacheWriteCostPer1kTokens": 0.0025,
      "outputCostPer1kTokens": 0.01,
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
      "modelId": "gpt-6-luna",
      "inputCostPer1kTokens": 0.0001,
      "cachedInputCostPer1kTokens": 1e-05,
      "cacheWriteCostPer1kTokens": 0.000125,
      "outputCostPer1kTokens": 0.0005,
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
      "modelId": "gpt-6-cyber",
      "contextWindowTokens": 1050000,
      "contextWindowType": "combined",
      "maxInputTokens": 922000,
      "maxOutputTokens": 128000,
      "evidence": {
        "contextWindowTokens": { "source": "https://developers.openai.com/api/docs/models/gpt-6-cyber", "sourceType": "primary", "verifiedAt": "2026-11-07" },
        "contextWindowType": { "source": "https://developers.openai.com/api/docs/models/gpt-6-cyber", "sourceType": "primary", "verifiedAt": "2026-11-07" },
        "maxInputTokens": { "source": "https://developers.openai.com/api/docs/models/gpt-6-cyber", "sourceType": "primary", "verifiedAt": "2026-11-07" },
        "maxOutputTokens": { "source": "https://developers.openai.com/api/docs/models/gpt-6-cyber", "sourceType": "primary", "verifiedAt": "2026-11-07" },
        "inputCostPer1kTokens": { "source": "https://developers.openai.com/api/docs/pricing", "sourceType": "primary", "verifiedAt": "2026-11-07" },
        "outputCostPer1kTokens": { "source": "https://developers.openai.com/api/docs/pricing", "sourceType": "primary", "verifiedAt": "2026-11-07" }
      },
      "inputCostPer1kTokens": 0.02,
      "cachedInputCostPer1kTokens": 0.002,
      "cacheWriteCostPer1kTokens": 0.025,
      "outputCostPer1kTokens": 0.1,
      "pricingTerms": {
        "source": "https://developers.openai.com/api/docs/pricing",
        "verifiedAt": "2026-11-07",
        "notes": "Short-context prices. cacheWriteCostPer1kTokens is the 30-minute write tier at $25 per 1M tokens. 12-hour writes are $50 per 1M tokens. Long-context prices are unpublished. Daybreak Red plus separate model approval is required."
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
      "modelId": "gpt-live-1"
    },
    {
      "provider": "openai",
      "modelId": "gpt-6-astra",
      "inputCostPer1kTokens": 0.01,
      "cachedInputCostPer1kTokens": 0.001,
      "cacheWriteCostPer1kTokens": 0.0125,
      "outputCostPer1kTokens": 0.05,
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
      "modelId": "gpt-5.6-sol",
      pricingTerms: { source: "https://developers.openai.com/api/docs/pricing", verifiedAt: "2026-11-04", guaranteedThrough: "2026-11-21", notes: "Promotional rates; no end date confirmed. Cache write rate is the 30-minute tier ($10/M for 12 hours)." },
      "aliases": [
        "gpt-5.6"
      ],
      "inputCostPer1kTokens": 0.004,
      "cachedInputCostPer1kTokens": 0.0004,
      "cacheWriteCostPer1kTokens": 0.005,
      "outputCostPer1kTokens": 0.02,
      "costPer1kTokens": 0.004,
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
      "cachedInputCostPer1kTokens": 2e-05,
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

      "contextWindowTokens": 128000,
      "contextWindowType": "combined",
      "maxOutputTokens": 16384,
      "inputCostPer1kTokens": 0.00015,
      "outputCostPer1kTokens": 0.0006,
      "compaction": {"status": "candidate"},
      "evidence": {"contextWindowTokens": {"source": "https://developers.openai.com/api/docs/models/gpt-4o-mini", "sourceType": "primary", "verifiedAt": "2026-09-24"}, "contextWindowType": {"source": "https://developers.openai.com/api/docs/guides/conversation-state", "sourceType": "primary", "verifiedAt": "2026-09-24"}, "maxOutputTokens": {"source": "https://developers.openai.com/api/docs/models/gpt-4o-mini", "sourceType": "primary", "verifiedAt": "2026-09-24"}, "inputCostPer1kTokens": {"source": "https://developers.openai.com/api/docs/models/gpt-4o-mini", "sourceType": "primary", "verifiedAt": "2026-09-24"}, "outputCostPer1kTokens": {"source": "https://developers.openai.com/api/docs/models/gpt-4o-mini", "sourceType": "primary", "verifiedAt": "2026-09-24"}},
      "costPer1kTokens": 0.0006,
      "lifecycle": {
        "deprecatedAt": "2026-10-14",
        "retiredAt": "2027-01-14",
        "source": "https://developers.openai.com/api/docs/deprecations"
      }
    },
    {
      "provider": "openai",
      "modelId": "gpt-image-2.6-flare",
      "pricingTerms": {
        "source": "https://developers.openai.com/api/docs/pricing",
        "verifiedAt": "2026-11-07",
        "notes": "Text input $5/MTok and cached text $1.25/MTok. Image input $8/MTok, cached image input $2/MTok, and image output $30/MTok. Those rates are not stored as one text-token price."
      },
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-image-2.6-sunburst",
      "pricingTerms": {
        "source": "https://developers.openai.com/api/docs/pricing",
        "verifiedAt": "2026-11-07",
        "notes": "Text input $5/MTok and cached text $1.25/MTok. Image input $8/MTok, cached image input $2/MTok, and image output $30/MTok. Those rates are not stored as one text-token price."
      },
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-image-2.5-flare",
      "aliases": [
        "gpt-image-2.5-flare-2026-09-08"
      ],
      "recommendedFor": [
        "vision"
      ]
    },
    {
      "provider": "openai",
      "modelId": "gpt-image-2.5-sunburst",
      "aliases": [
        "gpt-image-2.5-sunburst-2026-09-08"
      ],
      "recommendedFor": [
        "vision"
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
