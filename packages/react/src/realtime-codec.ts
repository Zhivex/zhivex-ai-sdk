import type { AgentLiveEvent } from "@zhivex-ai/core";
export const MAX_REALTIME_FRAME_CHARS = 512 * 1024;
export function realtimeBase64(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength > 256 * 1024) throw new RangeError("Realtime media frame exceeds 256 KiB.");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function decodeRealtimeBase64(value: string): Uint8Array {
  if (value.length > 350_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid realtime base64 frame.");
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
export function encodeRealtimeEvent(event: AgentLiveEvent): unknown {
  if (event.type === "realtime-audio-output") return { ...event, audio: realtimeBase64(event.audio) };
  if (event.type === "realtime-error" || event.type === "error") return { type: "realtime-error", message: "Realtime provider failed." };
  return event;
}
export function decodeRealtimeEvent(value: unknown): AgentLiveEvent {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") throw new Error("Malformed realtime event.");
  const event = value as Record<string, unknown>;
  if (event.type === "realtime-audio-output") {
    if (typeof event.audio !== "string" || typeof event.mediaType !== "string") throw new Error("Malformed audio event.");
    return { ...event, audio: decodeRealtimeBase64(event.audio) } as unknown as AgentLiveEvent;
  }
  if (event.type === "realtime-text-delta" && typeof event.textDelta !== "string") throw new Error("Malformed text delta.");
  if (event.type === "realtime-transcript" && (typeof event.text !== "string" || !["user", "assistant"].includes(String(event.role)) || typeof event.isFinal !== "boolean")) throw new Error("Malformed transcript.");
  return value as AgentLiveEvent;
}
