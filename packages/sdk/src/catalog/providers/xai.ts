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
    longContextPricing: {
      inputTokenThreshold: 200_000,
      inputTokenThresholdInclusive: true,
      inputMultiplier: 2,
      outputMultiplier: 2
    },
    recommendedFor,
    evidence: priceEvidence
  };
};

const agentic: ModelCatalogRecommendation[] = ["chat", "reasoning", "tools", "vision"];

export const xaiCatalogFragment = defineModelCatalogFragment({
  provider: "xai",
  revision: "2026-10-14",
  verifiedAt: "2026-10-14",
  pricingEffectiveAt: "2026-10-14",
  sources: [
    modelsSource,
    "https://docs.x.ai/developers/grok-4-7",
    "https://docs.x.ai/developers/pricing",
    "https://docs.x.ai/developers/model-capabilities/text/reasoning"
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
    textModel({ modelId: "grok-4.20-multi-agent-0309", perMillion: { input: 1.25, cachedInput: 0.2, output: 2.5 }, contextWindowTokens: 1_000_000, recommendedFor: agentic })
  ]
});
