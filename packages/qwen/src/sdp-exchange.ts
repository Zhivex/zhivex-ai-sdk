import { ProviderHTTPError, readBodyWithLimit, assertTrustedEndpoint, withTimeoutSignal } from "@zhivex-ai/core/provider";
import { MAX_BYTES, model, sdp, type QwenSDPExchange } from "./rtc-protocol.js";

/** Server-side SDP proxy. Never instantiate this with a long-lived API key in a browser. */
export const createQwenSDPExchange = (options: { apiKey: string; taskBaseURL?: string; fetch?: typeof globalThis.fetch }): QwenSDPExchange => {
  const base = assertTrustedEndpoint(options.taskBaseURL ?? "https://maas.qwencloudapi.com/api/v1", { label: "Qwen WebRTC base URL", protocols: ["https"] }).toString().replace(/\/$/, "");
  return async input => {
    model(input.modelId);
    const body = sdp(input.offerSdp);
    const { signal, cleanup } = withTimeoutSignal({ abortSignal: input.signal, timeoutMs: 30_000 });
    try {
      const response = await (options.fetch ?? globalThis.fetch)(`${base}/webrtc/realtime?model=${encodeURIComponent(input.modelId)}`, {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/sdp" }, body, signal,
      });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderHTTPError("Qwen WebRTC SDP exchange failed.", response.status); }
      return sdp(new TextDecoder().decode(await readBodyWithLimit(response, { maxBytes: MAX_BYTES, provider: "qwen", endpoint: "webrtc/realtime" })));
    } finally { cleanup(); }
  };
};
