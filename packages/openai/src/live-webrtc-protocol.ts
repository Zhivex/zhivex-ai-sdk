import { ConfigurationError } from "@zhivex-ai/core/runtime";

/** Experimental, secret-free response returned to the browser. */
export interface OpenAILiveWebRTCAnswer {
  session: { id: string };
  transport: { type: "webrtc"; sdp: string };
}
export const LIVE_SDP_MAX_BYTES = 64 * 1024;
export function liveSdp(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("v=0\r\n") && !value.startsWith("v=0\n") || new TextEncoder().encode(value).length > LIVE_SDP_MAX_BYTES) {
    throw new ConfigurationError("GPT-Live requires a valid SDP of at most 64 KiB.");
  }
  return value;
}
export function liveSessionId(value: unknown): string {
  if (typeof value !== "string" || !value || value === "." || value === ".." || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) throw new ConfigurationError("Invalid GPT-Live session ID.");
  return value;
}
export function liveAnswer(value: unknown): OpenAILiveWebRTCAnswer {
  const result = value as Partial<OpenAILiveWebRTCAnswer> | undefined;
  if (result?.transport?.type !== "webrtc") throw new ConfigurationError("Invalid GPT-Live WebRTC answer.");
  // Whitelist fields: never serialize the provider's session configuration or secrets.
  return { session: { id: liveSessionId(result.session?.id) }, transport: { type: "webrtc", sdp: liveSdp(result.transport.sdp) } };
}
