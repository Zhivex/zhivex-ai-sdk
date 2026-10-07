import assert from "node:assert/strict";
import { experimentalCreateOpenAILiveWebRTCSession as create, experimentalAttachOpenAILiveSession as attach } from "@zhivex-ai/openai/experimental/live-server";
import { experimentalConnectOpenAILiveWebRTC as connect } from "@zhivex-ai/openai/experimental/live-browser";
const sdp = "v=0\r\ns=synthetic\r\nt=0 0\r\n";
const answer = await create({ apiKey: "offline-server-only", offerSdp: sdp, fetch: async (url, request) => {
  assert.equal(url, "https://api.openai.com/v1/live/sessions");
  assert.equal(JSON.parse(request.body).session.audio.format, undefined);
  return Response.json({ session: { id: "packed_opaque", private: "strip-me" }, transport: { type: "webrtc", sdp }, secret: "strip-me" });
} });
assert.deepEqual(answer, { session: { id: "packed_opaque" }, transport: { type: "webrtc", sdp } });
const original = { enabled: true, stop() { throw new Error("Caller track stopped"); }, clone() { return { enabled: true, stop() { this.stopped = true; } }; } };
const channel = { readyState: "open", bufferedAmount: 0, close() {}, send(raw) {
  const event = JSON.parse(raw); assert.notEqual(event.type, "session.start");
  if (event.type === "session.close") this.onmessage({ data: JSON.stringify({ type: "session.closed", session: { id: "packed_opaque" }, usage: { seconds: 1 } }) });
} };
let peerClosed = 0;
const peer = { iceGatheringState: "complete", addTrack() {}, createDataChannel() { return channel; }, async createOffer() { return { type: "offer", sdp }; }, async setLocalDescription(value) { this.localDescription = value; }, async setRemoteDescription() { channel.onmessage({ data: JSON.stringify({ type: "session.started", session: { id: "packed_opaque" } }) }); }, close() { peerClosed++; } };
const session = await connect({ mediaStream: { getAudioTracks() { return [original]; } }, exchangeSdp: async () => answer, peerConnectionFactory: () => peer, releaseSession: async () => { throw new Error("Unexpected fallback cleanup"); } });
assert.equal(session.sessionId, "packed_opaque"); await session.close(); assert.equal(peerClosed, 1);
let receive;
const sideband = await attach({ apiKey: "offline", sessionId: "packed_opaque", connectionFactory: async (url) => {
  assert.equal(url, "wss://api.openai.com/v1/live/sessions/packed_opaque/attach");
  return { async recvJson() { return new Promise(resolve => { receive = resolve; }); }, async sendJson(event) { assert.equal(event.type, "session.close"); receive({ type: "session.closed", usage: { seconds: 1 } }); }, async close() {} };
} });
await sideband.close();
console.log("INSTALLED_OPENAI_LIVE_WEBRTC_OK");
