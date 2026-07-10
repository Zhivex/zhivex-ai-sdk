import type { LongContextPricing } from "./agent-trace.js";

export type CatalogProviderId = string;

export interface ModelCatalogEntry {
  provider: CatalogProviderId;
  modelId: string;
  aliases?: string[];
  inputCostPer1kTokens?: number;
  cachedInputCostPer1kTokens?: number;
  cacheWriteCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  costPer1kTokens?: number;
  longContextPricing?: LongContextPricing;
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
  {
    provider: "openai",
    modelId: "gpt-5.6-sol",
    aliases: ["gpt-5.6"],
    inputCostPer1kTokens: 0.005,
    cachedInputCostPer1kTokens: 0.0005,
    cacheWriteCostPer1kTokens: 0.00625,
    outputCostPer1kTokens: 0.03,
    costPer1kTokens: 0.005,
    longContextPricing: {
      inputTokenThreshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5
    },
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "openai",
    modelId: "gpt-5.6-terra",
    inputCostPer1kTokens: 0.0025,
    cachedInputCostPer1kTokens: 0.00025,
    cacheWriteCostPer1kTokens: 0.003125,
    outputCostPer1kTokens: 0.015,
    costPer1kTokens: 0.0025,
    longContextPricing: {
      inputTokenThreshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5
    },
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    inputCostPer1kTokens: 0.001,
    cachedInputCostPer1kTokens: 0.0001,
    cacheWriteCostPer1kTokens: 0.00125,
    outputCostPer1kTokens: 0.006,
    costPer1kTokens: 0.001,
    longContextPricing: {
      inputTokenThreshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5
    },
    recommendedFor: ["chat", "reasoning", "speed", "tools", "vision"]
  },
  { provider: "openai", modelId: "gpt-5.5", costPer1kTokens: 0.005, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "openai", modelId: "gpt-5.4", costPer1kTokens: 0.0025, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "openai", modelId: "gpt-5.4-mini", costPer1kTokens: 0.00075, recommendedFor: ["chat", "tools", "speed", "vision"] },
  { provider: "openai", modelId: "gpt-4o-mini", costPer1kTokens: 0.0006, recommendedFor: ["chat", "tools", "speed"] },
  {
    provider: "xai",
    modelId: "grok-4.5",
    inputCostPer1kTokens: 0.002,
    outputCostPer1kTokens: 0.006,
    costPer1kTokens: 0.002,
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  { provider: "meta", modelId: "muse-spark-1.1", costPer1kTokens: 0.00275, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "azure-openai", modelId: "gpt-4o-mini", costPer1kTokens: 0.0006, recommendedFor: ["chat", "tools"] },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "anthropic",
    modelId: "claude-fable-5",
    aliases: ["claude-mythos-class"],
    costPer1kTokens: 0.01,
    recommendedFor: ["reasoning", "tools", "vision"]
  },
  {
    provider: "anthropic",
    modelId: "claude-mythos-5",
    costPer1kTokens: 0.01,
    recommendedFor: ["reasoning", "tools", "vision"]
  },
  {
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    aliases: ["claude-opus-4-7"],
    costPer1kTokens: 0.005,
    recommendedFor: ["reasoning", "tools"]
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    aliases: ["claude-haiku-4-5"],
    costPer1kTokens: 0.001,
    recommendedFor: ["chat", "reasoning", "speed", "vision"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.5-flash",
    aliases: ["gemini-flash-latest"],
    costPer1kTokens: 0.0015,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-pro-preview",
    recommendedFor: ["chat", "reasoning", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-pro-preview-customtools",
    recommendedFor: ["chat", "reasoning", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3-flash-preview",
    recommendedFor: ["chat", "speed", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-lite",
    recommendedFor: ["chat", "speed", "vision"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-image",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3-pro-image",
    recommendedFor: ["vision", "reasoning"]
  },
  {
    provider: "gemini",
    modelId: "gemini-2.5-flash-image",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-live-preview",
    recommendedFor: ["speed", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.5-live-translate-preview",
    recommendedFor: ["speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-tts-preview",
    recommendedFor: ["speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-embedding-2",
    recommendedFor: ["vision"]
  },
  {
    provider: "gemini",
    modelId: "gemini-robotics-er-1.6-preview",
    recommendedFor: ["vision", "reasoning"]
  },
  {
    provider: "gemini",
    modelId: "veo-3.1-generate-preview",
    recommendedFor: ["vision"]
  },
  {
    provider: "gemini",
    modelId: "veo-3.1-fast-generate-preview",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "imagen-4.0-generate-001",
    recommendedFor: ["vision"]
  },
  {
    provider: "gemini",
    modelId: "imagen-4.0-fast-generate-001",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "imagen-4.0-ultra-generate-001",
    recommendedFor: ["vision"]
  },
  {
    provider: "gemini",
    modelId: "lyria-3-clip-preview"
  },
  {
    provider: "gemini",
    modelId: "lyria-3-pro-preview"
  },
  {
    provider: "gemini",
    modelId: "lyria-realtime-exp",
    recommendedFor: ["speed"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.5-flash",
    aliases: ["gemini-flash-latest"],
    costPer1kTokens: 0.0015,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.5-live-translate-preview",
    recommendedFor: ["speed"]
  },
  { provider: "qwen", modelId: "qwen3.7-max", costPer1kTokens: 0.0016, recommendedFor: ["chat", "tools", "reasoning"] },
  { provider: "qwen", modelId: "qwen3.7-plus", costPer1kTokens: 0.0008, recommendedFor: ["chat", "tools", "reasoning", "vision"] },
  { provider: "qwen", modelId: "qwen3.6-flash", costPer1kTokens: 0.0002, recommendedFor: ["chat", "speed", "tools"] },
  { provider: "qwen", modelId: "qwen3.5-omni-plus", recommendedFor: ["chat", "vision", "speed"] },
  { provider: "qwen", modelId: "qwen-image-2.0-pro", recommendedFor: ["vision"] },
  { provider: "qwen", modelId: "qwen-plus", costPer1kTokens: 0.0008, recommendedFor: ["chat", "tools", "reasoning"] },
  {
    provider: "kimi",
    modelId: "kimi-k2.7-code",
    aliases: ["kimi-k2.7-code-highspeed"],
    costPer1kTokens: 0.002,
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  { provider: "kimi", modelId: "kimi-k2.6", costPer1kTokens: 0.002, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "kimi", modelId: "kimi-k2.5", costPer1kTokens: 0.002, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "kimi", modelId: "kimi-k2-0905-preview", costPer1kTokens: 0.002, recommendedFor: ["tools"] },
  { provider: "deepseek", modelId: "deepseek-v4-flash", costPer1kTokens: 0.0004, recommendedFor: ["chat", "tools", "reasoning", "speed"] },
  { provider: "openrouter", modelId: "openai/gpt-4o-mini", costPer1kTokens: 0.0007, recommendedFor: ["chat", "tools"] },
  { provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet", costPer1kTokens: 0.003, recommendedFor: ["reasoning"] },
  { provider: "ollama", modelId: "llama3.2", costPer1kTokens: 0, recommendedFor: ["chat", "speed"] }
]);
