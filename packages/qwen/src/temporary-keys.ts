import { ConfigurationError, ProviderHTTPError, ValidationError, readJsonWithLimit, withTimeoutSignal } from "@zhivex-ai/core/provider";

export interface QwenTemporaryKeyOptions { expiresInSeconds?: number; abortSignal?: AbortSignal; timeoutMs?: number }
export interface QwenTemporaryKey { token: string; expiresAt: number }
export interface QwenTemporaryKeysClient { create(options?: QwenTemporaryKeyOptions): Promise<QwenTemporaryKey> }

/** Server-side exchange. Returned tokens inherit the primary key's permissions. */
export function createQwenTemporaryKeysClient(apiKey: string, taskBaseURL: string, fetcher: typeof globalThis.fetch): QwenTemporaryKeysClient {
  return { async create(options = {}) {
    const ttl = options.expiresInSeconds ?? 60;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 1800) throw new ConfigurationError("Temporary key lifetime must be 1–1800 seconds.");
    const { signal, cleanup } = withTimeoutSignal({ ...options, timeoutMs: options.timeoutMs ?? 15000 });
    try {
      const response = await fetcher(`${taskBaseURL}/tokens?expire_in_seconds=${ttl}`, {
        method: "POST", redirect: "error", signal, headers: { authorization: `Bearer ${apiKey}` }
      });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderHTTPError("Qwen temporary key request failed.", response.status); }
      const data = await readJsonWithLimit<{ token?: unknown; expires_at?: unknown }>(response, { maxBytes: 16384, provider: "qwen", endpoint: "tokens" });
      if (!data || typeof data.token !== "string" || ( !data.token.startsWith("st-") || data.token.length <= 3 || data.token.length > 4096 || /[\u0000-\u0020\u007f]/.test(data.token) ) || !Number.isSafeInteger(data.expires_at) || (data.expires_at as number) <= Date.now() / 1000) {
        throw new ValidationError("Invalid Qwen temporary key response.");
      }
      return { token: data.token, expiresAt: data.expires_at as number };
    } finally { cleanup(); }
  } };
}
