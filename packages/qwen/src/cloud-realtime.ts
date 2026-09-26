import { ConfigurationError, UnsupportedFeatureError, decodeBase64WithLimit,
  type RealtimeSession, type RealtimeSessionConfig, type RealtimeConnection, type AudioFrame,
  type RealtimeEvent, type JsonValue } from "@zhivex-ai/core";

export interface QwenRealtimeMCPServer {
  type: "mcp";
  server_label: string;
  server_url: string;
  authorization?: string;
  headers?: Record<string, string>;
  allowed_tools?: string[];
  require_approval?: "always" | "never";
}
export interface QwenCloudRealtimeOptions extends Record<string, unknown> {
  mcpServers?: QwenRealtimeMCPServer[];
  enable_search?: boolean;
  max_history_turns?: number;
  enable_speech_emotion?: boolean;
  output_audio?: { language?: string };
  audio?: {
    input?: { format?: { type?: "pcm"; sample_rate?: 16000; sample_format?: "s16le"; channels?: 1 | 2 | 4; packing?: "interleaved"; channel_layout?: "mono" | "raw_mic_array" | "foa_ambix" } };
    output?: { voice?: string; format?: { type?: "pcm" | "wav"; sample_rate?: 8000 | 16000 | 24000 | 48000 } };
  };
  video?: { input?: { representation_compact?: "none" | "normal" } };
}
export interface QwenCloudRealtimeSession extends RealtimeSession {
  /** Only acknowledges a pending server approval; never approves calls implicitly. */
  respondToMcpApproval(approvalRequestId: string, approve: boolean): Promise<void>;
  /** Continue after response.done containing server-executed MCP results. */
  createResponse(): Promise<void>;
}
export const isQwenAudioRealtime = (id: string) => /^qwen-audio-3\.[01]-realtime-(plus|flash)(?:-|$)/i.test(id);
export const isQwenOmni38Realtime = (id: string) => /^qwen3\.8-omni-flash-realtime(?:-|$)/i.test(id);
export const isQwenCloudRealtime = (id: string) => isQwenAudioRealtime(id) || isQwenOmni38Realtime(id);

const mcpServer = (server: QwenRealtimeMCPServer) => {
  if (server.type !== "mcp" || !/^[a-zA-Z0-9_-]{1,64}$/.test(server.server_label)) throw new ConfigurationError("Invalid MCP server label.");
  let url: URL;
  try { url = new URL(server.server_url); } catch { throw new ConfigurationError("MCP server_url must be a public HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || server.server_url.length > 4096) throw new ConfigurationError("MCP server_url must be HTTPS port 443 without credentials or fragment.");
  if (server.require_approval !== undefined && !["always", "never"].includes(server.require_approval)) throw new ConfigurationError("Invalid MCP require_approval.");
  if (server.authorization !== undefined && (server.authorization.length > 8192 || !/^[\x20-\x7E]*$/.test(server.authorization))) throw new ConfigurationError("Invalid MCP authorization value.");
  if (server.allowed_tools && (!Array.isArray(server.allowed_tools) || server.allowed_tools.some(name => !/^[\w.-]{1,64}$/.test(name)))) throw new ConfigurationError("Invalid MCP allowed_tools.");
  const headers = Object.entries(server.headers ?? {});
  if (headers.length > 16 || headers.some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || /^(mcp-|proxy-|x-forwarded-)/i.test(name) || /^(host|authorization|connection|content-length|transfer-encoding|accept|content-type|forwarded|cookie|origin|upgrade|te|trailer)$/i.test(name) || typeof value !== "string" || value.length > 8192 || !/^[\x20-\x7E]*$/.test(value))) throw new ConfigurationError("Invalid or prohibited MCP headers.");
  return { ...server, require_approval: server.require_approval ?? "always" };
};

/** Validates cloud-specific fields and combines native MCP with the shared function-tool mapper. */
export const mapQwenCloudRealtimeSession = (id: string, config: RealtimeSessionConfig, base: Record<string, any>) => {
  const options = config.providerOptions as QwenCloudRealtimeOptions | undefined;
  const omni = isQwenOmni38Realtime(id);
  const output: Record<string, any> = { ...base };
  delete output.mcpServers;
  if (config.inputAudioMediaType && config.inputAudioMediaType !== "audio/pcm") throw new ConfigurationError("Qwen realtime input requires PCM16.");
  if (config.inputSampleRateHz !== undefined && config.inputSampleRateHz !== 16000) throw new ConfigurationError("Qwen realtime input requires 16000 Hz.");
  if (options?.audio && !omni) throw new UnsupportedFeatureError("Nested audio format configuration requires Qwen 3.8 Omni Realtime.");
  if (options?.video && !omni) throw new UnsupportedFeatureError("Qwen Audio Realtime does not accept video configuration.");
  const input = options?.audio?.input?.format ?? {};
  const channels = config.channels ?? input.channels ?? 1;
  if (!(omni ? [1, 2, 4] : [1]).includes(channels)) throw new ConfigurationError("Unsupported realtime input channel count.");
  if (input.type !== undefined && input.type !== "pcm" || input.sample_rate !== undefined && input.sample_rate !== 16000 || input.sample_format !== undefined && input.sample_format !== "s16le" || input.packing !== undefined && input.packing !== "interleaved") throw new ConfigurationError("Multichannel audio requires PCM16 16000 Hz interleaved input.");
  if (config.channels !== undefined && input.channels !== undefined && config.channels !== input.channels) throw new ConfigurationError("Conflicting realtime channel counts.");
  const layout = ({ 1: "mono", 2: "raw_mic_array", 4: "foa_ambix" } as Record<number, string>)[channels];
  if (input.channel_layout !== undefined && input.channel_layout !== layout) throw new ConfigurationError("channel_layout does not match channels.");
  const audioOutput = options?.audio?.output?.format ?? {};
  const outputRate = config.outputSampleRateHz ?? audioOutput.sample_rate ?? 24000;
  const outputType = config.outputAudioMediaType === "audio/wav" ? "wav" : audioOutput.type ?? "pcm";
  if (!(omni ? [8000, 16000, 24000, 48000] : [24000]).includes(outputRate)) throw new ConfigurationError("Unsupported realtime output sample rate.");
  if (!["pcm", "wav"].includes(outputType) || (!omni && outputType !== "pcm") || config.outputAudioMediaType && !["audio/pcm", ...(omni ? ["audio/wav"] : [])].includes(config.outputAudioMediaType)) throw new ConfigurationError("Unsupported realtime output audio format.");
  if (omni) output.audio = { input: { format: { ...input, type: "pcm", sample_rate: 16000, sample_format: "s16le", channels, packing: "interleaved", channel_layout: layout } }, output: { voice: config.voice ?? options?.audio?.output?.voice ?? "Tina", format: { type: outputType, sample_rate: outputRate } } };
  if (omni && options?.audio?.output?.voice && !config.voice) output.modalities = ["text", "audio"];
  if (options?.video?.input?.representation_compact !== undefined && !["none", "normal"].includes(options.video.input.representation_compact)) throw new ConfigurationError("Invalid video representation_compact.");
  const servers = options?.mcpServers ?? [];
  if (!Array.isArray(servers) || servers.length > 8) throw new ConfigurationError("At most eight MCP servers are supported.");
  if (servers.length && !omni) throw new UnsupportedFeatureError("MCP requires Qwen 3.8 Omni Realtime.");
  if (new Set(servers.map(server => server.server_label)).size !== servers.length) throw new ConfigurationError("MCP server labels must be unique.");
  const tools = [...(base.tools ?? []), ...(config.toolChoice === "none" ? [] : servers.map(mcpServer))];
  if (tools.length && options?.enable_search) throw new UnsupportedFeatureError("Qwen realtime tools and web search are mutually exclusive.");
  output.tools = tools.length ? tools : undefined;
  if (isQwenAudioRealtime(id)) {
    const history = options?.max_history_turns;
    if (history !== undefined && (!Number.isInteger(history) || history < 1 || history > 50)) throw new ConfigurationError("max_history_turns must be an integer from 1 to 50.");
    if (config.turnDetection?.type && !["server_vad", "smart_turn"].includes(String(config.turnDetection.type))) throw new ConfigurationError("Audio realtime supports server_vad or smart_turn.");
    if (options?.output_audio && !id.startsWith("qwen-audio-3.1-")) throw new UnsupportedFeatureError("output_audio.language requires Qwen Audio 3.1.");
  }
  return output;
};

export const validateQwenCloudAudioFrame = (frame: AudioFrame, config: RealtimeSessionConfig) => {
  const channels = config.channels ?? (config.providerOptions as QwenCloudRealtimeOptions | undefined)?.audio?.input?.format?.channels ?? 1;
  if (frame.mediaType !== "audio/pcm" || frame.sampleRateHz !== undefined && frame.sampleRateHz !== 16000 || frame.channels !== undefined && frame.channels !== channels) throw new ConfigurationError("Audio frame must match the session PCM16 16000 Hz channel configuration.");
  const data = typeof frame.data === "string" ? decodeBase64WithLimit(frame.data.startsWith("data:") ? frame.data.slice(frame.data.indexOf(",") + 1) : frame.data, { maxBytes: 16 * 1024 * 1024, provider: "qwen", endpoint: "realtime" }) : frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
  if (!data.byteLength || data.byteLength % (2 * channels)) throw new ConfigurationError("Audio frame must contain complete interleaved PCM16 samples.");
};

export const qwenCloudAudioEvent = (payload: Record<string, unknown>, config: RealtimeSessionConfig): RealtimeEvent[] | undefined => {
  if (payload.type !== "response.audio.delta" || typeof payload.delta !== "string") return undefined;
  const output = (config.providerOptions as QwenCloudRealtimeOptions | undefined)?.audio?.output?.format;
  return [{ type: "realtime-audio-output", audio: decodeBase64WithLimit(payload.delta, { maxBytes: 16 * 1024 * 1024, provider: "qwen", endpoint: "realtime" }),
    mediaType: config.outputAudioMediaType ?? (output?.type === "wav" ? "audio/wav" : "audio/pcm"), sampleRateHz: config.outputSampleRateHz ?? output?.sample_rate ?? 24000, channels: 1,
    itemId: typeof payload.item_id === "string" ? payload.item_id : undefined, responseId: typeof payload.response_id === "string" ? payload.response_id : undefined,
    providerMetadata: payload as Record<string, JsonValue> }];
};

export const extendQwenCloudRealtimeSession = (session: RealtimeSession, connection: RealtimeConnection, pendingApprovals?: Set<string>): QwenCloudRealtimeSession => Object.assign(session, {
  async respondToMcpApproval(approvalRequestId: string, approve: boolean) {
    if (!isQwenOmni38Realtime(session.modelId)) throw new UnsupportedFeatureError("MCP approvals require Qwen 3.8 Omni Realtime.");
    if (!approvalRequestId || typeof approve !== "boolean") throw new ConfigurationError("MCP approval requires an exact request ID and boolean decision.");
    if (pendingApprovals && !pendingApprovals.has(approvalRequestId)) throw new ConfigurationError("Unknown or already handled MCP approval request.");
    // Consume before awaiting transport to prevent concurrent duplicate approvals.
    pendingApprovals?.delete(approvalRequestId);
    await connection.sendJson({ type: "conversation.item.create", item: { type: "mcp_approval_response", approval_request_id: approvalRequestId, approve } });
  },
  async createResponse() {
    if (!isQwenCloudRealtime(session.modelId)) throw new UnsupportedFeatureError("Explicit response creation requires a Qwen Cloud conversation model.");
    await connection.sendJson({ type: "response.create" });
  }
});
