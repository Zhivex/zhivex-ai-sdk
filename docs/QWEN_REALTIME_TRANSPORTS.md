# Qwen browser WebRTC and official AOQ bridge

`connectQwenWebRTC` implements the documented browser WebRTC flow for Qwen Omni realtime. `connectQwenAOQ` adapts an application-owned official native AOQ engine. Neither helper requests microphone/camera permissions automatically or loads proprietary SDK binaries.

## Browser WebRTC

Your application obtains a `MediaStream` after user permission and provides an authenticated SDP proxy. The proxy keeps the permanent API key server-side; Qwen's SDP endpoint cannot be called directly from browsers because of CORS.

Server:

```ts
import { createQwenSDPExchange } from "@zhivex-ai/qwen";

const exchange = createQwenSDPExchange({ apiKey: process.env.QWEN_API_KEY! });
// Inside your authenticated request handler, validate your user's access and budget:
const answerSdp = await exchange({
  modelId: "qwen3.8-omni-flash-realtime",
  offerSdp: requestBody.offerSdp,
  signal: request.signal,
});
// Return answerSdp to that browser. Never return the permanent API key.
```

Browser:

```ts
import { connectQwenWebRTC } from "@zhivex-ai/qwen/browser";

const media = await navigator.mediaDevices.getUserMedia({ audio: true });
const call = await connectQwenWebRTC({
  modelId: "qwen3.8-omni-flash-realtime",
  mediaStream: media,
  exchangeSdp: async ({ modelId, offerSdp, signal }) => {
    const response = await fetch("/api/qwen/sdp", {
      method: "POST", signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId, offerSdp }),
    });
    if (!response.ok) throw new Error("Signaling failed");
    return response.text();
  },
  session: { instructions: "Answer briefly.", turn_detection: { type: "server_vad" } },
  onTrack: event => { audioElement.srcObject = event.streams[0] ?? null; },
  onEvent: event => { /* Handle transcripts, tool calls, MCP approval events, and completion. */ },
});
call.setInputMuted(true);
call.close();
// Caller owns capture: stop it when the application no longer needs it.
media.getTracks().forEach(track => track.stop());
```

The connector clones caller tracks, disables them, and detaches senders during initialization. It waits for complete ICE gathering, exchanges SDP through your proxy, handles both the local `oai-events` channel and server-created channels, sends `session.update` after `session.created`, and enables cloned media only after `session.updated`. It preserves caller tracks when closing or failing. Camera tracks may be supplied too; prepare a reduced-frame-rate video stream in your application as in the official guide.

Only server/semantic VAD is supported over WebRTC. Manual audio commits are rejected. Audio and video travel as media tracks, while `sendEvent` supports control/tool/MCP events. Initialization has a default 15-second deadline. Abort closes the peer connection, channels and owned track clones; data/SDP sizes and outbound queued data are bounded. Autoplay policy and UI playback remain application responsibilities.

## Official native AOQ SDK

AOQ is not a browser JavaScript transport. Install and initialize the official SDK for your target platform (Android, iOS, HarmonyOS or another officially supported native platform). Your application manages permissions, capture/playback, codecs, rendering, engine destruction and connection credentials obtained through its AppServer.

`connectQwenAOQ` takes:

- `engine`: an adapter exposing the official `connect`, `disconnect`, `enableSendMediaStream`, and `sendDataMsg` operations.
- `connection`: the SDK's connection configuration containing its short-lived credentials and publish/subscribe tracks.
- `mediaTracks`: the official enum values for upstream audio/video tracks, excluding data.
- `subscribe`: an adapter for official callbacks. Forward the connected state to `handlers.connected()`, message bytes to `handlers.data(...)`, and failures to `handlers.error(...)`; return a function that removes those handlers.
- `session`: the normal native session configuration sent through the SDK data channel.

The bridge disables upstream media before connecting, sends configuration on connection, and enables media only on `session.updated`. It exposes `sendEvent`, `setInputMuted`, and `close`, enforces event limits and initialization deadlines, and detaches callbacks on teardown. It does not implement AOQ/QUIC itself or assume numeric SDK enum values.

## Evidence and limits

Deterministic tests cover SDP headers/normalization, media gating, caller-track preservation, stalled signaling cleanup, rejection of manual WebRTC mode, AOQ acknowledgement gating, and timeout disconnection. Browser ICE/media exchange and native AOQ calls have not been live-certified in this environment. The authenticated live evidence in [Qwen Cloud audio](QWEN_CLOUD_AUDIO.md) covers WebSocket routes separately.

Sources: [official WebRTC guide](https://docs.qwencloud.com/developer-guides/tutorials/realtime/webrtc-omni-realtime), [official AOQ guide](https://docs.qwencloud.com/developer-guides/tutorials/realtime/aoq-omni-realtime).
