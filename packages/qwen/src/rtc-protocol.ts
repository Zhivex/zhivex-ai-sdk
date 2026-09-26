import { ConfigurationError } from "@zhivex-ai/core/runtime";

export interface QwenSDPExchangeInput { modelId: string; offerSdp: string; signal?: AbortSignal }
export type QwenSDPExchange = (input: QwenSDPExchangeInput) => Promise<string>;
export const MAX_BYTES = 1024 * 1024;
export const model = (id: string) => { if (!/^qwen3\.(8|5)-omni-(flash|plus)-realtime(?:-|$)/.test(id)) throw new ConfigurationError("This WebRTC integration requires a Qwen Omni realtime model."); };
export const sdp = (value: string) => {
  if (typeof value !== "string" || !value.trim().startsWith("v=0") || new TextEncoder().encode(value).length > MAX_BYTES) throw new ConfigurationError("Invalid or oversized SDP.");
  return value.trim().replace(/\r?\n/g, "\r\n") + "\r\n";
};
