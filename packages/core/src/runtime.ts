import { ProviderHTTPError, ValidationError } from "./errors.js";
import type { CallableProviderAdapter, ProviderAdapter, RetryOptions } from "./types.js";

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new DOMException("The operation was aborted.", "AbortError");
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const isRetryableError = (error: unknown): boolean => {
  if (error instanceof ProviderHTTPError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return false;
};

export const createMergedAbortSignal = (...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} => {
  const activeSignals = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (!activeSignals.length) {
    return { signal: undefined, cleanup: () => undefined };
  }
  if (activeSignals.length === 1) {
    return { signal: activeSignals[0], cleanup: () => undefined };
  }

  const abortSignalWithAny = AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof abortSignalWithAny.any === "function") {
    return {
      signal: abortSignalWithAny.any(activeSignals),
      cleanup: () => undefined
    };
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.clear();
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      cleanup();
      break;
    }
    const abort = () => {
      controller.abort(signal.reason);
      cleanup();
    };
    listeners.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
  }

  return { signal: controller.signal, cleanup };
};

/**
 * Convenience composition for operations that end when the merged signal aborts. For operations
 * that can complete without aborting, use createMergedAbortSignal and call cleanup in a finally block.
 */
export const mergeAbortSignals = (...signals: Array<AbortSignal | undefined>): AbortSignal | undefined =>
  createMergedAbortSignal(...signals).signal;

export const withTimeoutSignal = (options: RetryOptions) => {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 24 * 60 * 60 * 1_000)
  ) {
    throw new ValidationError('The "timeoutMs" option must be a positive safe integer no greater than 86400000.');
  }
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.abortSignal?.reason);
  if (options.abortSignal?.aborted) {
    abortFromCaller();
  } else {
    options.abortSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), options.timeoutMs);

  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    cleanup: () => {
      options.abortSignal?.removeEventListener("abort", abortFromCaller);
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };
};

export const withRetry = async <T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> => {
  const configuredMaxRetries = options.maxRetries ?? 0;
  if (!Number.isSafeInteger(configuredMaxRetries) || configuredMaxRetries < 0) {
    throw new ValidationError('The "maxRetries" option must be a non-negative safe integer.');
  }
  const maxRetries = Math.min(configuredMaxRetries, 10);
  const configuredBackoff = options.retryBackoffMs ?? 250;
  if (!Number.isSafeInteger(configuredBackoff) || configuredBackoff < 0) {
    throw new ValidationError('The "retryBackoffMs" option must be a non-negative safe integer.');
  }
  const retryBackoffMs = Math.min(configuredBackoff, 60_000);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    throwIfAborted(options.abortSignal);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }
      const retryAfterMs =
        error instanceof ProviderHTTPError &&
        typeof error.retryAfterMs === "number" &&
        Number.isFinite(error.retryAfterMs) &&
        error.retryAfterMs >= 0
          ? error.retryAfterMs
          : 0;
      await sleep(
        Math.min(Math.max(retryBackoffMs * (attempt + 1), retryAfterMs), 60_000),
        options.abortSignal
      );
    }
  }

  throw lastError;
};

export const createProviderAdapter = <TAdapter extends ProviderAdapter>(
  adapter: TAdapter
): CallableProviderAdapter<ReturnType<NoInfer<TAdapter>["languageModel"]>> & NoInfer<TAdapter> => {
  const callable = ((modelId: string) => adapter.languageModel(modelId)) as CallableProviderAdapter<
    ReturnType<TAdapter["languageModel"]>
  > &
    TAdapter;

  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(adapter))) {
    Object.defineProperty(callable, key, descriptor);
  }

  return callable;
};
