import { defineModelCatalogFragment } from "../fragment.js";

export const bedrockCatalogFragment = defineModelCatalogFragment({
  provider: "bedrock",
  revision: "2026-10-07",
  verifiedAt: "2026-10-07",
  pricingEffectiveAt: "2026-10-07",
  sources: [
    "https://platform.claude.com/docs/en/models/haiku-5-5/overview",
    "catalog-release:2026-08-16"
  ],
  entries: [
    {
      "provider": "bedrock",
      "modelId": "anthropic.claude-haiku-5-5",
      "recommendedFor": [
        "chat",
        "reasoning",
        "speed",
        "tools",
        "vision"
      ]
    },
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
