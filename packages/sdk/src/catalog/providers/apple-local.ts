import { defineModelCatalogFragment } from "../fragment.js";

const onDeviceCostEvidence = {
  source: "https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models",
  sourceType: "primary" as const,
  verifiedAt: "2026-10-28",
  conditions: [
    "On-device SystemLanguageModel. Apple publishes no token price. Catalog cost is 0 because inference stays on device."
  ]
};

export const appleLocalCatalogFragment = defineModelCatalogFragment({
  provider: "apple-local",
  revision: "2026-10-28",
  verifiedAt: "2026-10-28",
  pricingEffectiveAt: "2026-10-28",
  sources: [
    "https://developer.apple.com/documentation/foundationmodels",
    "https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel",
    "https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models",
    "https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/contextsize",
    "https://developer.apple.com/videos/play/wwdc2026/241/"
  ],
  entries: [
    {
      provider: "apple-local",
      modelId: "apple-on-device",
      aliases: ["system", "general"],
      inputCostPer1kTokens: 0,
      outputCostPer1kTokens: 0,
      costPer1kTokens: 0,
      recommendedFor: ["chat", "tools"],
      evidence: {
        inputCostPer1kTokens: onDeviceCostEvidence,
        outputCostPer1kTokens: onDeviceCostEvidence
      }
    },
    {
      provider: "apple-local",
      modelId: "apple-on-device-content-tagging",
      aliases: ["content-tagging"],
      inputCostPer1kTokens: 0,
      outputCostPer1kTokens: 0,
      costPer1kTokens: 0,
      recommendedFor: ["chat"],
      evidence: {
        inputCostPer1kTokens: onDeviceCostEvidence,
        outputCostPer1kTokens: onDeviceCostEvidence
      }
    }
  ]
});
