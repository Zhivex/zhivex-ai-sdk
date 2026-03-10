import type { EmbedOptions, EmbedOutput } from "./types.js";

export const embed = async (options: EmbedOptions): Promise<EmbedOutput> => {
  const values = Array.isArray(options.value) ? options.value : [options.value];
  const response = await options.model.embed({
    values,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs
  });

  return {
    ...response,
    values
  };
};

export const embedMany = embed;
