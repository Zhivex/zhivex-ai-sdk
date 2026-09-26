import { createQwenSDPExchange } from "../src/sdp-exchange.js";
import { describe, expect, it, vi } from "vitest";
import { connectQwenWebRTC, connectQwenAOQ } from "../src/browser-realtime.js";

const rtcFixture = () => {
  const clone = { enabled: true, stop: vi.fn(), kind: "audio" };
  const source = { clone: () => clone, stop: vi.fn(), kind: "audio" };
  const stream = { getAudioTracks: () => [source], getTracks: () => [source] } as unknown as MediaStream;
  const channel: any = { readyState: "open", bufferedAmount: 0, onmessage: null, close: vi.fn(), send: vi.fn() };
  const sender = { replaceTrack: vi.fn(async () => {}) };
  const pc: any = { iceGatheringState: "complete", connectionState: "new", localDescription: { sdp: "v=0\no=offer" },
    addTrack: vi.fn(() => sender), createDataChannel: vi.fn(() => channel), createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0\no=offer" })),
    setLocalDescription: vi.fn(async () => {}), setRemoteDescription: vi.fn(async () => {}), close: vi.fn() };
  const push = (event: unknown) => channel.onmessage?.({ data: JSON.stringify(event) });
  return { pc, stream, channel, source, clone, sender, push };
};
describe("Qwen WebRTC", () => {
  it("proxies bounded SDP server-side without forwarding credentials on redirects", async () => {
    const fetcher = vi.fn(async () => new Response("v=0\no=answer\n", { headers: { "content-type": "application/sdp" } }));
    const exchange = createQwenSDPExchange({ apiKey: "synthetic", fetch: fetcher });
    expect(await exchange({ modelId: "qwen3.8-omni-flash-realtime", offerSdp: "v=0\no=offer" })).toBe("v=0\r\no=answer\r\n");
    expect(fetcher.mock.calls[0]).toMatchObject([expect.stringContaining("/api/v1/webrtc/realtime?model="), { redirect: "error", headers: { "content-type": "application/sdp" } }]);
  });
  it("gates cloned media until acknowledgement and preserves caller tracks", async () => {
    const f = rtcFixture();
    const connecting = connectQwenWebRTC({ modelId: "qwen3.8-omni-flash-realtime", mediaStream: f.stream, peerConnectionFactory: () => f.pc, exchangeSdp: async () => "v=0\no=answer" });
    await vi.waitFor(() => expect(f.pc.setRemoteDescription).toHaveBeenCalled());
    expect(f.clone.enabled).toBe(false); expect(f.sender.replaceTrack).toHaveBeenCalledWith(null);
    f.push({ type: "session.created" });
    await vi.waitFor(() => expect(f.channel.send).toHaveBeenCalled());
    expect(f.clone.enabled).toBe(false);
    f.push({ type: "session.updated" });
    const session = await connecting;
    expect(f.clone.enabled).toBe(true); expect(f.sender.replaceTrack).toHaveBeenLastCalledWith(f.clone);
    session.setInputMuted(true); expect(f.clone.enabled).toBe(false);
    session.close(); expect(f.clone.stop).toHaveBeenCalledOnce(); expect(f.source.stop).not.toHaveBeenCalled();
  });
  it("aborts stalled signaling and rejects manual VAD before connection", async () => {
    const f = rtcFixture();
    await expect(connectQwenWebRTC({ modelId: "qwen3.8-omni-flash-realtime", mediaStream: f.stream, peerConnectionFactory: () => f.pc, session: { turn_detection: null }, exchangeSdp: async () => "" })).rejects.toThrow("manual");
    expect(f.pc.addTrack).not.toHaveBeenCalled();
    await expect(connectQwenWebRTC({ modelId: "qwen3.8-omni-flash-realtime", mediaStream: f.stream, peerConnectionFactory: () => f.pc, timeoutMs: 10, exchangeSdp: () => new Promise(() => {}) })).rejects.toThrow("timed out");
    expect(f.pc.close).toHaveBeenCalledOnce(); expect(f.clone.stop).toHaveBeenCalledOnce();
  });
});
describe("Qwen official AOQ SDK bridge", () => {
  it("gates media before native connect and only enables after session.updated", async () => {
    let handlers: any;
    const calls: unknown[] = [];
    const engine = { connect: vi.fn(() => { calls.push("connect"); handlers.connected(); }), disconnect: vi.fn(),
      enableSendMediaStream: vi.fn((track, enabled) => { calls.push([track, enabled]); }), sendDataMsg: vi.fn() };
    const unsubscribe = vi.fn();
    const pending = connectQwenAOQ({ engine, connection: { token: "temporary" }, mediaTracks: [1, 2], subscribe(value) { handlers = value; return unsubscribe; } });
    await vi.waitFor(() => expect(engine.sendDataMsg).toHaveBeenCalledOnce());
    expect(calls).toEqual([[1, false], [2, false], "connect"]);
    handlers.data(JSON.stringify({ type: "session.updated" }));
    const session = await pending;
    expect(calls.slice(-2)).toEqual([[1, true], [2, true]]);
    await session.close(); expect(engine.disconnect).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("disconnects a native engine when acknowledgement stalls", async () => {
    const engine = { connect: vi.fn(), disconnect: vi.fn(), enableSendMediaStream: vi.fn(), sendDataMsg: vi.fn() };
    await expect(connectQwenAOQ({ engine, connection: {}, mediaTracks: [1], timeoutMs: 10, subscribe: () => () => {} })).rejects.toThrow("timed out");
    expect(engine.disconnect).toHaveBeenCalledOnce();
  });
});
