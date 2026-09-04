import { defineModelCatalogFragment } from "../fragment.js";

export const azureOpenaiCatalogFragment = defineModelCatalogFragment({
  provider: "azure-openai",
  revision: "2026-09-04",
  verifiedAt: "2026-09-04",
  pricingEffectiveAt: "2026-08-16",
  sources: [
    "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure","catalog-release:2026-08-16"],
  entries: [
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
      "modelId": "gpt-4o-mini",
      "costPer1kTokens": 0.0006,
      "recommendedFor": [
        "chat",
        "tools"
      ]
    }
  ]
});
