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
    modelId: "claude-sonnet-5",
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  }
]);

console.log(customCatalog.find("openai", "fast-chat"));
console.log(defaultModelCatalog.find("gemini", "gemini-2.0-flash"));
console.log(defaultModelCatalog.list().map((entry) => `${entry.provider}:${entry.modelId}`));
