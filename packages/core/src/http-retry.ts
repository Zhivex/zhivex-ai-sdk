import { ProviderHTTPError } from "./errors.js";
import { readErrorBodyWithLimit } from "./response.js";
import { withRetry } from "./runtime.js";
import type { RetryOptions } from "./types.js";

/** Retry HTTP failures before returning a response, without consuming successful streams. */
export const withResponseRetry = (
  operation: () => Promise<Response>,
  options: RetryOptions = {},
  provider = "Provider"
): Promise<Response> => withRetry(async () => {
  const response = await operation();
  if (!response.ok) {
    const header = response.headers.get("retry-after")?.trim();
    const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : undefined;
    const date = header && seconds === undefined ? Date.parse(header) : NaN;
    const delay = seconds !== undefined ? seconds * 1_000 : date - Date.now();
    throw new ProviderHTTPError(`${provider} request failed with status ${response.status}.`, response.status, {
      responseBody: await readErrorBodyWithLimit(response),
      retryAfterMs: Number.isFinite(delay) ? Math.max(0, delay) : undefined
    });
  }
  return response;
}, options);

