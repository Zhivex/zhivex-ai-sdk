import { ValidationError } from "./errors.js";
import type { LanguageModel, ModelGenerateInput } from "./types.js";

export interface SamplingCallOptions {
  topP?: number;
  seed?: number;
  stopSequences?: readonly string[];
}

const warned = new Set<string>();

/** Test hook. Production callers do not need to reset the once-per-provider warning. */
export const resetSamplingWarnings = (): void => {
  warned.clear();
};

/**
 * Warn once per provider and option. Unsupported sampling options are ignored
 * so a shared call shape does not throw on a provider that lacks the field.
 */
export const warnIgnoredCallOption = (
  provider: string,
  option: "topP" | "seed" | "stopSequences",
  detail?: string
): void => {
  const key = `${provider}:${option}`;
  if (warned.has(key)) return;
  warned.add(key);
  const suffix = detail ? ` ${detail}` : "";
  console.warn(`Provider "${provider}" does not support ${option}.${suffix} The option was ignored.`);
};

export const validateSamplingOptions = (input: SamplingCallOptions): void => {
  if (input.topP !== undefined && (typeof input.topP !== "number" || !Number.isFinite(input.topP) || input.topP < 0 || input.topP > 1)) {
    throw new ValidationError("topP must be a finite number from 0 to 1.");
  }
  if (input.seed !== undefined && (typeof input.seed !== "number" || !Number.isSafeInteger(input.seed))) {
    throw new ValidationError("seed must be a safe integer.");
  }
  if (input.stopSequences !== undefined) {
    if (!Array.isArray(input.stopSequences) || input.stopSequences.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new ValidationError("stopSequences must be an array of non-empty strings.");
    }
  }
};

export const warnUnsupportedSampling = (
  model: Pick<LanguageModel, "provider" | "capabilities">,
  input: SamplingCallOptions
): void => {
  const sampling = model.capabilities.sampling;
  if (input.topP !== undefined && sampling?.topP !== true) warnIgnoredCallOption(model.provider, "topP");
  if (input.seed !== undefined && sampling?.seed !== true) warnIgnoredCallOption(model.provider, "seed");
  if (input.stopSequences !== undefined && sampling?.stopSequences !== true) {
    warnIgnoredCallOption(model.provider, "stopSequences");
  }
};

/** OpenAI Chat Completions wire fields. Responses callers must omit seed and stop. */
export const openAIChatSamplingFields = (input: SamplingCallOptions): Record<string, unknown> => ({
  ...(input.topP !== undefined ? { top_p: input.topP } : {}),
  ...(input.seed !== undefined ? { seed: input.seed } : {}),
  ...(input.stopSequences !== undefined ? { stop: [...input.stopSequences] } : {})
});

export const openAIResponsesSamplingFields = (input: SamplingCallOptions, provider = "openai"): Record<string, unknown> => {
  if (input.seed !== undefined) {
    warnIgnoredCallOption(provider, "seed", "The Responses API does not accept seed.");
  }
  if (input.stopSequences !== undefined) {
    warnIgnoredCallOption(provider, "stopSequences", "The Responses API does not accept stop sequences.");
  }
  return input.topP !== undefined ? { top_p: input.topP } : {};
};

export const anthropicSamplingFields = (input: SamplingCallOptions): Record<string, unknown> => ({
  ...(input.topP !== undefined ? { top_p: input.topP } : {}),
  ...(input.stopSequences !== undefined ? { stop_sequences: [...input.stopSequences] } : {})
});

export const geminiSamplingFields = (input: SamplingCallOptions): Record<string, unknown> => ({
  ...(input.topP !== undefined ? { topP: input.topP } : {}),
  ...(input.seed !== undefined ? { seed: input.seed } : {}),
  ...(input.stopSequences !== undefined ? { stopSequences: [...input.stopSequences] } : {})
});

export const copySampling = (input: ModelGenerateInput): SamplingCallOptions => ({
  ...(input.topP !== undefined ? { topP: input.topP } : {}),
  ...(input.seed !== undefined ? { seed: input.seed } : {}),
  ...(input.stopSequences !== undefined ? { stopSequences: input.stopSequences } : {})
});
