"use client";
import { experimentalConnectOpenAILiveWebRTC, type OpenAILiveWebRTCSession } from "@zhivex-ai/openai/experimental/live-browser";

/** Call from your app's Start control, after it obtains a permissioned stream. */
export async function connectVoice(stream: MediaStream, audio: HTMLAudioElement, creationLeaseId: string, signal: AbortSignal): Promise<OpenAILiveWebRTCSession> {
  return experimentalConnectOpenAILiveWebRTC({
    mediaStream: stream, signal,
    onTrack: event => {
      audio.srcObject = new MediaStream([event.track]);
      // Playback permission belongs to the UI: show audio controls if autoplay fails.
      void audio.play().catch(() => { audio.controls = true; });
    },
    exchangeSdp: async ({ offerSdp, signal }) => {
      const response = await fetch("/api/voice", { method: "POST", credentials: "same-origin", signal,
        headers: { "content-type": "application/json", "x-creation-lease": creationLeaseId }, body: JSON.stringify({ sdp: offerSdp }) });
      if (!response.ok) throw new Error("Voice connection failed.");
      return response.json();
    },
    releaseSession: async ({ sessionId }) => {
      const response = await fetch("/api/voice", { method: "DELETE", credentials: "same-origin", keepalive: true,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) });
      if (!response.ok) throw new Error("Voice cleanup is unconfirmed; contact the backend session owner.");
    }
  });
}
/** End control: application keeps audio alive while session.close() drains. */
export async function endVoice(session: OpenAILiveWebRTCSession, stream: MediaStream, audio: HTMLAudioElement) {
  try { await session.close(); }
  finally { audio.pause(); audio.srcObject = null; stream.getTracks().forEach(track => track.stop()); }
}
