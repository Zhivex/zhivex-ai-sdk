import {
  ConfigurationError, ProviderHTTPError, assertTrustedEndpoint, openWebSocketConnection, readJsonWithLimit, withTimeoutSignal,
  type RealtimeConnectionFactory, type RealtimeConnectOptions, type RealtimeSessionConfig
} from "@zhivex-ai/core/provider";
import { liveAudioCallbacks } from "./live-audio.js";
import { createLiveSession, isOpenAILiveModel, resolveLiveWebRTCConfig } from "./live-session.js";
import { liveAnswer, liveSdp, liveSessionId, type OpenAILiveWebRTCAnswer } from "./live-webrtc-protocol.js";
export type { OpenAILiveWebRTCAnswer } from "./live-webrtc-protocol.js";

export interface OpenAILiveServerOptions {
  /** Trusted server only. No environment lookup or browser credential flow. */
  apiKey: string;
  fetch?: typeof fetch;
  safetyIdentifier?: string;
}
export interface OpenAILiveWebRTCCreateOptions extends OpenAILiveServerOptions, Pick<RealtimeConnectOptions, "signal" | "timeoutMs"> {
  modelId?: string;
  offerSdp: string;
  session?: RealtimeSessionConfig;
  /** Bind the known ID to an application creation lease before delivering the answer. */
  onSessionCreated?: (input: { sessionId: string }) => void | Promise<void>;
}
const headers = (options: OpenAILiveServerOptions) => {
  if (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new ConfigurationError("A server API key is required.");
  if (options.safetyIdentifier !== undefined && (!/^[\x21-\x7e]{1,256}$/.test(options.safetyIdentifier))) throw new ConfigurationError("Invalid safety identifier.");
  return { authorization: `Bearer ${options.apiKey}`, ...(options.safetyIdentifier ? { "OpenAI-Safety-Identifier": options.safetyIdentifier } : {}) };
};
/** Experimental trusted-server SDP exchange. One request, no retries. */
export async function experimentalCreateOpenAILiveWebRTCSession(options: OpenAILiveWebRTCCreateOptions): Promise<OpenAILiveWebRTCAnswer> {
  const modelId = options.modelId ?? "gpt-live-1";
  if (!isOpenAILiveModel(modelId)) throw new ConfigurationError("A supported GPT-Live-1 model is required.");
  const config = resolveLiveWebRTCConfig(options.session);
  const requestHeaders = headers(options);
  const body = JSON.stringify({ session: {
    model: modelId, delegation: { type: "client" }, store: config.providerOptions?.store ?? false,
    ...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
    audio: { output: { voice: config.voice ?? "marin" } },
    ...(config.providerOptions?.input !== undefined ? { input: config.providerOptions.input } : {}),
    // The browser may close/mute, but cannot append instructions or backend results.
    client: { data_channel: {
      allowed_client_events: ["session.close", "session.input_audio.mute", "session.input_audio.unmute"],
      allowed_server_events: ["session.started", "session.closed", "session.input_transcript.delta", "session.output_transcript.delta", "session.usage.updated", "error"].map(type => ({ type }))
    } }
  }, transport: { type: "webrtc", sdp: liveSdp(options.offerSdp) } });
  if (new TextEncoder().encode(body).length > 256 * 1024) throw new ConfigurationError("GPT-Live session request exceeds 256 KiB.");
  const deadline = withTimeoutSignal({ timeoutMs: options.timeoutMs ?? 15_000, abortSignal: options.signal });
  try {
    deadline.signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)("https://api.openai.com/v1/live/sessions", {
      method: "POST", headers: { ...requestHeaders, "content-type": "application/json" }, body, signal: deadline.signal, redirect: "error"
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderHTTPError(`OpenAI Live session creation failed (${response.status}).`, response.status);
    }
    const raw = await readJsonWithLimit<any>(response, { maxBytes: 128 * 1024, provider: "openai", endpoint: "live/sessions", abort: deadline.abort });
    // Record a valid ID even if the remaining response is malformed or the caller aborted.
    const sessionId = liveSessionId(raw?.session?.id);
    await options.onSessionCreated?.({ sessionId });
    deadline.signal.throwIfAborted();
    return liveAnswer(raw);
  } finally { deadline.cleanup(); }
}
export interface OpenAILiveAttachOptions extends OpenAILiveServerOptions, RealtimeConnectOptions {
  /** Authorize this ID against the authenticated user's server-side session record first. */
  sessionId: string;
  modelId?: string;
  session?: RealtimeSessionConfig;
  connectionFactory?: RealtimeConnectionFactory;
}
/** Experimental sideband for runRealtimeDelegations. Does not start another paid session. */
export async function experimentalAttachOpenAILiveSession(options: OpenAILiveAttachOptions) {
  const modelId = options.modelId ?? "gpt-live-1";
  if (!isOpenAILiveModel(modelId)) throw new ConfigurationError("A supported GPT-Live-1 model is required.");
  const config = resolveLiveWebRTCConfig(options.session);
  const url = assertTrustedEndpoint(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(liveSessionId(options.sessionId))}/attach`, {
    label: "OpenAI Live sideband", protocols: ["wss"], allowedHosts: ["api.openai.com"]
  });
  const connection = await (options.connectionFactory ?? openWebSocketConnection)(url.toString(), headers(options), { signal: options.signal, timeoutMs: options.timeoutMs ?? 15_000, maxIncomingFrameBytes: options.maxIncomingFrameBytes, subprotocols: options.subprotocols });
  // Attachment observes an already-running session: no session.start or started wait.
  const reflected = { ...config, outputAudioMediaType: "audio/pcm", outputSampleRateHz: 24000 };
  const session = createLiveSession(modelId, reflected, connection, { started: true, attached: true, parseOutputAudio: liveAudioCallbacks(reflected).parseOutputAudio });
  try { await session.initialize(); } catch (error) { await connection.close(); throw error; }
  return Object.assign(session, {
    sessionId: options.sessionId,
    /** Detach only; the primary session continues billing. close() ends the shared session. */
    disconnect: () => connection.close()
  });
}
