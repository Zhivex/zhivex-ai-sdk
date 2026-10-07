import { describe, it, expect, vi } from "vitest";
import { experimentalConnectOpenAILiveWebRTC as connect, type OpenAILiveWebRTCOptions } from "../src/live-webrtc-browser.js";
import { experimentalCreateOpenAILiveWebRTCSession as create, experimentalAttachOpenAILiveSession as attach } from "../src/live-webrtc-server.js";
import { runRealtimeDelegations } from "@zhivex-ai/core/realtime";
import type { RealtimeConnection, RealtimeEvent } from "@zhivex-ai/core/runtime";
import fixture from "./fixtures/live-webrtc-contract.json";

class Track {
  enabled = true;
  kind = "audio";
  stop = vi.fn();
  clones: Track[] = [];
  clone() { const t = new Track(); this.clones.push(t); return t as unknown as MediaStreamTrack; }
}
class Channel {
  readyState = "open";
  bufferedAmount = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  autoClose = true;
  sent: any[] = [];
  send(raw: string) { const p = JSON.parse(raw); this.sent.push(p); if (p.type === "session.close" && this.autoClose) this.push(fixture.closed); }
  push(p: unknown) { this.onmessage?.({ data: JSON.stringify(p) }); }
  close = vi.fn();
}
class Peer extends EventTarget {
  channel = new Channel();
  localDescription: { sdp: string } | null = null;
  iceGatheringState = "complete";
  connectionState = "connected";
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  autoStart = true;
  addTrack = vi.fn();
  createDataChannel = vi.fn((_name: string) => this.channel);
  createOffer = vi.fn(async () => ({ type: "offer", sdp: fixture.offer }));
  setLocalDescription = vi.fn(async (offer: { sdp: string }) => { this.localDescription = offer; });
  setRemoteDescription = vi.fn(async () => { if (this.autoStart) this.channel.push(fixture.started); });
  close = vi.fn();
}
function setup(overrides: Partial<OpenAILiveWebRTCOptions> = {}) {
  const peer = new Peer(), source = new Track();
  const exchangeSdp = vi.fn(async () => fixture.answer as any), releaseSession = vi.fn(async () => {});
  const options: OpenAILiveWebRTCOptions = { mediaStream: { getAudioTracks: () => [source as any] } as MediaStream, exchangeSdp, releaseSession, peerConnectionFactory: () => peer as any, timeoutMs: 100, ...overrides };
  return { peer, source, options, exchangeSdp, releaseSession };
}
async function events(session: { eventStream(): AsyncIterable<RealtimeEvent> }) { const result = []; for await (const event of session.eventStream()) result.push(event); return result; }

describe("experimental GPT-Live browser transport", () => {
  it("waits for session.started; sends no session.start; owns audio clones and uses app playback", async () => {
    const t = setup({ onTrack: vi.fn() }); t.peer.autoStart = false;
    const pending = connect(t.options);
    await vi.waitFor(() => expect(t.peer.setRemoteDescription).toHaveBeenCalled());
    expect(t.source.clones[0].enabled).toBe(false);
    expect(t.peer.channel.sent).toEqual([]);
    expect(t.peer.createDataChannel).toHaveBeenCalledWith("oai-events");
    expect(t.exchangeSdp.mock.calls[0][0]).toMatchObject({ offerSdp: fixture.offer });
    t.peer.channel.push(fixture.started);
    const session = await pending;
    expect(session.sessionId).toBe(fixture.answer.session.id);
    expect(t.source.clones[0].enabled).toBe(true);
    t.peer.ontrack?.({ track: {} } as RTCTrackEvent); expect(t.options.onTrack).toHaveBeenCalled();
    t.peer.channel.push(fixture.transcript);
    await session.setInputMuted(true);
    expect(t.peer.channel.sent.at(-1)).toEqual({ type: "session.input_audio.mute" });
    expect(t.peer.close).not.toHaveBeenCalled();
    await expect(session.sendAudio({ audio: new Uint8Array(2), mediaType: "audio/pcm" })).rejects.toThrow("tracks");
    await expect(session.appendContext!({ kind: "instructions", content: "private" })).rejects.toThrow("sideband");
    const seen = events(session);
    await session.close(); await session.close();
    expect((await seen).some(event => event.type === "realtime-transcript" && event.startMs === 0)).toBe(true);
    expect((await seen).at(-1)).toMatchObject({ type: "realtime-end", providerMetadata: { usage: { seconds: 3 } } });
    expect(t.peer.close).toHaveBeenCalledTimes(1); expect(t.source.stop).not.toHaveBeenCalled(); expect(t.source.clones[0].stop).toHaveBeenCalledTimes(1);
    expect(t.releaseSession).not.toHaveBeenCalled();
  });
  it("keeps media alive until final close acknowledgement", async () => {
    const t = setup(); t.peer.channel.autoClose = false; const s = await connect(t.options);
    const closing = s.close(); await vi.waitFor(() => expect(t.peer.channel.sent).toHaveLength(1));
    expect(t.peer.close).not.toHaveBeenCalled();
    t.peer.channel.push(fixture.closed); await closing; expect(t.peer.close).toHaveBeenCalledOnce();
  });
  it.each(["offer", "ice", "exchange", "answer", "started"])("bounds pending %s work and cleans resources", async phase => {
    const t = setup({ timeoutMs: 10 });
    if (phase === "offer") t.peer.createOffer = vi.fn(() => new Promise(() => {}));
    if (phase === "ice") t.peer.iceGatheringState = "gathering";
    if (phase === "exchange") t.options.exchangeSdp = () => new Promise(() => {});
    if (phase === "answer") t.peer.setRemoteDescription = vi.fn(() => new Promise(() => {}));
    if (phase === "started") t.peer.autoStart = false;
    await expect(connect(t.options)).rejects.toThrow(/timed out/i);
    expect(t.peer.close).toHaveBeenCalledOnce(); expect(t.source.stop).not.toHaveBeenCalled();
    if (["answer", "started"].includes(phase)) expect(t.releaseSession).toHaveBeenCalledOnce();
  });
  it("cancels an exchange that ignores abort and cleans a late known session once", async () => {
    const controller = new AbortController(); let reply!: (value: any) => void;
    const t = setup({ signal: controller.signal, exchangeSdp: () => new Promise(resolve => { reply = resolve; }) });
    const pending = connect(t.options); await vi.waitFor(() => expect(reply).toBeDefined());
    controller.abort(); await expect(pending).rejects.toThrow(); reply(fixture.answer);
    await vi.waitFor(() => expect(t.releaseSession).toHaveBeenCalledOnce()); expect(t.peer.setRemoteDescription).not.toHaveBeenCalled();
  });
  it("fails closed on peer failure during ICE gathering", async () => {
    const t = setup(); t.peer.iceGatheringState = "gathering"; const pending = connect(t.options);
    await vi.waitFor(() => expect(t.peer.localDescription).not.toBeNull());
    t.peer.connectionState = "closed"; t.peer.onconnectionstatechange?.();
    await expect(pending).rejects.toThrow("connection lost"); expect(t.exchangeSdp).not.toHaveBeenCalled();
  });
  it("lifetime cancellation releases known provider session and stops only clones", async () => {
    const controller = new AbortController(), t = setup({ signal: controller.signal }); const s = await connect(t.options); const seen = events(s);
    controller.abort(); await seen; await vi.waitFor(() => expect(t.releaseSession).toHaveBeenCalledOnce()); expect(t.source.stop).not.toHaveBeenCalled();
  });
  it.each(["malformed", "oversized", "binary", "mismatch", "invalid-final", "channel-error", "channel-close"])("handles %s events as unconfirmed failures", async kind => {
    const t = setup(), s = await connect(t.options), seen = events(s);
    if (kind === "malformed") t.peer.channel.onmessage?.({ data: "{" });
    if (kind === "oversized") t.peer.channel.push({ type: "other", delta: "a".repeat(65536) });
    if (kind === "binary") t.peer.channel.onmessage?.({ data: new Uint8Array(4) });
    if (kind === "mismatch") t.peer.channel.push({ type: "session.started", session: { id: "other" } });
    if (kind === "invalid-final") t.peer.channel.push({ type: "session.closed", session: { id: s.sessionId } });
    if (kind === "channel-error") t.peer.channel.onerror?.();
    if (kind === "channel-close") t.peer.channel.onclose?.();
    expect((await seen).some(event => event.type === "realtime-error")).toBe(true);
    expect(t.releaseSession).toHaveBeenCalledOnce();
  });
  it("propagates provider errors/refusals and preserves error metadata", async () => {
    const t = setup(), s = await connect(t.options), seen = events(s);
    t.peer.channel.push({ type: "error", error: { code: "content", message: "Blocked" } });
    expect(await seen).toContainEqual(expect.objectContaining({ type: "realtime-error", message: "Blocked", providerMetadata: { type: "error", error: { code: "content", message: "Blocked" } } }));
  });
  it("reports unconfirmed usage on close timeout and invokes backend cleanup", async () => {
    const t = setup({ closeTimeoutMs: 10 }); t.peer.channel.autoClose = false; const s = await connect(t.options);
    await expect(s.close()).rejects.toThrow("unconfirmed"); expect(t.releaseSession).toHaveBeenCalledOnce(); expect(t.peer.close).toHaveBeenCalledOnce();
  });
  it("bounds incoming queues before initialization and outgoing buffered bytes", async () => {
    const incoming = setup(); incoming.peer.setRemoteDescription = vi.fn(async () => { for (let i = 0; i < 129; i++) incoming.peer.channel.push({ type: "event" }); });
    await expect(connect(incoming.options)).rejects.toThrow("queue limit");
    const outgoing = setup(), s = await connect(outgoing.options); outgoing.peer.channel.bufferedAmount = 256 * 1024;
    await expect(s.setInputMuted(true)).rejects.toThrow("buffer limit"); expect(outgoing.releaseSession).toHaveBeenCalledOnce();
  });
  it("does not open WebRTC on an already-aborted signal or invalid browser/options", async () => {
    const t = setup({ signal: AbortSignal.abort() }); await expect(connect(t.options)).rejects.toThrow(); expect(t.peer.createDataChannel).not.toHaveBeenCalled();
    await expect(connect({ ...t.options, signal: undefined, peerConnectionFactory: undefined })).rejects.toThrow("does not support");
    await expect(connect({ ...t.options, modelId: "gpt-realtime" })).rejects.toThrow("GPT-Live");
    await expect(connect({ ...t.options, closeTimeoutMs: -1 })).rejects.toThrow("timeout");
  });
});

describe("trusted Live WebRTC server contract", () => {
  it("uses JSON Live endpoint, client delegation and frontend permissions; strips unknown fields/secrets", async () => {
    const fetcher = vi.fn(async () => Response.json({ ...fixture.answer, secret: "never", session: { ...fixture.answer.session, instructions: "private", apiKey: "never" } }, { status: 201 }));
    const answer = await create({ apiKey: "server-only", safetyIdentifier: "user-hash", offerSdp: fixture.offer, fetch: fetcher, session: { instructions: "Delegate", voice: "marin" } });
    expect(answer).toEqual(fixture.answer); expect(JSON.stringify(answer)).not.toMatch(/private|never|server-only/);
    const [url, request] = fetcher.mock.calls[0] as any;
    expect(url).toBe("https://api.openai.com/v1/live/sessions"); expect(request.redirect).toBe("error"); expect(request.headers.authorization).toBe("Bearer server-only");
    const payload = JSON.parse(request.body); expect(payload.transport).toEqual({ type: "webrtc", sdp: fixture.offer });
    expect(payload.session).toMatchObject({ model: "gpt-live-1", delegation: { type: "client" }, store: false, client: { data_channel: { allowed_client_events: ["session.close", "session.input_audio.mute", "session.input_audio.unmute"] } } });
    expect(payload.session.audio.format).toBeUndefined();
  });
  it("binds a known ID for cleanup before rejecting a malformed answer or late cancellation", async () => {
    const bind = vi.fn(), controller = new AbortController();
    const options = { apiKey: "key", offerSdp: fixture.offer, onSessionCreated: bind };
    await expect(create({ ...options, fetch: async () => Response.json({ session: fixture.answer.session, transport: { type: "wrong" } }) })).rejects.toThrow("answer");
    expect(bind).toHaveBeenCalledWith({ sessionId: fixture.answer.session.id });
    await expect(create({ ...options, signal: controller.signal, fetch: async () => Response.json(fixture.answer), onSessionCreated: input => { bind(input); controller.abort(); } })).rejects.toThrow();
    expect(bind).toHaveBeenCalledTimes(2);
  });
  it("does not retry or expose provider error bodies", async () => {
    const fetcher = vi.fn(async () => new Response("server-secret", { status: 429 }));
    await expect(create({ apiKey: "key", offerSdp: fixture.offer, fetch: fetcher })).rejects.toThrow("429"); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{ offerSdp: "bad" }, { modelId: "gpt-realtime" }, { session: { inputSampleRateHz: 24000 } }, { session: { tools: {} } }, { session: { providerOptions: { apiKey: "bad" } } }, { apiKey: "" }])("rejects invalid settings before a request", async invalid => {
    const fetcher = vi.fn(); await expect(create({ apiKey: "key", offerSdp: fixture.offer, fetch: fetcher, ...invalid } as any)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds response size and validates response shape", async () => {
    await expect(create({ apiKey: "key", offerSdp: fixture.offer, fetch: async () => Response.json({ ...fixture.answer, huge: "x".repeat(128 * 1024) }) })).rejects.toThrow();
    await expect(create({ apiKey: "key", offerSdp: fixture.offer, fetch: async () => Response.json({ session: fixture.answer.session, transport: { type: "realtime", sdp: fixture.offer } }) })).rejects.toThrow("answer");
  });
});

class Sideband implements RealtimeConnection {
  sent: any[] = []; queue: any[] = []; waiter?: (value: unknown) => void;
  push(p: unknown) { if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(p); } else this.queue.push(p); }
  async sendJson(p: Record<string, unknown>) { this.sent.push(p); if (p.type === "session.close") this.push(fixture.closed); }
  async recvJson() { return this.queue.length ? this.queue.shift() : new Promise(resolve => { this.waiter = resolve; }); }
  async close() { this.push(undefined); }
}
it("attaches one trusted sideband and runs the existing delegation backend with exact IDs/transcripts", async () => {
  const connection = new Sideband(), factory = vi.fn(async () => connection);
  const session = await attach({ apiKey: "key", sessionId: fixture.answer.session.id, safetyIdentifier: "user-hash", connectionFactory: factory });
  expect(factory.mock.calls[0][0]).toBe("wss://api.openai.com/v1/live/sessions/live_test_opaque/attach"); expect(connection.sent).toEqual([]);
  const backend = runRealtimeDelegations(session, { onDelegation: async ({ delegation, transcripts, sendUpdate }) => {
    expect(delegation.delegationId).toBe("delegation_opaque"); expect(transcripts[0].text).toBe("Synthetic task");
    await sendUpdate({ kind: "commentary", content: "Verified backend result" });
  } });
  connection.push(fixture.transcript); connection.push(fixture.delegation);
  await vi.waitFor(() => expect(connection.sent).toContainEqual({ type: "session.commentary.append", content: "Verified backend result", delegation_id: "delegation_opaque" }));
  await session.close(); await backend; expect(connection.sent.some(p => p.type === "session.start")).toBe(false);
});
