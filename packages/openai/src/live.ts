import { ConfigurationError, UnsupportedFeatureError, assertTrustedEndpoint, type RealtimeModel, type RealtimeConnectOptions, type RealtimeConnectionFactory, type RealtimeSessionConfig } from "@zhivex-ai/core/provider";
import { isOpenAILiveModel, liveCapabilities, resolveLiveConfig, createLiveSession } from "./live-session.js";
import { liveAudioCallbacks } from "./live-audio.js";
export { isOpenAILiveModel } from "./live-session.js";

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
    const resolved = resolveLiveConfig(config);
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
    const session = createLiveSession(this.modelId, resolved, connection, { timeoutMs: options?.timeoutMs, ...liveAudioCallbacks(resolved) });
    try { await session.initialize(); } catch (error) { await connection.close().catch(() => undefined); throw error; }
    return session;
  }

  async createBrowserToken(): Promise<never> {
    throw new UnsupportedFeatureError("GPT-Live uses server-created WebRTC sessions, not Realtime client secrets. This adapter supports server WebSockets.");
  }
}
