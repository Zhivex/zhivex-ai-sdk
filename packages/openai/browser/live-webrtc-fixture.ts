import { experimentalConnectOpenAILiveWebRTC } from "../src/live-webrtc-browser.js";

// Browser-only synthetic loopback: no devices, provider API, credentials or external ICE servers.
(globalThis as any).runLiveWebRTCLoopback = async () => {
  const remote = new RTCPeerConnection({ iceServers: [] });
  // These peers are in the same browser. Resolve generated mDNS host candidates to loopback
  // in the test signaling fixture, without adding ICE servers or granting LAN access.
  const loopbackSdp = (sdp: string) => sdp.replace(/[a-z0-9-]+\.local/g, "127.0.0.1");
  const audio = new AudioContext();
  const oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start();
  const source = destination.stream.getAudioTracks()[0];
  let remoteTrackCount = 0, releaseCount = 0;
  remote.addTrack(source, destination.stream);
  remote.ondatachannel = ({ channel }) => {
    const sendStartup = () => {
      channel.send(JSON.stringify({ type: "session.started", session: { id: "loopback_opaque" } }));
      channel.send(JSON.stringify({ type: "session.input_transcript.delta", delta: "Synthetic loopback", start_ms: 0, end_ms: 100 }));
    };
    if (channel.readyState === "open") sendStartup(); else channel.onopen = sendStartup;
    channel.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (event.type === "session.start") throw new Error("Duplicate start");
      if (event.type === "session.close") channel.send(JSON.stringify({ type: "session.closed", session: { id: "loopback_opaque" }, usage: { seconds: 1 }, reason: "close_requested" }));
    };
  };
  try {
    const session = await experimentalConnectOpenAILiveWebRTC({
      mediaStream: destination.stream, timeoutMs: 10_000,
      onTrack: () => { remoteTrackCount++; },
      releaseSession: async () => { releaseCount++; },
      exchangeSdp: async ({ offerSdp, signal }) => {
        signal.throwIfAborted();
        await remote.setRemoteDescription({ type: "offer", sdp: loopbackSdp(offerSdp) });
        await remote.setLocalDescription(await remote.createAnswer());
        if (remote.iceGatheringState !== "complete") await new Promise<void>((resolve) => {
          const check = () => { if (remote.iceGatheringState === "complete") { remote.removeEventListener("icegatheringstatechange", check); resolve(); } };
          remote.addEventListener("icegatheringstatechange", check); check();
        });
        return { session: { id: "loopback_opaque" }, transport: { type: "webrtc", sdp: loopbackSdp(remote.localDescription!.sdp) } };
      }
    });
    await session.setInputMuted(true);
    const events = (async () => { const all = []; for await (const e of session.eventStream()) all.push(e); return all; })();
    await session.close();
    return { events: await events, remoteTrackCount, releaseCount, callerTrackState: source.readyState, peerState: session.peerConnection.connectionState };
  } finally { remote.close(); oscillator.stop(); destination.stream.getTracks().forEach(track => track.stop()); await audio.close(); }
};
