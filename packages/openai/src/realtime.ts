import { toJSONSchema } from "zod";
import {
  CallbackRealtimeSession,
  ConfigurationError,
  UnsupportedFeatureError,
  assertTrustedEndpoint,
  decodeBase64WithLimit,
  encodeAudioFrame,
  encodeMediaFrame,
  isCallableToolDefinition,
  openWebSocketConnection,
  toToolSet,
  toolResultPayload,
  withRetry,
  withTimeoutSignal,
  type JsonValue,
  type ModelCapabilities,
  type ModelGenerateInput,
  type RealtimeConnectOptions,
  type RealtimeConnectionFactory,
  type RealtimeModel,
  type RealtimeSessionConfig,
  type RealtimeTokenResult
} from "@zhivex-ai/core/provider";
import { inferOpenAIRealtimeMode, openAIRealtimeSupportsImageInput, realtimeCapabilities } from "./capabilities.js";
import { jsonHeaders, parseJson, RESERVED_REQUEST_HEADERS } from "./http.js";

const OPENAI_REALTIME_AUDIO_MAX_BYTES = 16 * 1024 * 1024;

export const openAIRealtimeMcpMetadataKey = "openai.realtime_mcp";

export const resolveOpenAIRealtimeHeaders = (
  apiKey: string,
  providerOptions: Record<string, unknown> | undefined,
  includeContentType = false
) => {
  const rawHeaders = providerOptions?.headers;
  const customHeaders =
    rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)
      ? { ...(rawHeaders as Record<string, string>) }
      : {};
  const safetyIdentifier = providerOptions?.safety_identifier;

  for (const key of Object.keys(customHeaders)) {
    const normalizedKey = key.toLowerCase();
    if (
      RESERVED_REQUEST_HEADERS.has(normalizedKey) ||
      (typeof safetyIdentifier === "string" && safetyIdentifier && normalizedKey === "openai-safety-identifier")
    ) {
      delete customHeaders[key];
    }
  }

  return {
    ...(includeContentType ? jsonHeaders(apiKey) : { authorization: `Bearer ${apiKey}` }),
    ...customHeaders,
    ...(typeof safetyIdentifier === "string" && safetyIdentifier
      ? { "OpenAI-Safety-Identifier": safetyIdentifier }
      : {})
  };
};

const mapRealtimeTools = (input: ModelGenerateInput["tools"]) =>
  input
    ? Object.values(input).map((tool) => {
        if (isCallableToolDefinition(tool)) {
          return {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema)
          };
        }

        if (tool.provider && tool.provider !== "openai") {
          throw new UnsupportedFeatureError(
            `Provider "openai" does not support hosted tools declared for provider "${tool.provider}".`
          );
        }

        if (tool.type !== "mcp") {
          throw new UnsupportedFeatureError(
            `Provider "openai" Realtime does not support the hosted tool type "${tool.type}". Use function or MCP tools.`
          );
        }

        return {
          type: tool.type,
          ...(tool.config && typeof tool.config === "object" ? tool.config : {})
        };
      })
    : undefined;

const mapRealtimeToolChoice = (toolChoice: ModelGenerateInput["toolChoice"]) => {
  if (!toolChoice || typeof toolChoice === "string") {
    return toolChoice;
  }
  return {
    type: "function",
    name: toolChoice.toolName
  };
};

const mapRealtimeProviderOptions = (providerOptions: Record<string, unknown> | undefined) => {
  if (!providerOptions) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(providerOptions).filter(
      ([key]) => !["headers", "safety_identifier", "realtime_url", "realtime_query", "expires_after"].includes(key)
    )
  );
};

const mapRealtimeAudioFormat = (mediaType: string | undefined, sampleRateHz: number | undefined) =>
  mediaType || sampleRateHz
    ? {
        ...(mediaType ? { type: mediaType } : {}),
        ...(sampleRateHz ? { rate: sampleRateHz } : {})
      }
    : undefined;

const mapRealtimeSessionConfig = (config: RealtimeSessionConfig, modelId?: string) => {
  const mode = inferOpenAIRealtimeMode(modelId ?? "", config.mode);
  const tools = mapRealtimeTools(toToolSet(config.tools));
  const audio = {
    input: {
      format: mapRealtimeAudioFormat(config.inputAudioMediaType, config.inputSampleRateHz),
      transcription:
        mode === "transcription" || config.inputTranscription
          ? {
              model: config.inputTranscription?.model ?? (mode === "transcription" ? modelId : undefined),
              language: config.inputTranscription?.language,
              prompt: config.inputTranscription?.prompt,
              delay: config.inputTranscription?.delay
            }
          : undefined,
      noise_reduction: config.noiseReduction ?? undefined,
      turn_detection: config.turnDetection ?? undefined
    },
    ...(mode === "transcription"
      ? {}
      : {
          output: {
            format: mapRealtimeAudioFormat(config.outputAudioMediaType, config.outputSampleRateHz),
            voice: config.voice
          }
        })
  };

  return {
    type: mode === "transcription" ? "transcription" : "realtime",
    model: modelId,
    instructions: config.translation?.instructions ?? config.instructions,
    output_modalities: mode === "transcription" ? undefined : config.outputAudioMediaType || config.voice || mode === "translation" ? ["audio"] : ["text"],
    tools: mode === "conversation" ? tools : undefined,
    tool_choice: mode === "conversation" && config.toolChoice ? mapRealtimeToolChoice(config.toolChoice) : undefined,
    reasoning:
      mode === "conversation" && config.reasoning?.effort
        ? {
            effort: config.reasoning.effort
          }
        : undefined,
    include:
      config.inputTranscription?.includeLogprobs && mode === "transcription" ? ["item.input_audio_transcription.logprobs"] : undefined,
    translation:
      mode === "translation"
        ? {
            target_language: config.translation?.targetLanguage,
            source_language: config.translation?.sourceLanguage
          }
        : undefined,
    audio,
    ...mapRealtimeProviderOptions(config.providerOptions)
  };
};

const openAIRealtimeURL = (
  baseURL: string,
  modelId: string,
  mode: NonNullable<RealtimeSessionConfig["mode"]>,
  providerOptions?: Record<string, unknown>
) => {
  const override = providerOptions?.realtime_url;
  if (typeof override === "string" && override) {
    return override;
  }

  const url = new URL(baseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  const endpoint =
    mode === "translation" ? "realtime/translations" : mode === "transcription" ? "realtime/transcription_sessions" : "realtime";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${endpoint}`;
  url.searchParams.set("model", modelId);
  const extraQuery = providerOptions?.realtime_query;
  if (extraQuery && typeof extraQuery === "object" && !Array.isArray(extraQuery)) {
    for (const [key, value] of Object.entries(extraQuery as Record<string, unknown>)) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
};

const parseRealtimeProviderMetadata = (payload: Record<string, unknown>) => payload as Record<string, JsonValue>;

const parseRealtimeJsonValue = (value: unknown): JsonValue => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }
  return value == null ? null : (value as JsonValue);
};

const openAIRealtimeMcpProviderDataEvent = (
  payload: Record<string, unknown>,
  data: Record<string, JsonValue>
) => [
  {
    type: "realtime-provider-data" as const,
    provider: "openai",
    data: {
      ...data,
      raw_event: payload as unknown as JsonValue
    }
  }
];

const openAIRealtimeMcpCommonData = (payload: Record<string, unknown>, item?: Record<string, unknown>) => {
  const itemId = typeof payload.item_id === "string" ? payload.item_id : typeof item?.id === "string" ? item.id : undefined;
  const serverLabel =
    typeof payload.server_label === "string"
      ? payload.server_label
      : typeof item?.server_label === "string"
        ? item.server_label
        : undefined;
  const name = typeof payload.name === "string" ? payload.name : typeof item?.name === "string" ? item.name : undefined;

  return {
    ...(itemId ? { item_id: itemId } : {}),
    ...(serverLabel ? { server_label: serverLabel } : {}),
    ...(name ? { name } : {})
  };
};

const parseOpenAIRealtimeEvent = (payload: Record<string, unknown>) => {
  const type = String(payload.type ?? "");
  if (type === "session.created" || type === "session.updated") {
    return [];
  }
  if (type === "mcp_list_tools.in_progress" || type === "mcp_list_tools.completed" || type === "mcp_list_tools.failed") {
    const status = type.slice("mcp_list_tools.".length) as "in_progress" | "completed" | "failed";
    return openAIRealtimeMcpProviderDataEvent(payload, {
      type: "mcp_list_tools",
      status,
      ...openAIRealtimeMcpCommonData(payload),
      ...(payload.error !== undefined ? { error: parseRealtimeJsonValue(payload.error) } : {})
    });
  }
  if (type === "conversation.item.done") {
    const item = payload.item && typeof payload.item === "object" ? (payload.item as Record<string, unknown>) : undefined;
    if (item?.type === "mcp_list_tools") {
      return openAIRealtimeMcpProviderDataEvent(payload, {
        type: "mcp_list_tools",
        status: "completed",
        ...openAIRealtimeMcpCommonData(payload, item),
        ...(item.tools !== undefined ? { tools: parseRealtimeJsonValue(item.tools) } : {})
      });
    }
    if (item?.type === "mcp_approval_request") {
      const approvalRequestId = typeof item.id === "string" ? item.id : undefined;
      return openAIRealtimeMcpProviderDataEvent(payload, {
        type: "mcp_approval_request",
        status: "approval_required",
        ...openAIRealtimeMcpCommonData(payload, item),
        ...(approvalRequestId ? { approval_request_id: approvalRequestId } : {}),
        ...(item.arguments !== undefined ? { arguments: parseRealtimeJsonValue(item.arguments) } : {})
      });
    }
    if (item?.type === "mcp_approval_response") {
      const approve = item.approve === true;
      return openAIRealtimeMcpProviderDataEvent(payload, {
        type: "mcp_approval_response",
        status: approve ? "approved" : "rejected",
        approve,
        ...openAIRealtimeMcpCommonData(payload, item),
        ...(typeof item.approval_request_id === "string" ? { approval_request_id: item.approval_request_id } : {}),
        ...(typeof item.reason === "string" ? { reason: item.reason } : {})
      });
    }
  }
  if (type === "response.mcp_call_arguments.delta" || type === "response.mcp_call_arguments.done") {
    const isDone = type.endsWith(".done");
    return openAIRealtimeMcpProviderDataEvent(payload, {
      type: "mcp_call",
      status: isDone ? "arguments_done" : "arguments_delta",
      ...openAIRealtimeMcpCommonData(payload),
      ...(isDone && payload.arguments !== undefined
        ? { arguments: parseRealtimeJsonValue(payload.arguments) }
        : payload.delta !== undefined
          ? { delta: parseRealtimeJsonValue(payload.delta) }
          : {})
    });
  }
  if (type === "response.mcp_call.in_progress" || type === "response.mcp_call.completed" || type === "response.mcp_call.failed") {
    const status = type.slice("response.mcp_call.".length) as "in_progress" | "completed" | "failed";
    return openAIRealtimeMcpProviderDataEvent(payload, {
      type: "mcp_call",
      status,
      ...openAIRealtimeMcpCommonData(payload),
      ...(payload.output !== undefined ? { output: parseRealtimeJsonValue(payload.output) } : {}),
      ...(payload.error !== undefined ? { error: parseRealtimeJsonValue(payload.error) } : {})
    });
  }
  if (type === "response.output_item.done") {
    const item = payload.item && typeof payload.item === "object" ? (payload.item as Record<string, unknown>) : undefined;
    if (item?.type === "mcp_call") {
      return openAIRealtimeMcpProviderDataEvent(payload, {
        type: "mcp_call",
        status: item.status === "failed" ? "failed" : "completed",
        ...openAIRealtimeMcpCommonData(payload, item),
        ...(item.arguments !== undefined ? { arguments: parseRealtimeJsonValue(item.arguments) } : {}),
        ...(item.output !== undefined ? { output: parseRealtimeJsonValue(item.output) } : {}),
        ...(item.error !== undefined ? { error: parseRealtimeJsonValue(item.error) } : {}),
        ...(typeof item.approval_request_id === "string" ? { approval_request_id: item.approval_request_id } : {})
      });
    }
  }
  if (type === "response.text.delta" || type === "response.output_text.delta") {
    return [
      {
        type: "realtime-text-delta" as const,
        textDelta: String(payload.delta ?? ""),
        itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        responseId: typeof payload.response_id === "string" ? payload.response_id : undefined,
        role: "assistant" as const,
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  if (type === "response.audio.delta" || type === "response.output_audio.delta") {
    return [
      {
        type: "realtime-audio-output" as const,
        audio: decodeBase64WithLimit(String(payload.delta ?? ""), {
          maxBytes: OPENAI_REALTIME_AUDIO_MAX_BYTES,
          provider: "openai",
          endpoint: "realtime"
        }),
        mediaType: typeof payload.media_type === "string" ? payload.media_type : "audio/pcm",
        sampleRateHz: typeof payload.sample_rate_hz === "number" ? payload.sample_rate_hz : undefined,
        channels: typeof payload.channels === "number" ? payload.channels : undefined,
        itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        responseId: typeof payload.response_id === "string" ? payload.response_id : undefined,
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  if (type === "conversation.item.input_audio_transcription.delta" || type === "input_audio_buffer.transcription.delta") {
    return [
      {
        type: "realtime-transcript" as const,
        text: String(payload.delta ?? ""),
        role: "user" as const,
        isFinal: false,
        itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  if (type === "conversation.item.input_audio_transcription.completed" || type === "input_audio_buffer.transcription.completed") {
    return [
      {
        type: "realtime-transcript" as const,
        text: String(payload.transcript ?? ""),
        role: "user" as const,
        isFinal: true,
        itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  if (type === "response.audio_transcript.delta" || type === "response.audio_transcription.delta" || type === "response.output_audio_transcript.delta") {
    return [
      {
        type: "realtime-transcript" as const,
        text: String(payload.delta ?? ""),
        role: "assistant" as const,
        isFinal: false,
        itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        responseId: typeof payload.response_id === "string" ? payload.response_id : undefined,
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  if (type === "response.audio_transcript.done" || type === "response.audio_transcription.done" || type === "response.output_audio_transcript.done") {
    return [
      {
        type: "realtime-transcript" as const,
        text: String(payload.transcript ?? ""),
        role: "assistant" as const,
        isFinal: true,
        itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        responseId: typeof payload.response_id === "string" ? payload.response_id : undefined,
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
    const name =
      typeof payload.name === "string"
        ? payload.name
        : payload.item && typeof payload.item === "object" && typeof (payload.item as Record<string, unknown>).name === "string"
          ? String((payload.item as Record<string, unknown>).name)
          : undefined;
    const callId =
      typeof payload.call_id === "string"
        ? payload.call_id
        : payload.item && typeof payload.item === "object" && typeof (payload.item as Record<string, unknown>).call_id === "string"
          ? String((payload.item as Record<string, unknown>).call_id)
          : undefined;
    const rawArgs =
      typeof payload.arguments === "string"
        ? payload.arguments
        : payload.item && typeof payload.item === "object" && typeof (payload.item as Record<string, unknown>).arguments === "string"
          ? String((payload.item as Record<string, unknown>).arguments)
          : "{}";
    if (!name || !callId) {
      return [];
    }
    return [
      {
        type: "realtime-tool-call" as const,
        toolCall: {
          id: callId,
          name,
          input: JSON.parse(rawArgs || "{}") as JsonValue
        }
      }
    ];
  }
  if (type === "response.done") {
    return [
      {
        type: "realtime-response-complete" as const,
        reason: typeof payload.status === "string" ? payload.status : undefined,
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  if (type === "error") {
    const error = payload.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : undefined;
    return [
      {
        type: "realtime-error" as const,
        message:
          typeof payload.message === "string"
            ? payload.message
            : typeof error?.message === "string"
              ? error.message
              : "Realtime API error.",
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  if (type === "session.end") {
    return [
      {
        type: "realtime-end" as const,
        reason: "session-end",
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  return [];
};

export class OpenAIRealtimeModel implements RealtimeModel {
  readonly provider = "openai";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly connectionFactory?: RealtimeConnectionFactory,
    private readonly realtimeURL?: string,
    private readonly browserTokenURL?: string,
    private readonly allowUnsafeEndpoints = false
  ) {
    this.capabilities = realtimeCapabilities(modelId);
  }

  private resolveConfig(config: RealtimeSessionConfig): RealtimeSessionConfig {
    if (config.delegation) throw new UnsupportedFeatureError("Client delegation requires a GPT-Live model.");
    const mode = inferOpenAIRealtimeMode(this.modelId, config.mode);
    if (mode !== "conversation" && (config.tools || config.toolChoice)) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${this.modelId}" does not support realtime tools in ${mode} mode.`);
    }
    if (mode === "translation" && !config.translation?.targetLanguage) {
      throw new ConfigurationError('OpenAI realtime translation sessions require "translation.targetLanguage".');
    }
    if (mode === "transcription" && config.voice) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${this.modelId}" does not support realtime audio output in transcription mode.`);
    }
    return {
      mode,
      autoResponse: mode === "conversation",
      ...config
    };
  }

  async connect(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions) {
    const initialConfig = this.resolveConfig(config);
    const providerOptions = initialConfig.providerOptions as Record<string, unknown> | undefined;
    const headers = resolveOpenAIRealtimeHeaders(this.apiKey, providerOptions);
    const trustedRealtimeHost = new URL(this.realtimeURL ?? this.baseURL).hostname;
    const realtimeEndpoint = assertTrustedEndpoint(
      this.realtimeURL ??
        openAIRealtimeURL(
          this.baseURL,
          this.modelId,
          inferOpenAIRealtimeMode(this.modelId, initialConfig.mode),
          providerOptions
        ),
      {
        label: "OpenAI realtime endpoint",
        protocols: ["wss"],
        allowedHosts: [trustedRealtimeHost],
        allowUnsafe: this.allowUnsafeEndpoints
      }
    ).toString();
    const connection = await (this.connectionFactory ?? openWebSocketConnection)(
      realtimeEndpoint,
      headers,
      options
    );
    const session = new CallbackRealtimeSession({
      provider: this.provider,
      modelId: this.modelId,
      capabilities: this.capabilities,
      config: initialConfig,
      connection,
      callbacks: {
        parseEvent: parseOpenAIRealtimeEvent,
        buildAudioPayloads: (frame, sessionConfig) => {
          const mode = inferOpenAIRealtimeMode(this.modelId, sessionConfig.mode);
          const payloads: Array<Record<string, unknown>> = [
            {
              type: "input_audio_buffer.append",
              audio: encodeAudioFrame(frame)
            }
          ];
          if (frame.isFinal) {
            payloads.push({ type: "input_audio_buffer.commit" });
            if (mode === "conversation" && (sessionConfig.autoResponse ?? true)) {
              payloads.push({ type: "response.create" });
            }
          }
          return payloads;
        },
        buildMediaPayloads: (frame) => {
          if (!openAIRealtimeSupportsImageInput(this.modelId)) {
            throw new UnsupportedFeatureError(`Provider "openai" model "${this.modelId}" does not support realtime image input.`);
          }
          if (!frame.mediaType.startsWith("image/")) {
            throw new UnsupportedFeatureError(
              `Provider "openai" only supports realtime image media input, but received "${frame.mediaType}".`
            );
          }
          return [
            {
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_image",
                    image_url: `data:${frame.mediaType};base64,${encodeMediaFrame(frame)}`
                  }
                ]
              }
            }
          ];
        },
        buildTextPayloads: (text, sessionConfig) => {
          const mode = inferOpenAIRealtimeMode(this.modelId, sessionConfig.mode);
          if (mode !== "conversation") {
            throw new UnsupportedFeatureError(`Provider "openai" model "${this.modelId}" does not support realtime text input in ${mode} mode.`);
          }
          const payloads: Array<Record<string, unknown>> = [
            {
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }]
              }
            }
          ];
          if (sessionConfig.autoResponse ?? true) {
            payloads.push({ type: "response.create" });
          }
          return payloads;
        },
        buildToolResultPayloads: (result, sessionConfig) => {
          const mode = inferOpenAIRealtimeMode(this.modelId, sessionConfig.mode);
          if (mode !== "conversation") {
            throw new UnsupportedFeatureError(`Provider "openai" model "${this.modelId}" does not support realtime tools in ${mode} mode.`);
          }
          const mcpMetadata = result.providerMetadata?.[openAIRealtimeMcpMetadataKey];
          if (mcpMetadata && typeof mcpMetadata === "object" && !Array.isArray(mcpMetadata)) {
            const approval = mcpMetadata as Record<string, JsonValue>;
            if (
              approval.type === "mcp_approval_response" &&
              typeof approval.approval_request_id === "string" &&
              typeof approval.approve === "boolean"
            ) {
              return [
                {
                  type: "conversation.item.create",
                  item: {
                    ...(typeof approval.id === "string" ? { id: approval.id } : {}),
                    type: "mcp_approval_response",
                    approval_request_id: approval.approval_request_id,
                    approve: approval.approve,
                    ...(typeof approval.reason === "string" ? { reason: approval.reason } : {})
                  }
                }
              ];
            }
          }
          const payloads: Array<Record<string, unknown>> = [
            {
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: result.toolCallId,
                output: JSON.stringify(toolResultPayload(result))
              }
            }
          ];
          if (sessionConfig.autoResponse ?? true) {
            payloads.push({ type: "response.create" });
          }
          return payloads;
        },
        buildUpdatePayloads: (sessionConfig) => [
          {
            type: "session.update",
            session: mapRealtimeSessionConfig(this.resolveConfig(sessionConfig), this.modelId)
          }
        ],
        buildInitialPayloads: (sessionConfig) => [
          {
            type: "session.update",
            session: mapRealtimeSessionConfig(sessionConfig, this.modelId)
          }
        ]
      }
    });
    await session.initialize();
    return session;
  }

  async createBrowserToken(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions): Promise<RealtimeTokenResult> {
    const resolvedConfig = this.resolveConfig(config);
    const providerOptions = { ...(resolvedConfig.providerOptions ?? {}) };
    const expiresAfter = providerOptions.expires_after;
    delete providerOptions.expires_after;

    const { signal, cleanup } = withTimeoutSignal({
      abortSignal: options?.signal,
      timeoutMs: options?.timeoutMs
    });
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.browserTokenURL ?? `${this.baseURL}/realtime/client_secrets`, {
            method: "POST",
            redirect: "error",
            headers: resolveOpenAIRealtimeHeaders(this.apiKey, providerOptions, true),
            body: JSON.stringify({
              ...(expiresAfter ? { expires_after: expiresAfter } : {}),
              session: mapRealtimeSessionConfig(
                {
                  ...resolvedConfig,
                  providerOptions
                },
                this.modelId
              )
            }),
            signal
          })
      );
      const payload = await parseJson(response);
    const secret = payload.client_secret;
    const value =
      secret && typeof secret === "object" && typeof secret.value === "string"
        ? secret.value
        : typeof payload.token === "string"
          ? payload.token
          : typeof payload.value === "string"
            ? payload.value
            : "";
    const expiresAtMs =
      secret && typeof secret === "object" && typeof secret.expires_at_ms === "number"
        ? secret.expires_at_ms
        : typeof payload.expires_at_ms === "number"
          ? payload.expires_at_ms
          : typeof payload.expires_at === "number"
            ? payload.expires_at * 1000
            : undefined;
      return {
        value,
        expiresAtMs,
        rawResponse: payload
      };
    } finally {
      cleanup();
    }
  }
}

