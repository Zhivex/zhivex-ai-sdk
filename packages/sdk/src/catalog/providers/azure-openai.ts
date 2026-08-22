import { defineModelCatalogFragment } from "../fragment.js";

export const azureOpenaiCatalogFragment = defineModelCatalogFragment({
  provider: "azure-openai",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
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
