import { ProviderHTTPError } from "./errors.js";
import type { CallableProviderAdapter, ProviderAdapter, RetryOptions } from "./types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableError = (error: unknown): boolean => {
  if (error instanceof ProviderHTTPError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return false;
};

export const mergeAbortSignals = (...signals: Array<AbortSignal | undefined>) => {
  const activeSignals = signals.filter(Boolean);
  if (!activeSignals.length) {
    return undefined;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();

  for (const signal of activeSignals) {
    if (signal?.aborted) {
      controller.abort();
      break;
    }
    signal?.addEventListener("abort", abort, { once: true });
  }

  return controller.signal;
};

export const withTimeoutSignal = (options: RetryOptions) => {
  if (!options.timeoutMs) {
    return { signal: options.abortSignal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const signal = mergeAbortSignals(options.abortSignal, controller.signal);
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  return {
    signal,
    cleanup: () => clearTimeout(timeout)
  };
};

export const withRetry = async <T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> => {
  const maxRetries = Math.max(0, options.maxRetries ?? 0);
  const retryBackoffMs = options.retryBackoffMs ?? 250;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }
      await sleep(retryBackoffMs * (attempt + 1));
    }
  }

  throw lastError;
};

export const createProviderAdapter = <TAdapter extends ProviderAdapter>(adapter: TAdapter): CallableProviderAdapter & TAdapter => {
  const callable = ((modelId: string) => adapter.languageModel(modelId)) as CallableProviderAdapter & TAdapter;

  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(adapter))) {
    Object.defineProperty(callable, key, descriptor);
  }

  return callable;
};
