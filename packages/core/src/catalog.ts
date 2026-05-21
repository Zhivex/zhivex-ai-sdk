export type CatalogProviderId = string;

export interface ModelCatalogEntry {
  provider: CatalogProviderId;
  modelId: string;
  aliases?: string[];
  costPer1kTokens?: number;
  recommendedFor?: Array<"chat" | "reasoning" | "speed" | "vision" | "tools">;
}

export interface ModelCatalog {
  find(provider: CatalogProviderId, modelId: string): ModelCatalogEntry | undefined;
  list(): ModelCatalogEntry[];
}

export const createModelCatalog = (entries: ModelCatalogEntry[]): ModelCatalog => ({
  find(provider, modelId) {
    return entries.find(
      (entry) =>
        entry.provider === provider && (entry.modelId === modelId || entry.aliases?.includes(modelId))
    );
  },
  list() {
    return [...entries];
  }
});

export const defaultModelCatalog = createModelCatalog([
  { provider: "openai", modelId: "gpt-4o-mini", costPer1kTokens: 0.6, recommendedFor: ["chat", "tools", "speed"] },
  { provider: "azure-openai", modelId: "gpt-4o-mini", costPer1kTokens: 0.6, recommendedFor: ["chat", "tools"] },
  { provider: "anthropic", modelId: "claude-opus-4-7", costPer1kTokens: 5, recommendedFor: ["reasoning", "tools"] },
  {
    provider: "gemini",
    modelId: "gemini-3.5-flash",
    aliases: ["gemini-flash-latest"],
    costPer1kTokens: 1.5,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.5-flash",
    aliases: ["gemini-flash-latest"],
    costPer1kTokens: 1.5,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  { provider: "qwen", modelId: "qwen-plus", costPer1kTokens: 0.8, recommendedFor: ["chat", "tools", "reasoning"] },
  { provider: "kimi", modelId: "kimi-k2-0905-preview", costPer1kTokens: 2, recommendedFor: ["reasoning", "tools"] },
  { provider: "deepseek", modelId: "deepseek-v4-flash", costPer1kTokens: 0.4, recommendedFor: ["chat", "tools", "reasoning", "speed"] },
  { provider: "openrouter", modelId: "openai/gpt-4o-mini", costPer1kTokens: 0.7, recommendedFor: ["chat", "tools"] },
  { provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet", costPer1kTokens: 3, recommendedFor: ["reasoning"] },
  { provider: "ollama", modelId: "llama3.2", costPer1kTokens: 0, recommendedFor: ["chat", "speed"] }
]);
