import { defineModelCatalogFragment } from "../fragment.js";

const k31VerifiedAt = "2026-10-24";
const k31PricingSource = "https://platform.kimi.ai/docs/pricing/chat";
const k31Quickstart = "https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart";
const k31WindowSource = "https://platform.kimi.ai/docs/guide/troubleshooting";

/**
 * Prices are USD per 1k tokens. Upstream publishes USD per 1M tokens.
 * `cacheWriteCostPer1kTokens` is the default 5-minute write rate. The 1-hour
 * write rate is also documented ($4 / MTok for Pro, $8 / MTok for Highspeed)
 * and is not a second catalog field.
 */
const k31Evidence = {
  contextWindowTokens: { source: k31PricingSource, sourceType: "primary" as const, verifiedAt: k31VerifiedAt },
  contextWindowType: { source: k31WindowSource, sourceType: "primary" as const, verifiedAt: k31VerifiedAt },
  maxOutputTokens: { source: k31Quickstart, sourceType: "primary" as const, verifiedAt: k31VerifiedAt },
  inputCostPer1kTokens: { source: k31PricingSource, sourceType: "primary" as const, verifiedAt: k31VerifiedAt },
  outputCostPer1kTokens: { source: k31PricingSource, sourceType: "primary" as const, verifiedAt: k31VerifiedAt }
};

const k31Limits = {
  contextWindowTokens: 1_048_576,
  contextWindowType: "combined" as const,
  maxOutputTokens: 1_048_576,
  evidence: k31Evidence
};

export const kimiCatalogFragment = defineModelCatalogFragment({
  provider: "kimi",
  revision: "2026-10-24",
  verifiedAt: "2026-10-24",
  // Verification date for the K3.1 Pro price table. Older rows in this fragment were not repriced.
  pricingEffectiveAt: "2026-10-24",
  sources: [
    "https://platform.kimi.ai/docs/models",
    "https://platform.kimi.ai/docs/platform-changelog",
    "https://platform.kimi.ai/docs/guide/use-reasoning-effort",
    k31Quickstart,
    k31PricingSource,
    "https://platform.kimi.ai/docs/api/models-overview",
    "https://platform.kimi.ai/docs/guide/context-caching",
    "https://platform.kimi.ai/docs/guide/use-kimi-vision-model",
    "https://platform.kimi.ai/docs/guide/use-tool-choice",
    "https://platform.kimi.ai/docs/api/chat",
    k31WindowSource,
    "catalog-release:2026-08-16"],
  entries: [
    {
      provider: "kimi",
      modelId: "kimi-k3.1-pro",
      ...k31Limits,
      inputCostPer1kTokens: 0.002,
      cachedInputCostPer1kTokens: 0.0002,
      cacheWriteCostPer1kTokens: 0.002,
      outputCostPer1kTokens: 0.01,
      costPer1kTokens: 0.002,
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    },
    {
      provider: "kimi",
      modelId: "kimi-k3.1-pro-highspeed",
      ...k31Limits,
      inputCostPer1kTokens: 0.004,
      cachedInputCostPer1kTokens: 0.0002,
      cacheWriteCostPer1kTokens: 0.004,
      outputCostPer1kTokens: 0.02,
      costPer1kTokens: 0.004,
      recommendedFor: ["chat", "reasoning", "tools", "vision", "speed"]
    },
    {
      "provider": "kimi",
      "modelId": "kimi-k3",
      "inputCostPer1kTokens": 0.003,
      "cachedInputCostPer1kTokens": 0.0003,
      "outputCostPer1kTokens": 0.015,
      "costPer1kTokens": 0.003,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "kimi",
      "modelId": "kimi-k2.7-code",
      "aliases": [
        "kimi-k2.7-code-highspeed"
      ],
      "costPer1kTokens": 0.002,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    },
    {
      "provider": "kimi",
      "modelId": "kimi-k2.6",
      "costPer1kTokens": 0.002,
      "recommendedFor": [
        "chat",
        "reasoning",
        "tools",
        "vision"
      ]
    }
  ]
});
