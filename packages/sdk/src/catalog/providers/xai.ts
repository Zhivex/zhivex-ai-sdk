import type { ModelCatalogEntry, ModelCatalogRecommendation } from "@zhivex-ai/core";

import { defineModelCatalogFragment } from "../fragment.js";

const modelsSource = "https://docs.x.ai/docs/models";
const verifiedAt = "2026-10-14";

const priceEvidence = {
  contextWindowTokens: { source: modelsSource, sourceType: "primary" as const, verifiedAt },
  contextWindowType: { source: modelsSource, sourceType: "primary" as const, verifiedAt },
  inputCostPer1kTokens: { source: modelsSource, sourceType: "primary" as const, verifiedAt },
  outputCostPer1kTokens: { source: modelsSource, sourceType: "primary" as const, verifiedAt },
  longContextPricing: { source: modelsSource, sourceType: "primary" as const, verifiedAt }
};

/** Docs publish USD per 1M tokens. Catalog rates are USD per 1k tokens. */
const per1k = (perMillion: number) => perMillion / 1000;

const textModel = (entry: {
  modelId: string;
  perMillion: { input: number; cachedInput: number; output: number };
  contextWindowTokens: number;
  recommendedFor: ModelCatalogRecommendation[];
}): ModelCatalogEntry => {
  const { modelId, perMillion, contextWindowTokens, recommendedFor } = entry;
  return {
    provider: "xai",
    modelId,
    contextWindowTokens,
    contextWindowType: "combined",
    inputCostPer1kTokens: per1k(perMillion.input),
    cachedInputCostPer1kTokens: per1k(perMillion.cachedInput),
    outputCostPer1kTokens: per1k(perMillion.output),
    costPer1kTokens: per1k(perMillion.input),
  // Docs bill every token once the prompt reaches 200k (`>=`). The snapshot keeps the
  // exclusive comparator at 199_999 so integer counts match that boundary and stay
  // valid for published core releases that reject unknown long-context fields.
  longContextPricing: {
    inputTokenThreshold: 199_999,
    inputMultiplier: 2,
    outputMultiplier: 2
  },
    recommendedFor,
    evidence: priceEvidence
  };
};

const agentic: ModelCatalogRecommendation[] = ["chat", "reasoning", "tools", "vision"];

const imageQualityRetirement = "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2";

export const xaiCatalogFragment = defineModelCatalogFragment({
  provider: "xai",
  revision: "2026-10-15",
  verifiedAt: "2026-10-15",
  pricingEffectiveAt: "2026-10-14",
  sources: [
    modelsSource,
    "https://docs.x.ai/developers/grok-4-7",
    "https://docs.x.ai/developers/pricing",
    "https://docs.x.ai/developers/model-capabilities/text/reasoning",
    "https://docs.x.ai/developers/model-capabilities/images/generation",
    "https://docs.x.ai/developers/release-notes",
    "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2"
  ],
  entries: [
    textModel({ modelId: "grok-4.7", perMillion: { input: 2, cachedInput: 0.5, output: 6 }, contextWindowTokens: 500_000, recommendedFor: agentic }),
    textModel({ modelId: "grok-4.6", perMillion: { input: 2, cachedInput: 0.5, output: 6 }, contextWindowTokens: 500_000, recommendedFor: agentic }),
    textModel({ modelId: "grok-4.5", perMillion: { input: 2, cachedInput: 0.3, output: 6 }, contextWindowTokens: 500_000, recommendedFor: agentic }),
    textModel({ modelId: "grok-4.3", perMillion: { input: 1.25, cachedInput: 0.2, output: 2.5 }, contextWindowTokens: 1_000_000, recommendedFor: agentic }),
    textModel({ modelId: "grok-4.20-0309-reasoning", perMillion: { input: 1.25, cachedInput: 0.2, output: 2.5 }, contextWindowTokens: 1_000_000, recommendedFor: agentic }),
    textModel({
      modelId: "grok-4.20-0309-non-reasoning",
      perMillion: { input: 1.25, cachedInput: 0.2, output: 2.5 },
      contextWindowTokens: 1_000_000,
      recommendedFor: ["chat", "tools", "vision"]
    }),
    textModel({ modelId: "grok-build-0.1", perMillion: { input: 1, cachedInput: 0.2, output: 2 }, contextWindowTokens: 256_000, recommendedFor: agentic }),
    textModel({ modelId: "grok-4.20-multi-agent-0309", perMillion: { input: 1.25, cachedInput: 0.2, output: 2.5 }, contextWindowTokens: 1_000_000, recommendedFor: agentic }),
    {
      provider: "xai",
      modelId: "grok-imagine-image-2.0",
      recommendedFor: ["vision"]
    },
    {
      provider: "xai",
      modelId: "grok-imagine-image-quality",
      lifecycle: {
        deprecatedAt: "2026-09-02",
        retiredAt: "2026-11-02",
        source: imageQualityRetirement
      }
    }
  ]
});
