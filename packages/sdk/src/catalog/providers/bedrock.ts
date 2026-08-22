import { defineModelCatalogFragment } from "../fragment.js";

export const bedrockCatalogFragment = defineModelCatalogFragment({
  provider: "bedrock",
  revision: "2026-08-16",
  verifiedAt: "2026-08-16",
  pricingEffectiveAt: "2026-08-16",
  sources: ["catalog-release:2026-08-16"],
  entries: [
    {
      "provider": "bedrock",
      "modelId": "anthropic.claude-3-5-sonnet",
      "costPer1kTokens": 0.003,
      "recommendedFor": [
        "reasoning"
      ]
    }
  ]
});
