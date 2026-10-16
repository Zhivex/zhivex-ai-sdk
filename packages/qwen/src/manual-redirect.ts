import { ProviderHTTPError } from "@zhivex-ai/core/provider";

const isRedirectResponse = (response: Response) =>
  response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);

const manualRedirects = new WeakMap<typeof globalThis.fetch, typeof globalThis.fetch>();

/**
 * Credentialed fetches do not follow redirects. Callers that already set
 * `redirect` keep that policy. Every other request uses `redirect: "manual"`
 * and rejects 3xx. Kept local because Qwen's declared minimum core does not
 * export `withManualRedirect`.
 */
export const withManualRedirect = (fetcher: typeof globalThis.fetch): typeof globalThis.fetch => {
  const cached = manualRedirects.get(fetcher);
  if (cached) return cached;
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    if (init?.redirect) return fetcher(input, init);
    const response = await fetcher(input, { ...init, redirect: "manual" });
    if (isRedirectResponse(response)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderHTTPError("Credentialed provider request was redirected.", response.status || 302);
    }
    return response;
  };
  manualRedirects.set(fetcher, wrapped);
  return wrapped;
};
