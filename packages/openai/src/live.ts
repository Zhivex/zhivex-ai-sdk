import {
  CallbackRealtimeSession, ConfigurationError, UnsupportedFeatureError, ValidationError,
  assertTrustedEndpoint, decodeBase64WithLimit, encodeAudioFrame,
  type JsonValue, type ModelCapabilities, type RealtimeConnectOptions,
  type RealtimeConnectionFactory, type RealtimeContextUpdate, type RealtimeEvent,
  type RealtimeModel, type RealtimeSessionConfig
} from "@zhivex-ai/core";

export const isOpenAILiveModel = (modelId: string) => /^gpt-live-1(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId);

export const liveCapabilities: ModelCapabilities = {
  streaming: false, tools: false, structuredOutput: false, jsonMode: false,
  toolChoice: false, parallelToolCalls: false, vision: false, files: false,
  audioInput: true, audioOutput: true, embeddings: false, reasoning: false, webSearch: false,
  realtime: {
    sessions: true, audioInput: true, audioOutput: true, imageInput: false,
    tools: false, browserTokens: false, fullDuplex: true, clientDelegation: true
  }
};

const allowedConfig = new Set([
  "mode", "instructions", "voice", "delegation", "inputAudioMediaType", "outputAudioMediaType",
  "inputSampleRateHz", "outputSampleRateHz", "channels", "autoResponse", "providerOptions"
]);
const allowedOptions = new Set(["headers", "safety_identifier", "input", "store", "closeTimeoutMs"]);

function resolveConfig(config: RealtimeSessionConfig) {
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && !allowedConfig.has(key)) throw new UnsupportedFeatureError(`GPT-Live client delegation does not support session option "${key}". Configure tools and reasoning in your backend agent.`);
  }
  if (config.mode !== undefined && config.mode !== "conversation") throw new UnsupportedFeatureError("GPT-Live supports conversation mode only.");
  if (config.autoResponse === true) throw new UnsupportedFeatureError("GPT-Live does not support manual response triggers; stream audio continuously.");
  if (config.delegation && (config.delegation.type !== "client" || Object.keys(config.delegation).some((key) => key !== "type"))) {
    throw new UnsupportedFeatureError("This GPT-Live adapter supports client delegation only.");
  }
  const provider = config.providerOptions ?? {};
  for (const [key, value] of Object.entries(provider)) {
    if (value !== undefined && !allowedOptions.has(key)) throw new UnsupportedFeatureError(`Unsupported GPT-Live provider option "${key}".`);
  }
  if (provider.store !== undefined && typeof provider.store !== "boolean") throw new ConfigurationError("GPT-Live store must be boolean.");
  if (provider.closeTimeoutMs !== undefined && (!Number.isSafeInteger(provider.closeTimeoutMs) || Number(provider.closeTimeoutMs) <= 0)) throw new ConfigurationError("GPT-Live closeTimeoutMs must be a positive safe integer.");
  if (provider.input !== undefined) {
    if (!Array.isArray(provider.input) || provider.input.length > 128) throw new ConfigurationError("GPT-Live input must contain at most 128 text messages.");
    for (const item of provider.input) {
      const part = item?.content?.[0];
      if (item?.type !== "message" || !["developer", "user", "assistant"].includes(item.role) ||
        !Array.isArray(item.content) || item.content.length !== 1 || typeof part?.text !== "string" ||
        !(item.role === "assistant" ? ["text", "output_text"] : ["input_text"]).includes(part.type)) {
        throw new ConfigurationError("GPT-Live history requires developer/user input_text or assistant output_text messages.");
      }
    }
  }
  const mediaType = config.inputAudioMediaType ?? config.outputAudioMediaType ?? "audio/pcm";
  const rate = config.inputSampleRateHz ?? config.outputSampleRateHz ?? (mediaType === "audio/pcm" ? 24000 : 8000);
  if ((mediaType !== "audio/pcm" || ![16000, 24000].includes(rate)) &&
    (!["audio/pcmu", "audio/pcma"].includes(mediaType) || rate !== 8000)) throw new ConfigurationError("GPT-Live requires mono PCM16 at 16/24 kHz or G.711 at 8 kHz.");
  if ((config.channels !== undefined && config.channels !== 1) ||
    (config.outputAudioMediaType !== undefined && config.outputAudioMediaType !== mediaType) ||
    (config.outputSampleRateHz !== undefined && config.outputSampleRateHz !== rate)) throw new ConfigurationError("GPT-Live requires the same mono audio format for input and output.");
  return {
    ...config, delegation: { type: "client" as const }, autoResponse: false,
    inputAudioMediaType: mediaType, outputAudioMediaType: mediaType,
    inputSampleRateHz: rate, outputSampleRateHz: rate, channels: 1
  };
}

/** Server WebSocket adapter. The application owns the delegated agent and its tools. */
export class OpenAILiveModel implements RealtimeModel {
  readonly provider = "openai";
  readonly capabilities = liveCapabilities;
  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly headers: (options: Record<string, unknown> | undefined) => Record<string, string>,
    private readonly connectionFactory: RealtimeConnectionFactory,
    private readonly realtimeURL?: string,
    private readonly allowUnsafeEndpoints = false
  ) {}

  async connect(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions) {
    const resolved = resolveConfig(config);
    const url = new URL(this.baseURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/live/sessions`;
    url.search = "";
    const endpoint = assertTrustedEndpoint(this.realtimeURL ?? url.toString(), {
      label: "OpenAI Live endpoint", protocols: ["wss"],
      allowedHosts: [new URL(this.baseURL).hostname], allowUnsafe: this.allowUnsafeEndpoints
    });
    if (endpoint.search || endpoint.hash) throw new ConfigurationError("GPT-Live WebSocket endpoints must not contain query parameters or fragments.");
    if (options?.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw new ConfigurationError("GPT-Live timeoutMs must be a positive safe integer.");
    const connection = await this.connectionFactory(endpoint.toString(), this.headers(config.providerOptions), options);
    const delegations = new Set<string>();
    const metadata = (payload: Record<string, unknown>) => payload as Record<string, JsonValue>;
    const unsupported = (feature: string): never => { throw new UnsupportedFeatureError(`GPT-Live ${feature}; use the backend agent or appendContext() as appropriate.`); };
    const append = (update: RealtimeContextUpdate) => {
      if (!["instructions", "context", "commentary"].includes(update.kind) || typeof update.content !== "string" || !update.content.trim()) throw new ValidationError("Live context updates require a kind and non-empty string content.");
      if (update.delegationId !== undefined && !delegations.has(update.delegationId)) throw new ValidationError("Unknown GPT-Live client delegation ID.");
      // Tokenization is provider-owned (500 tokens per append); never silently truncate a result.
      return [{ type: `session.${update.kind === "context" ? "thinking" : update.kind}.append`,
        content: update.content, delegation_id: update.delegationId ?? null,
        ...(update.eventId !== undefined ? { event_id: update.eventId } : {}) }];
    };
    const parseEvent = (payload: Record<string, unknown>): RealtimeEvent[] => {
      const type = payload.type;
      if (type === "session.started" || type === "session.updated") return [{ type: "realtime-provider-data", provider: "openai", data: metadata(payload) }];
      if (type === "session.output_audio.delta") {
        if (typeof payload.delta !== "string") throw new ValidationError("Invalid GPT-Live audio delta.");
        const audio = decodeBase64WithLimit(payload.delta, { maxBytes: 16 * 1024 * 1024, provider: "openai", endpoint: "live/sessions" });
        if (resolved.outputAudioMediaType === "audio/pcm" && audio.byteLength % 2) throw new ValidationError("GPT-Live PCM output must contain complete 16-bit samples.");
        return [{ type: "realtime-audio-output", audio, mediaType: resolved.outputAudioMediaType,
          sampleRateHz: resolved.outputSampleRateHz, channels: 1 }];
      }
      if (type === "session.input_transcript.delta" || type === "session.output_transcript.delta") {
        if (typeof payload.delta !== "string") throw new ValidationError("Invalid GPT-Live transcript delta.");
        return [{ type: "realtime-transcript", role: type === "session.input_transcript.delta" ? "user" : "assistant",
          text: payload.delta, isFinal: false,
          ...(typeof payload.start_ms === "number" ? { startMs: payload.start_ms } : {}),
          ...(typeof payload.end_ms === "number" ? { endMs: payload.end_ms } : {}), providerMetadata: metadata(payload) }];
      }
      if (type === "session.delegation.created") {
        const delegation = payload.delegation as Record<string, unknown> | undefined;
        if (!delegation || typeof delegation.id !== "string" || !delegation.id || delegation.target !== "client") throw new ValidationError("Invalid GPT-Live client delegation event.");
        if (!delegations.has(delegation.id) && delegations.size >= 4096) throw new ValidationError("GPT-Live session delegation limit exceeded.");
        delegations.add(delegation.id);
        return [{ type: "realtime-delegation", delegationId: delegation.id,
          ...(typeof payload.offset_ms === "number" ? { offsetMs: payload.offset_ms } : {}), providerMetadata: metadata(payload) }];
      }
      if (type === "session.closed") return [{ type: "realtime-end", reason: "provider-close", providerMetadata: metadata(payload) }];
      if (type === "error") {
        const error = payload.error as Record<string, unknown> | undefined;
        return [{ type: "realtime-error", message: typeof error?.message === "string" ? error.message : "GPT-Live session error", providerMetadata: metadata(payload) }];
      }
      // Usage snapshots, acknowledgements and future control events remain inspectable.
      return [{ type: "realtime-provider-data", provider: "openai", data: metadata(payload) }];
    };
    const session = new CallbackRealtimeSession({
      provider: this.provider, modelId: this.modelId, capabilities: this.capabilities,
      config: resolved, connection, initializationTimeoutMs: options?.timeoutMs ?? 15_000,
      closeTimeoutMs: config.providerOptions?.closeTimeoutMs as number | undefined,
      callbacks: {
        parseEvent,
        isReadyPayload: (p) => p.type === "session.started",
        shouldReplayEvent: (event) => event.type !== "realtime-audio-output",
        isCloseAcknowledgementPayload: (p) => p.type === "session.closed",
        buildInitialPayloads: () => [{ type: "session.start", session: {
          model: this.modelId, ...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
          audio: { format: { type: resolved.inputAudioMediaType, rate: resolved.inputSampleRateHz }, output: { voice: resolved.voice ?? "marin" } },
          delegation: { type: "client" }, store: resolved.providerOptions?.store ?? false,
          ...(resolved.providerOptions?.input !== undefined ? { input: resolved.providerOptions.input } : {})
        } }],
        buildAudioPayloads: (frame) => {
          if (frame.mediaType !== resolved.inputAudioMediaType || (frame.sampleRateHz !== undefined && frame.sampleRateHz !== resolved.inputSampleRateHz) || (frame.channels !== undefined && frame.channels !== 1)) throw new ValidationError("Audio frame does not match the GPT-Live session format; resample it before sending.");
          const audio = encodeAudioFrame(frame);
          const bytes = decodeBase64WithLimit(audio, { maxBytes: 16 * 1024 * 1024, provider: "openai", endpoint: "live/sessions" });
          if (resolved.inputAudioMediaType === "audio/pcm" && bytes.byteLength % 2) throw new ValidationError("GPT-Live PCM input must contain complete 16-bit samples.");
          return [{ type: "session.input_audio.append", audio }];
        },
        buildTextPayloads: () => unsupported("does not accept typed user input on the voice frontend"),
        buildToolResultPayloads: () => unsupported("does not accept Realtime tool results"),
        buildUpdatePayloads: () => unsupported("client sessions have immutable startup configuration"),
        buildContextPayloads: append,
        buildInputMutePayloads: (muted) => [{ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" }],
        buildClosePayloads: () => [{ type: "session.close" }]
      }
    });
    try { await session.initialize(); } catch (error) { await connection.close().catch(() => undefined); throw error; }
    return session;
  }

  async createBrowserToken(): Promise<never> {
    throw new UnsupportedFeatureError("GPT-Live uses server-created WebRTC sessions, not Realtime client secrets. This adapter supports server WebSockets.");
  }
}
