import type { GenerateResult } from "@zhivex-ai/core/contracts";

export const normalizeInteractionUsage = (usage: any) =>
  usage && typeof usage === "object"
    ? {
        inputTokens: usage.total_input_tokens ?? usage.prompt_tokens ?? usage.inputTokens,
        cachedInputTokens: usage.total_cached_tokens ?? usage.cached_input_tokens ?? usage.cachedInputTokens,
        outputTokens: usage.total_output_tokens ?? usage.completion_tokens ?? usage.outputTokens,
        reasoningTokens: usage.total_thought_tokens ?? usage.reasoning_tokens ?? usage.reasoningTokens,
        totalTokens: usage.total_tokens ?? usage.totalTokens
      }
    : undefined;

const definedNumber = (value: unknown) => (typeof value === "number" ? value : undefined);

export const normalizeGenerateContentUsage = (usage: any): GenerateResult["usage"] => {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const normalized = {
    inputTokens: definedNumber(usage.promptTokenCount ?? usage.prompt_token_count),
    cachedInputTokens: definedNumber(usage.cachedContentTokenCount ?? usage.cached_content_token_count),
    outputTokens: definedNumber(usage.candidatesTokenCount ?? usage.candidates_token_count),
    reasoningTokens: definedNumber(usage.thoughtsTokenCount ?? usage.thoughts_token_count),
    totalTokens: definedNumber(usage.totalTokenCount ?? usage.total_token_count)
  };

  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
};

