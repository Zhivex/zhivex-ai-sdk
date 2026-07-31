import { createModelCatalog, defaultModelCatalog } from "@zhivex-ai/sdk";

const customCatalog = createModelCatalog([
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
]);

console.log(customCatalog.find("openai", "fast-chat"));
console.log(defaultModelCatalog.find("gemini", "gemini-3.6-flash"));
console.log(defaultModelCatalog.list().map((entry) => `${entry.provider}:${entry.modelId}`));
