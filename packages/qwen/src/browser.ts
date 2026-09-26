/** Browser and optional native-SDK bridges; no provider construction or API-key lookup. */
import { connectQwenWebRTC as webRTC, connectQwenAOQ as aoq } from "./browser-realtime.js";
export const connectQwenWebRTC = webRTC;
export const connectQwenAOQ = aoq;
export type { QwenSDPExchange, QwenSDPExchangeInput, QwenWebRTCSession, QwenWebRTCOptions, QwenAOQEngine, QwenAOQBridgeOptions, QwenAOQSession } from "./browser-realtime.js";
import { createQwenWorldRTC as worldRTC } from "./world-rtc.js";
export const createQwenWorldRTC = worldRTC;
export type * from "./world-rtc.js";
