import { defineModelCatalogFragment } from "../fragment.js";

export const bedrockCatalogFragment = defineModelCatalogFragment({
  provider: "bedrock",
  revision: "2026-10-15",
  verifiedAt: "2026-10-15",
  sources: [
    "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html",
    "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html",
    "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html",
    "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html"
  ],
  entries: [
    {
      provider: "bedrock",
      modelId: "anthropic.claude-haiku-5-5",
      recommendedFor: ["chat", "reasoning", "speed", "tools", "vision"]
    },
    {
      provider: "bedrock",
      modelId: "anthropic.claude-sonnet-5-5",
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    },
    {
      provider: "bedrock",
      modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      recommendedFor: ["chat", "reasoning", "speed", "tools", "vision"]
    },
    {
      provider: "bedrock",
      modelId: "amazon.nova-2-lite-v1:0",
      recommendedFor: ["chat", "reasoning", "speed", "tools", "vision"]
    }
  ]
});
