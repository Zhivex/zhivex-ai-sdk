import { createModelCatalog, defaultModelCatalog } from "@zhivex-ai/sdk";

const customCatalog = createModelCatalog(
  [
    {
      provider: "openai",
      modelId: "gpt-4o-mini",
      aliases: ["fast-chat"],
      costPer1kTokens: 0.6,
      recommendedFor: ["chat", "speed", "tools"]
    },
    {
      provider: "anthropic",
      modelId: "claude-opus-5",
      inputCostPer1kTokens: 0.005,
      cachedInputCostPer1kTokens: 0.0005,
      cacheWriteCostPer1kTokens: 0.00625,
      outputCostPer1kTokens: 0.025,
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    }
  ],
  {
    snapshotVersion: "my-models-1",
    policy: { data: "pinned", updates: "never" },
    pricing: { version: "my-prices-1", currency: "USD", unit: "per_1k_tokens" }
  }
);

console.log(customCatalog.find("openai", "fast-chat"));
console.log(customCatalog.metadata);
console.log(defaultModelCatalog.find("gemini", "gemini-3.6-flash"));
console.log(defaultModelCatalog.list().map((entry) => `${entry.provider}:${entry.modelId}`));
