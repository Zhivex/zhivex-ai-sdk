import { ConfigurationError, ProviderHTTPError, readBodyWithLimit, assertTrustedEndpoint, withTimeoutSignal } from "@zhivex-ai/core/provider";

export interface QwenSDPExchangeInput { modelId: string; offerSdp: string; signal?: AbortSignal }
export type QwenSDPExchange = (input: QwenSDPExchangeInput) => Promise<string>;
const MAX_BYTES = 1024 * 1024;
const model = (id: string) => { if (!/^qwen3\.(8|5)-omni-(flash|plus)-realtime(?:-|$)/.test(id)) throw new ConfigurationError("This WebRTC integration requires a Qwen Omni realtime model."); };
const sdp = (value: string) => {
  if (typeof value !== "string" || !value.trim().startsWith("v=0") || new TextEncoder().encode(value).length > MAX_BYTES) throw new ConfigurationError("Invalid or oversized SDP.");
  return value.trim().replace(/\r?\n/g, "\r\n") + "\r\n";
};
/** Server-side SDP proxy. Never instantiate this with a long-lived API key in a browser. */
export const createQwenSDPExchange = (options: { apiKey: string; taskBaseURL?: string; fetch?: typeof globalThis.fetch }): QwenSDPExchange => {
  const base = assertTrustedEndpoint(options.taskBaseURL ?? "https://maas.qwencloudapi.com/api/v1", { label: "Qwen WebRTC base URL", protocols: ["https"] }).toString().replace(/\/$/, "");
  return async input => {
    model(input.modelId);
    const body = sdp(input.offerSdp);
    const { signal, cleanup } = withTimeoutSignal({ abortSignal: input.signal, timeoutMs: 30_000 });
    try {
      const response = await (options.fetch ?? globalThis.fetch)(`${base}/webrtc/realtime?model=${encodeURIComponent(input.modelId)}`, {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/sdp" }, body, signal,
      });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderHTTPError("Qwen WebRTC SDP exchange failed.", response.status); }
      return sdp(new TextDecoder().decode(await readBodyWithLimit(response, { maxBytes: MAX_BYTES, provider: "qwen", endpoint: "webrtc/realtime" })));
    } finally { cleanup(); }
  };
};

export interface QwenWebRTCSession {
  readonly peerConnection: RTCPeerConnection;
  sendEvent(event: Record<string, unknown>): void;
  setInputMuted(muted: boolean): void;
  close(): void;
}
export interface QwenWebRTCOptions {
  modelId: string;
  /** Already-permissioned application stream. The connector uses clones and never stops caller tracks. */
  mediaStream: MediaStream;
  /** Calls your authenticated AppServer, which proxies the SDP request. */
  exchangeSdp: QwenSDPExchange;
  session?: Record<string, unknown>;
  onEvent?: (event: Record<string, unknown>) => void;
  onTrack?: (event: RTCTrackEvent) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  peerConnectionFactory?: () => RTCPeerConnection;
}
const validateWebRTCSession = (session: Record<string, unknown>) => {
  const vad = session.turn_detection as Record<string, unknown> | null | undefined;
  if (vad === null || vad?.type !== undefined && !["server_vad", "semantic_vad"].includes(String(vad.type))) throw new ConfigurationError("Qwen WebRTC requires server_vad or semantic_vad; manual mode is unsupported.");
};
/** Native browser WebRTC. Audio/video use media tracks; control events use RTCDataChannel. */
export const connectQwenWebRTC = async (options: QwenWebRTCOptions): Promise<QwenWebRTCSession> => {
  model(options.modelId);
  const config = { modalities: ["text", "audio"], voice: "Tina", turn_detection: { type: "server_vad" }, ...options.session };
  validateWebRTCSession(config);
  if (!options.mediaStream.getAudioTracks().length) throw new ConfigurationError("WebRTC requires an audio track.");
  const { signal, cleanup } = withTimeoutSignal({ abortSignal: options.signal, timeoutMs: options.timeoutMs ?? 15_000 });
  const pc = (() => {
    try { return (options.peerConnectionFactory ?? (() => new RTCPeerConnection({ iceServers: [] })))(); }
    catch (error) { cleanup(); throw error; }
  })();
  const tracks: Array<{ track: MediaStreamTrack; sender: RTCRtpSender }> = [];
  const channels = new Set<RTCDataChannel>();
  let control: RTCDataChannel | undefined;
  let closed = false, ready = false, muted = false, updateSent = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void readyPromise.catch(() => {});
  const bounded = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, readyPromise.then(() => new Promise<never>(() => {}))]);
  const close = () => {
    if (closed) return;
    closed = true; cleanup(); options.signal?.removeEventListener("abort", onCallerAbort);
    signal.removeEventListener("abort", onAbort);
    for (const channel of channels) { channel.onmessage = null; channel.onerror = null; channel.close(); }
    pc.ondatachannel = null; pc.ontrack = null; pc.onconnectionstatechange = null;
    for (const entry of tracks) entry.track.stop();
    pc.close();
  };
  const fail = (error: Error) => { rejectReady(error); close(); try { options.onError?.(error); } catch { /* User callback cannot prevent teardown. */ } };
  const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("WebRTC connection aborted."));
  const onCallerAbort = () => fail(options.signal?.reason instanceof Error ? options.signal.reason : new Error("WebRTC session aborted."));
  const send = (event: Record<string, unknown>) => {
    if (closed || !control || control.readyState !== "open") throw new ConfigurationError("WebRTC data channel is not open.");
    if (event.type === "session.update") validateWebRTCSession(event.session as Record<string, unknown> ?? {});
    if (["input_audio_buffer.commit", "input_audio_buffer.append", "input_image_buffer.append"].includes(String(event.type))) throw new ConfigurationError("WebRTC media uses tracks and server VAD.");
    const json = JSON.stringify(event);
    if (new TextEncoder().encode(json).length > MAX_BYTES || control.bufferedAmount > MAX_BYTES) throw new ConfigurationError("WebRTC data channel buffer limit exceeded.");
    control.send(json);
  };
  const attach = (channel: RTCDataChannel) => {
    channels.add(channel);
    channel.onerror = () => fail(new Error("WebRTC data channel failed."));
    channel.onmessage = message => {
      void (async () => {
        if (closed) return;
        if (typeof message.data !== "string" || new TextEncoder().encode(message.data).length > MAX_BYTES) throw new ConfigurationError("Invalid or oversized WebRTC event.");
        const event = JSON.parse(message.data);
        if (!event || typeof event !== "object" || typeof event.type !== "string") throw new ConfigurationError("Invalid WebRTC event.");
        control = channel;
        if (event.type === "error") throw new Error("Qwen WebRTC returned a session error.");
        if (event.type === "session.created" && !updateSent) { updateSent = true; send({ type: "session.update", session: config }); }
        if (event.type === "session.updated" && updateSent && !ready) {
          ready = true;
          for (const entry of tracks) { if (closed) return; await entry.sender.replaceTrack(entry.track); entry.track.enabled = !muted; }
          if (closed) return;
          if (signal.aborted) { onAbort(); return; }
          cleanup(); signal.removeEventListener("abort", onAbort);
          options.signal?.addEventListener("abort", onCallerAbort, { once: true });
          if (options.signal?.aborted) { onCallerAbort(); return; }
          resolveReady();
        }
        options.onEvent?.(event);
      })().catch(error => fail(error instanceof Error ? error : new Error("Invalid WebRTC event.")));
    };
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    pc.ontrack = event => options.onTrack?.(event);
    pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState) && !closed) fail(new Error("WebRTC connection ended.")); };
    pc.ondatachannel = event => attach(event.channel);
    for (const source of options.mediaStream.getTracks()) {
      const track = source.clone(); track.enabled = false;
      const sender = pc.addTrack(track, options.mediaStream);
      tracks.push({ track, sender });
      await bounded(sender.replaceTrack(null));
    }
    const local = pc.createDataChannel("oai-events"); attach(local); control = local;
    const offer = await bounded(pc.createOffer()); await bounded(pc.setLocalDescription(offer));
    if (pc.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => { pc.removeEventListener("icegatheringstatechange", check); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
      const check = () => { if (pc.iceGatheringState === "complete") finish(); };
      const abort = () => finish(signal.reason);
      pc.addEventListener("icegatheringstatechange", check); signal.addEventListener("abort", abort, { once: true }); check(); if (signal.aborted) abort();
    });
    const answer = await bounded(options.exchangeSdp({ modelId: options.modelId, offerSdp: sdp(pc.localDescription?.sdp ?? ""), signal }));
    if (closed) throw signal.reason ?? new Error("WebRTC closed during signaling.");
    await bounded(pc.setRemoteDescription({ type: "answer", sdp: sdp(answer) }));
    await readyPromise;
    return { peerConnection: pc, sendEvent: send, setInputMuted(value) { if (closed) throw new ConfigurationError("WebRTC session is closed."); muted = value; for (const entry of tracks) entry.track.enabled = ready && !muted; }, close };
  } catch (error) { close(); throw error; }
};

export interface QwenAOQEngine<TConnection, TTrack> {
  connect(config: TConnection): void | Promise<void>;
  disconnect(): void | Promise<void>;
  enableSendMediaStream(track: TTrack, enabled: boolean): void | Promise<void>;
  sendDataMsg(message: { data: ArrayBuffer }): void | Promise<void>;
}
export interface QwenAOQBridgeOptions<TConnection, TTrack> {
  engine: QwenAOQEngine<TConnection, TTrack>;
  /** Credential/configuration object issued for the official SDK; never a permanent API key. */
  connection: TConnection;
  /** Official SDK enum values for upstream audio/video; omit the data track. */
  mediaTracks: readonly TTrack[];
  session?: Record<string, unknown>;
  /** Adapt official onConnectionStatusChange/onDataMsg/onError callbacks. Return an unsubscribe function. */
  subscribe(handlers: { connected(): void; data(data: ArrayBuffer | Uint8Array | string): void; error(error: Error): void }): () => void;
  onEvent?: (event: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface QwenAOQSession {
  sendEvent(event: Record<string, unknown>): Promise<void>;
  setInputMuted(muted: boolean): Promise<void>;
  close(): Promise<void>;
}
/** Optional bridge to an application-owned official AOQ native SDK, not an implementation of QUIC. */
export const connectQwenAOQ = async <TConnection, TTrack>(options: QwenAOQBridgeOptions<TConnection, TTrack>): Promise<QwenAOQSession> => {
  if (!options.mediaTracks.length) throw new ConfigurationError("AOQ requires upstream media track enum values.");
  const { signal, cleanup } = withTimeoutSignal({ abortSignal: options.signal, timeoutMs: options.timeoutMs ?? 15_000 });
  let closed = false, ready = false, connected = false;
  let unsubscribe = () => {};
  let resolveReady: () => void = () => {}, rejectReady: (error: Error) => void = () => {};
  const ack = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ack.catch(() => {});
  const gate = async (enabled: boolean) => { for (const track of options.mediaTracks) { if (closed) return; await options.engine.enableSendMediaStream(track, enabled); } };
  const close = async () => {
    if (closed) return;
    closed = true; cleanup(); unsubscribe(); signal.removeEventListener("abort", onAbort); options.signal?.removeEventListener("abort", onCallerAbort);
    await options.engine.disconnect();
  };
  const fail = (error: Error) => { rejectReady(error); void close().catch(() => {}); try { options.onError?.(error); } catch { /* Teardown already started. */ } };
  const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("AOQ initialization aborted."));
  const onCallerAbort = () => fail(options.signal?.reason instanceof Error ? options.signal.reason : new Error("AOQ session aborted."));
  const send = async (event: Record<string, unknown>) => {
    if (closed) throw new ConfigurationError("AOQ session is closed.");
    const bytes = new TextEncoder().encode(JSON.stringify(event));
    if (bytes.length > MAX_BYTES) throw new ConfigurationError("AOQ event exceeds size limit.");
    await options.engine.sendDataMsg({ data: bytes.buffer });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    unsubscribe = options.subscribe({
      connected() {
        if (closed || connected) return;
        connected = true;
        void send({ type: "session.update", session: { modalities: ["text", "audio"], voice: "Tina", turn_detection: { type: "semantic_vad" }, ...options.session } }).catch(fail);
      },
      data(data) {
        if (closed) return;
        void (async () => {
          const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
          if (bytes.length > MAX_BYTES) throw new ConfigurationError("AOQ event exceeds size limit.");
          const event = JSON.parse(new TextDecoder().decode(bytes));
          if (!event || typeof event.type !== "string") throw new ConfigurationError("Invalid AOQ event.");
          if (event.type === "error") throw new Error("Qwen AOQ returned a session error.");
          if (event.type === "session.updated" && connected && !ready) {
            ready = true; await gate(true);
            if (closed) return;
            if (signal.aborted) { onAbort(); return; }
            cleanup(); signal.removeEventListener("abort", onAbort); options.signal?.addEventListener("abort", onCallerAbort, { once: true });
            if (options.signal?.aborted) { onCallerAbort(); return; }
            resolveReady();
          }
          options.onEvent?.(event);
        })().catch(fail);
      },
      error: fail,
    });
    await Promise.race([(async () => { await gate(false); if (!closed) await options.engine.connect(options.connection); })(), ack]);
    await ack;
    return { sendEvent: send, async setInputMuted(muted) { if (closed) throw new ConfigurationError("AOQ session is closed."); await gate(!muted); }, close };
  } catch (error) { await close(); throw error; }
};
