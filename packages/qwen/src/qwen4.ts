import { ConfigurationError, UnsupportedFeatureError, type ModelGenerateInput, type ModelMessage, type JsonValue } from "@zhivex-ai/core/provider";

// Exact published IDs: do not infer capabilities or plan entitlement for future models.
export const isQwen4Max = (id: string) => id.toLowerCase() === "qwen4-max";
export const isQwen4Preview = (id: string) => id.toLowerCase() === "qwen4-max-preview";
export const isQwen4 = (id: string) => isQwen4Max(id) || isQwen4Preview(id);

export function encryptedReasoningFromMessage(message: ModelMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  let value: string | undefined;
  for (const part of message.parts) {
    if (part.type !== "provider-data" || part.provider !== "qwen" || !part.data || typeof part.data !== "object" || Array.isArray(part.data)) continue;
    const next = part.data.type === "encrypted_content" ? part.data.encryptedContent : undefined;
    if (typeof next !== "string" || !next) continue;
    if (value !== undefined && value !== next) throw new ConfigurationError("Qwen encrypted reasoning must remain one unchanged value per assistant message.");
    value = next;
  }
  return value;
}

/** Only explicitly documented per-content options are forwarded. */
export function qwen4PartOptions(part: ModelMessage["parts"][number], modelId?: string): Record<string, JsonValue> {
  if (!modelId || !isQwen4Max(modelId) || !("providerMetadata" in part)) return {};
  const metadata = part.providerMetadata ?? {};
  const result: Record<string, JsonValue> = {};
  for (const key of ["prompt_cache_breakpoint", "cache_control", ...(part.type === "image" || part.type === "file" ? ["min_pixels", "max_pixels", "fps"] : [])]) {
    if (metadata[key] !== undefined) result[key] = metadata[key];
  }
  return result;
}

export function validateQwen4(modelId: string, input: ModelGenerateInput, options: Record<string, unknown>) {
  const nested = options.reasoning as { effort?: unknown; summary?: unknown } | undefined;
  if (nested !== undefined && (!nested || typeof nested !== "object" || Array.isArray(nested))) throw new ConfigurationError("Qwen reasoning must be an object.");
  if (nested?.effort !== undefined && (input.reasoning?.effort !== undefined || options.reasoning_effort !== undefined)) throw new ConfigurationError("Configure Qwen reasoning effort through only one option.");
  const effort = input.reasoning?.effort ?? options.reasoning_effort ?? nested?.effort;
  const disabled = effort === "none" || options.enable_thinking === false;
  const summarized = options.thinking_display !== undefined || nested?.summary !== undefined;
  if (summarized) {
    if (!isQwen4Max(modelId)) throw new UnsupportedFeatureError("Thinking summaries and encryption require qwen4-max, not the preview model.");
    if (options.thinking_display !== undefined && options.thinking_display !== "summarized" || nested?.summary !== undefined && nested.summary !== "auto") throw new ConfigurationError("Qwen summaries require thinking_display summarized or reasoning.summary auto.");
    if (disabled) throw new ConfigurationError("Qwen thinking summaries require thinking to be enabled.");
  }
  const budget = input.reasoning?.budgetTokens ?? options.thinking_budget;
  if (budget !== undefined && (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < (isQwen4Max(modelId) ? 1 : 0) || budget > 262144)) throw new ConfigurationError("Qwen thinking budget is outside the model's supported range (maximum 262144).");
  const limit = isQwen4Preview(modelId) ? 393216 : disabled ? 131072 : 262144;
  for (const value of [input.maxTokens, options.max_output_tokens, options.max_completion_tokens, options.max_tokens]) {
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > limit)) throw new ConfigurationError(`Qwen ${modelId} output limit must be an integer from 1 to ${limit}, including reasoning and answer tokens.`);
  }
  // The shared generation contract returns a single assistant message.
  if (options.n !== undefined && options.n !== 1 && options.n !== 0) throw new UnsupportedFeatureError("Qwen SDK generation supports one response candidate (n=1).");
  if (options.audio !== undefined || options.modalities !== undefined && JSON.stringify(options.modalities) !== '["text"]') throw new UnsupportedFeatureError("Qwen4 supports text output only.");
  let breakpointStyle: string | undefined;
  for (const message of input.messages) {
    encryptedReasoningFromMessage(message);
    for (const part of message.parts) {
      if (isQwen4Preview(modelId) && "providerMetadata" in part && (part.providerMetadata?.prompt_cache_breakpoint !== undefined || part.providerMetadata?.cache_control !== undefined)) throw new UnsupportedFeatureError("Qwen4 cache breakpoints require the final qwen4-max model.");
      if (part.type === "audio" || part.type === "file" && !part.mediaType.toLowerCase().startsWith("video/")) throw new UnsupportedFeatureError("Qwen4 accepts text, images and video, not audio or document files.");
      if ((part.type === "image" || part.type === "file") && message.role !== "user") throw new UnsupportedFeatureError("Qwen4 visual inputs require user messages.");
      for (const [key, value] of Object.entries(qwen4PartOptions(part, modelId))) {
        if (key === "prompt_cache_breakpoint" || key === "cache_control") {
          if (breakpointStyle && breakpointStyle !== key) throw new ConfigurationError("Use only one Qwen cache breakpoint style per request.");
          breakpointStyle = key;
          if (!value || typeof value !== "object" || Array.isArray(value) ||
              (key === "prompt_cache_breakpoint" ? value.mode !== "explicit" : value.type !== "ephemeral") ||
              ("ttl" in value && value.ttl !== "5m" && value.ttl !== "1h")) throw new ConfigurationError("Invalid Qwen cache breakpoint.");
        } else if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new ConfigurationError(`Qwen ${key} must be positive.`);
      }
    }
  }
  const cache = options.prompt_cache_options as { mode?: unknown; ttl?: unknown } | undefined;
  if (cache !== undefined) {
    if (!isQwen4Max(modelId)) throw new UnsupportedFeatureError("Qwen4 explicit cache options require qwen4-max.");
    if (!cache || typeof cache !== "object" || Array.isArray(cache) || cache.mode !== undefined && cache.mode !== "implicit" && cache.mode !== "explicit" || cache.ttl !== undefined && cache.ttl !== "5m" && cache.ttl !== "1h") throw new ConfigurationError("Invalid Qwen prompt_cache_options mode or TTL.");
  }
}
