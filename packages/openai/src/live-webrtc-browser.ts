import { ConfigurationError, withTimeoutSignal, type RealtimeSession, type RealtimeConnection } from "@zhivex-ai/core/runtime";
import { createLiveSession, isOpenAILiveModel } from "./live-session.js";
import { liveAnswer, liveSdp, liveSessionId, type OpenAILiveWebRTCAnswer } from "./live-webrtc-protocol.js";
export type { OpenAILiveWebRTCAnswer } from "./live-webrtc-protocol.js";

export interface OpenAILiveWebRTCOptions {
  modelId?: string;
  /** Application-permissioned stream. SDK owns only audio clones; never captures devices. */
  mediaStream: MediaStream;
  /** Call your authenticated backend. Keep configuration and credentials there. */
  exchangeSdp(input: { offerSdp: string; signal: AbortSignal }): Promise<OpenAILiveWebRTCAnswer>;
  /** Close a known session via your authorized backend if handshake/connection fails.
   * The backend also needs a creation lease for cancellation before an ID reaches the browser. */
  releaseSession(input: { sessionId: string }): Promise<void>;
  onTrack?: (event: RTCTrackEvent) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  peerConnectionFactory?: () => RTCPeerConnection;
}
export interface OpenAILiveWebRTCSession extends RealtimeSession {
  readonly sessionId: string;
  readonly peerConnection: RTCPeerConnection;
}

/** Experimental browser transport over the shared RealtimeSession lifecycle. */
export async function experimentalConnectOpenAILiveWebRTC(options: OpenAILiveWebRTCOptions): Promise<OpenAILiveWebRTCSession> {
  const modelId = options.modelId ?? "gpt-live-1";
  if (!isOpenAILiveModel(modelId)) throw new ConfigurationError("A supported GPT-Live-1 model is required.");
  if (typeof options.exchangeSdp !== "function" || typeof options.releaseSession !== "function") throw new ConfigurationError("Application SDP exchange and session cleanup callbacks are required.");
  if (!options.mediaStream?.getAudioTracks().length) throw new ConfigurationError("WebRTC requires an application-provided audio track.");
  if (options.closeTimeoutMs !== undefined && (!Number.isSafeInteger(options.closeTimeoutMs) || options.closeTimeoutMs <= 0)) throw new ConfigurationError("Invalid close timeout.");
  if (!options.peerConnectionFactory && typeof globalThis.RTCPeerConnection !== "function") throw new ConfigurationError("This browser does not support RTCPeerConnection.");
  const deadline = withTimeoutSignal({ timeoutMs: options.timeoutMs ?? 15_000, abortSignal: options.signal });
  let pc: RTCPeerConnection;
  try { deadline.signal.throwIfAborted(); pc = (options.peerConnectionFactory ?? (() => new RTCPeerConnection({ iceServers: [] })))(); }
  catch (error) { deadline.cleanup(); throw error; }
  const tracks: MediaStreamTrack[] = [];
  const enabled: boolean[] = [];
  let channel: RTCDataChannel | undefined;
  let closed = false, acknowledged = false, sessionId: string | undefined;
  let failure: Error | undefined;
  let receiver: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  const queue: Array<{ payload: unknown; bytes: number }> = [];
  let queuedBytes = 0;
  let released: Promise<void> | undefined;
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  void interrupted.catch(() => {});
  const bounded = <T>(promise: Promise<T>) => Promise.race([promise, interrupted]);
  const report = (error: Error) => { try { options.onError?.(error); } catch { /* Teardown must proceed. */ } };
  const release = () => {
    if (acknowledged || !sessionId) return Promise.resolve();
    if (!released) {
      // An aborted handshake signal must not cancel the backend's cleanup request.
      released = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([options.releaseSession({ sessionId: sessionId! }), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Backend session cleanup timed out; finalization is unconfirmed.")), 5000);
          })]);
        } catch (error) { report(error instanceof Error ? error : new Error("Backend session cleanup failed; finalization is unconfirmed.")); }
        finally { if (timer) clearTimeout(timer); }
      })();
    }
    return released;
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    deadline.cleanup(); deadline.signal.removeEventListener("abort", abortSetup); options.signal?.removeEventListener("abort", abortCaller);
    pc.ontrack = null; pc.onconnectionstatechange = null;
    if (channel) { channel.onmessage = null; channel.onerror = null; channel.onclose = null; channel.close(); }
    for (const track of tracks) track.stop();
    pc.close();
    queue.length = 0; queuedBytes = 0;
    receiver?.reject(failure ?? new Error("WebRTC connection closed.")); receiver = undefined;
    rejectInterrupted(failure ?? new Error("WebRTC connection closed."));
  };
  const fail = (error: Error) => {
    if (closed || acknowledged) return;
    failure = error; cleanup(); deadline.abort(error); void release(); report(error);
  };
  const abortSetup = () => fail(deadline.signal.reason instanceof Error ? deadline.signal.reason : new Error("WebRTC connection aborted; finalization is unconfirmed."));
  const abortCaller = () => fail(options.signal?.reason instanceof Error ? options.signal.reason : new Error("WebRTC session aborted; finalization is unconfirmed."));
  const connection: RealtimeConnection = {
    async sendJson(payload) {
      if (closed || channel?.readyState !== "open") throw new ConfigurationError("WebRTC data channel is not open.");
      const json = JSON.stringify(payload), bytes = new TextEncoder().encode(json).length;
      if (bytes > 64 * 1024 || bytes + channel.bufferedAmount > 256 * 1024) throw new ConfigurationError("WebRTC outgoing buffer limit exceeded.");
      channel.send(json);
    },
    async recvJson() {
      if (failure) throw failure;
      if (queue.length) { const entry = queue.shift()!; queuedBytes -= entry.bytes; return entry.payload; }
      if (closed) return undefined;
      if (receiver) throw new ConfigurationError("Concurrent WebRTC receives are unsupported.");
      return new Promise((resolve, reject) => { receiver = { resolve, reject }; });
    },
    async close() { cleanup(); await release(); }
  };
  deadline.signal.addEventListener("abort", abortSetup, { once: true });
  try {
    pc.ontrack = event => { try { options.onTrack?.(event); } catch { fail(new Error("Application track callback failed; finalization is unconfirmed.")); } };
    pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState)) fail(new Error("WebRTC connection lost; final usage is unconfirmed.")); };
    for (const source of options.mediaStream.getAudioTracks()) {
      const track = source.clone(); tracks.push(track); enabled.push(source.enabled); track.enabled = false; pc.addTrack(track, options.mediaStream);
    }
    channel = pc.createDataChannel("oai-events");
    channel.onerror = () => fail(new Error("WebRTC data channel failed; finalization is unconfirmed."));
    channel.onclose = () => fail(new Error("WebRTC data channel closed before session.closed; final usage is unconfirmed."));
    channel.onmessage = event => {
      if (closed) return;
      try {
        if (typeof event.data !== "string") throw new Error("WebRTC events must be JSON text.");
        const bytes = new TextEncoder().encode(event.data).length;
        if (bytes > 64 * 1024) throw new Error("WebRTC event exceeds 64 KiB.");
        const payload = JSON.parse(event.data);
        if (!payload || Array.isArray(payload) || typeof payload.type !== "string") throw new Error("Invalid WebRTC event.");
        if (payload.type === "session.started" && payload.session?.id !== sessionId) throw new Error("WebRTC session ID mismatch.");
        if (payload.type === "session.closed") {
          if (payload.session?.id !== sessionId || !Number.isFinite(payload.usage?.seconds) || payload.usage.seconds < 0) throw new Error("Invalid WebRTC finalization event; final usage is unconfirmed.");
          acknowledged = true;
        }
        if (receiver) { const waiter = receiver; receiver = undefined; waiter.resolve(payload); }
        else {
          if (queue.length >= 128 || queuedBytes + bytes > 256 * 1024) throw new Error("WebRTC incoming queue limit exceeded.");
          queue.push({ payload, bytes }); queuedBytes += bytes;
        }
      } catch (error) { fail(error instanceof Error ? error : new Error("Invalid WebRTC event.")); }
    };
    const offer = await bounded(pc.createOffer());
    if (closed) throw failure;
    await bounded(pc.setLocalDescription(offer));
    if (pc.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => { pc.removeEventListener("icegatheringstatechange", check); deadline.signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
      const check = () => { if (pc.iceGatheringState === "complete") finish(); };
      const abort = () => finish(deadline.signal.reason);
      pc.addEventListener("icegatheringstatechange", check); deadline.signal.addEventListener("abort", abort, { once: true }); check(); if (deadline.signal.aborted) abort();
    });
    if (closed) throw failure;
    const exchange = options.exchangeSdp({ offerSdp: liveSdp(pc.localDescription?.sdp), signal: deadline.signal }).then(raw => {
      sessionId = liveSessionId(raw?.session?.id);
      const answer = liveAnswer(raw);
      if (closed) { void release(); throw failure ?? new Error("WebRTC closed during signaling."); }
      return answer;
    });
    const answer = await bounded(exchange);
    await bounded(pc.setRemoteDescription({ type: "answer", sdp: answer.transport.sdp }));
    if (closed) throw failure;
    const session = createLiveSession(modelId, { delegation: { type: "client" }, providerOptions: { closeTimeoutMs: options.closeTimeoutMs } }, connection, { started: true, webrtc: true, timeoutMs: options.timeoutMs });
    await bounded(session.initialize());
    if (closed) throw failure;
    deadline.cleanup(); deadline.signal.removeEventListener("abort", abortSetup);
    options.signal?.addEventListener("abort", abortCaller, { once: true });
    if (options.signal?.aborted) { abortCaller(); throw failure; }
    tracks.forEach((track, index) => { track.enabled = enabled[index]; });
    return Object.assign(session, { sessionId: answer.session.id, peerConnection: pc });
  } catch (error) {
    failure ??= error instanceof Error ? error : new Error("WebRTC setup failed.");
    deadline.abort(failure); cleanup(); await release(); throw failure;
  }
}
