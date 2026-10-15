import { ProviderHTTPError } from "./errors.js";
import { readErrorBodyWithLimit } from "./response.js";
import { withRetry } from "./runtime.js";
import type { RetryOptions } from "./types.js";

const numericHeader = (value: string | null) => {
  const header = value?.trim();
  return header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : undefined;
};

/**
 * Azure documents `retry-after-ms` and `x-ms-retry-after-ms` ahead of `retry-after`.
 * Millisecond hints get a small additive jitter so synchronized clients do not retry together.
 * Classic `retry-after` stays exact: it is already a server minimum, and callers assert that bound.
 */
const retryDelayMs = (response: Response) => {
  const milliseconds = numericHeader(response.headers.get("retry-after-ms"))
    ?? numericHeader(response.headers.get("x-ms-retry-after-ms"));
  if (milliseconds !== undefined) {
    const spread = Math.min(250, Math.floor(milliseconds * 0.2));
    const jitter = spread > 0 ? Math.floor(Math.random() * (spread + 1)) : 0;
    return Math.max(0, milliseconds + jitter);
  }

  const header = response.headers.get("retry-after")?.trim();
  const seconds = numericHeader(header ?? null);
  const date = header && seconds === undefined ? Date.parse(header) : NaN;
  const delay = seconds !== undefined ? seconds * 1_000 : date - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
};

/** Retry HTTP failures before returning a response, without consuming successful streams. */
export const withResponseRetry = (
  operation: () => Promise<Response>,
  options: RetryOptions = {},
  provider = "Provider"
): Promise<Response> => withRetry(async () => {
  const response = await operation();
  if (!response.ok) {
    throw new ProviderHTTPError(`${provider} request failed with status ${response.status}.`, response.status, {
      responseBody: await readErrorBodyWithLimit(response),
      retryAfterMs: retryDelayMs(response)
    });
  }
  return response;
}, options);

