import { GoogleAuth } from "google-auth-library";
import { toJSONSchema } from "zod";

import {
  CallbackRealtimeSession,
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createMcpToolSet,
  createProviderAdapter,
  encodeAudioFrame,
  encodeMediaFrame,
  isCallableToolDefinition,
  isHostedToolDefinition,
  normalizeFinishReason,
  openWebSocketConnection,
  streamSSE,
  toToolSet,
  toolResultPayload,
  unsupportedBrowserToken,
  withRetry,
  withTimeoutSignal,
  type AudioInput,
  type BatchCancelInput,
  type BatchCreateInput,
  type BatchDeleteInput,
  type BatchGetInput,
  type BatchJob,
  type BatchListInput,
  type BatchesClient,
  type CachedContent,
  type CallableProviderAdapter,
  type ContextCacheCreateInput,
  type ContextCacheDeleteInput,
  type ContextCacheGetInput,
  type ContextCacheListInput,
  type ContextCachesClient,
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  type GenerateResult,
  type GeneratedMedia,
  type GroundedGenerateResult,
  type GroundedLanguageModel,
  type ImageGenerationModel,
  type ImageGenerationResult,
  type JsonValue,
  type LanguageModel,
  type MediaInput,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type MusicGenerationModel,
  type MusicGenerationResult,
  type PredictionModel,
  type PredictionModelInput,
  type PredictionOperation,
  type PredictionOperationInput,
  type PredictionResult,
  type ProviderAdapter,
  type RealtimeConnectOptions,
  type RealtimeConnectionFactory,
  type RealtimeModel,
  type RealtimeSessionConfig,
  type SpeechModel,
  type SpeechResult,
  type StreamEvent,
  type TranscriptionModel,
  type TranscriptionResult,
  type VideoGenerationModel,
  type VideoGenerationResult
} from "@zhivex-ai/core";

export interface VertexAuthClient {
  getAccessToken: () => string | null | undefined | Promise<string | null | undefined>;
}

export interface VertexProviderOptions {
  accessToken?: string;
  getAccessToken?: () => string | Promise<string>;
  authClient?: VertexAuthClient;
  apiKey?: string;
  scopes?: string | string[];
  projectId?: string;
  location?: string;
  apiVersion?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  realtimeURL?: string;
  realtimeConnectionFactory?: RealtimeConnectionFactory;
}

export interface VertexLanguageModelOptions {
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  candidateCount?: number;
  responseMimeType?: string;
  [key: string]: unknown;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: true,
  files: true,
  audioInput: false,
  audioOutput: false,
  embeddings: true,
  fileSearch: false,
  urlContext: true,
  contextCaching: true,
  batch: true,
  interactions: false,
  rawPrediction: true,
  computerUse: true,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: true,
    codeExecution: true,
    toolsets: false
  }
};

const transcriptionCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  audioInput: true,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: false,
    approvalRequests: false,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false
  }
};

const speechCapabilities: ModelCapabilities = {
  ...transcriptionCapabilities,
  audioInput: false,
  audioOutput: true
};

const groundedCapabilities: ModelCapabilities = {
  ...capabilities,
  webSearch: true
};

const imageGenerationCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  embeddings: false,
  imageGeneration: true,
  videoGeneration: false,
  musicGeneration: false,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: false,
    approvalRequests: false,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false
  }
};

const videoGenerationCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  embeddings: false,
  imageGeneration: false,
  videoGeneration: true,
  musicGeneration: false,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: false,
    approvalRequests: false,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false
  }
};

const musicGenerationCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  embeddings: false,
  imageGeneration: false,
  videoGeneration: false,
  musicGeneration: true,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: false,
    approvalRequests: false,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false
  }
};

const realtimeCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  audioInput: true,
  audioOutput: true,
  realtime: {
    sessions: true,
    audioInput: true,
    audioOutput: true,
    imageInput: true,
    tools: true,
    browserTokens: false
  }
};

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Vertex request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  return response.json();
};

const toBase64 = (data: AudioInput["data"]) => {
  if (typeof data === "string") {
    return data;
  }

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Buffer.from(bytes).toString("base64");
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(new Error("Operation aborted."));
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Operation aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const splitGenerationConfig = (providerOptions: Record<string, unknown> | undefined) => {
  const { generationConfig, ...rest } = providerOptions ?? {};
  return {
    generationConfig:
      generationConfig && typeof generationConfig === "object" ? (generationConfig as Record<string, unknown>) : {},
    providerOptions: rest
  };
};

const mediaInputToPart = (media: MediaInput) =>
  media.uri
    ? {
        fileData: {
          mimeType: media.mediaType,
          fileUri: media.uri
        }
      }
    : {
        inlineData: {
          mimeType: media.mediaType,
          data: media.data ? toBase64(media.data) : ""
        }
      };

const collectInlineMedia = (json: any, fallbackMediaType: string): { media: GeneratedMedia[]; text?: string } => {
  const text: string[] = [];
  const media: GeneratedMedia[] = [];
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text) {
        text.push(part.text);
      }
      const inlineData = part.inlineData ?? part.inline_data;
      if (inlineData?.data) {
        media.push({
          data: Uint8Array.from(Buffer.from(inlineData.data, "base64")),
          mediaType: inlineData.mimeType ?? inlineData.mime_type ?? fallbackMediaType,
          text: typeof part.text === "string" ? part.text : undefined
        });
      }
    }
  }

  return {
    media,
    text: text.length ? text.join("\n") : undefined
  };
};

const mediaInputToVeoImage = (media: MediaInput) =>
  media.uri
    ? {
        gcsUri: media.uri,
        mimeType: media.mediaType
      }
    : {
        bytesBase64Encoded: media.data ? toBase64(media.data) : "",
        mimeType: media.mediaType
      };

const collectVideos = (json: any): GeneratedMedia[] => {
  const samples =
    json.response?.generateVideoResponse?.generatedSamples ??
    json.response?.generatedVideos ??
    json.response?.generated_videos ??
    [];

  return (Array.isArray(samples) ? samples : [])
    .map((sample: any) => sample.video ?? sample)
    .map((video: any) => ({
      data: video.videoBytes
        ? Uint8Array.from(Buffer.from(video.videoBytes, "base64"))
        : video.bytesBase64Encoded
          ? Uint8Array.from(Buffer.from(video.bytesBase64Encoded, "base64"))
          : undefined,
      uri: video.uri ?? video.gcsUri,
      mediaType: video.mimeType ?? "video/mp4",
      providerMetadata: video
    }))
    .filter((video: GeneratedMedia) => video.data || video.uri);
};

const isImagenModel = (modelId: string) => modelId.startsWith("imagen-") || modelId.startsWith("imagegeneration@");

const normalizeCachedContent = (json: any): CachedContent => ({
  name: json.name ?? "",
  model: json.model,
  displayName: json.displayName ?? json.display_name,
  createTime: json.createTime ?? json.create_time,
  updateTime: json.updateTime ?? json.update_time,
  expireTime: json.expireTime ?? json.expire_time,
  usageMetadata: json.usageMetadata ?? json.usage_metadata,
  rawResponse: json,
  providerMetadata: json
});

const normalizeBatchJob = (json: any): BatchJob => ({
  name: json.name ?? "",
  model: json.model,
  state: json.state ?? json.metadata?.state,
  done: json.done,
  createTime: json.createTime ?? json.create_time ?? json.metadata?.createTime,
  updateTime: json.updateTime ?? json.update_time ?? json.metadata?.updateTime,
  rawResponse: json,
  providerMetadata: json
});

const normalizeOperation = (json: any): PredictionOperation => ({
  name: json.name ?? "",
  done: json.done,
  response: json.response,
  error: json.error,
  metadata: json.metadata,
  rawResponse: json
});

const normalizePredictionResult = (json: any): PredictionResult => ({
  predictions: json.predictions,
  operationName: json.name,
  operation: json.name || json.done !== undefined ? normalizeOperation(json) : undefined,
  rawResponse: json,
  providerMetadata: json
});

const appendQuery = (url: string, query: Record<string, string | number | undefined>) => {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
};

type VertexAuth =
  | {
      type: "bearer";
      getAccessToken: () => string | null | undefined | Promise<string | null | undefined>;
    }
  | {
      type: "api-key";
      apiKey: string;
    };

const resolveVertexAuth = (options: VertexProviderOptions): VertexAuth => {
  if (options.accessToken) {
    return { type: "bearer", getAccessToken: () => options.accessToken as string };
  }

  if (options.getAccessToken) {
    return { type: "bearer", getAccessToken: options.getAccessToken };
  }

  if (options.authClient) {
    return { type: "bearer", getAccessToken: options.authClient.getAccessToken.bind(options.authClient) };
  }

  if (options.apiKey) {
    return { type: "api-key", apiKey: options.apiKey };
  }

  const envAccessToken = process.env.VERTEX_ACCESS_TOKEN ?? process.env.GOOGLE_ACCESS_TOKEN;
  if (envAccessToken) {
    return { type: "bearer", getAccessToken: () => envAccessToken };
  }

  const envApiKey = process.env.VERTEX_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (envApiKey) {
    return { type: "api-key", apiKey: envApiKey };
  }

  const googleAuth = new GoogleAuth({
    scopes: options.scopes ?? ["https://www.googleapis.com/auth/cloud-platform"]
  });
  return { type: "bearer", getAccessToken: () => googleAuth.getAccessToken() };
};

const appendVertexApiKey = (auth: VertexAuth, input: RequestInfo | URL): RequestInfo | URL => {
  if (auth.type !== "api-key") {
    return input;
  }

  if (typeof input === "string") {
    return appendQuery(input, { key: auth.apiKey });
  }

  if (input instanceof URL) {
    return new URL(appendQuery(input.toString(), { key: auth.apiKey }));
  }

  return new Request(appendQuery(input.url, { key: auth.apiKey }), input);
};

const createVertexAuthenticatedFetch = (fetcher: typeof globalThis.fetch, auth: VertexAuth): typeof globalThis.fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    if (auth.type === "bearer") {
      const accessToken = await auth.getAccessToken();
      if (!accessToken) {
        throw new ConfigurationError("Missing Vertex access token.");
      }
      headers.set("authorization", `Bearer ${accessToken}`);
    }

    return fetcher(appendVertexApiKey(auth, input), {
      ...init,
      headers
    });
  }) as typeof globalThis.fetch;

const systemInstruction = (messages: ModelMessage[]) => {
  const text = messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return text ? { parts: [{ text }] } : undefined;
};

const mapPart = (part: ModelMessage["parts"][number]) => {
  switch (part.type) {
    case "text":
      return { text: part.text };
    case "image":
      return {
        inlineData: {
          mimeType: part.mediaType ?? "image/jpeg",
          data: part.image
        }
      };
    case "file":
      return {
        fileData: {
          mimeType: part.mediaType,
          fileUri: part.data
        }
      };
    case "tool-call":
      return {
        functionCall: {
          name: part.toolCall.name,
          args: part.toolCall.input
        }
      };
    case "tool-result":
      return {
        functionResponse: {
          name: part.toolResult.toolName,
          response: {
            name: part.toolResult.toolName,
            content: part.toolResult.isError ? part.toolResult.error : part.toolResult.output
          }
        }
      };
    default:
      return { text: JSON.stringify(part) };
  }
};

const mapMessages = (messages: ModelMessage[]) =>
  messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: message.parts.map(mapPart)
    }));

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? (() => {
        const mappedTools: Array<Record<string, unknown>> = [];
        const functionDeclarations = Object.values(tools)
          .filter(isCallableToolDefinition)
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema)
          }));

        if (functionDeclarations.length) {
          mappedTools.push({ functionDeclarations });
        }

        for (const tool of Object.values(tools).filter(isHostedToolDefinition)) {
          if (tool.provider && tool.provider !== "vertex") {
            throw new UnsupportedFeatureError(
              `Provider "vertex" does not support hosted tools declared for provider "${tool.provider}".`
            );
          }

          mappedTools.push({
            [tool.type]: tool.config && typeof tool.config === "object" ? tool.config : {}
          });
        }

        return mappedTools.length ? mappedTools : undefined;
      })()
    : undefined;

const mapToolConfig = (toolChoice: ModelGenerateInput["toolChoice"], tools: ModelGenerateInput["tools"]) => {
  if (!toolChoice || toolChoice === "auto") {
    return undefined;
  }

  if (toolChoice === "none") {
    return {
      functionCallingConfig: {
        mode: "NONE"
      }
    };
  }

  if (toolChoice === "required") {
    return {
      functionCallingConfig: {
        mode: "ANY"
      }
    };
  }

  const selectedTool = tools?.[toolChoice.toolName];
  if (selectedTool && isHostedToolDefinition(selectedTool)) {
    throw new UnsupportedFeatureError('Provider "vertex" does not support selecting a hosted tool by name.');
  }

  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [toolChoice.toolName]
    }
  };
};

const mapRealtimeProviderOptions = (providerOptions: Record<string, unknown> | undefined) =>
  providerOptions
    ? Object.fromEntries(
        Object.entries(providerOptions).filter(([key]) => !["headers", "realtime_url", "translationConfig"].includes(key))
      )
    : {};

const isGeminiLiveTranslateModel = (modelId: string) => /^gemini-3\.5-live-translate(?:-preview)?$/i.test(modelId.trim());

const vertexRealtimeURL = (
  location: string,
  apiVersion: string,
  providerOptions?: Record<string, unknown>,
  override?: string
) => {
  const candidate = override ?? (typeof providerOptions?.realtime_url === "string" ? providerOptions.realtime_url : undefined);
  return candidate || `wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.${apiVersion}.PredictionService.BidiGenerateContent`;
};

const vertexRealtimeHeaders = (accessToken: string, providerOptions?: Record<string, unknown>) => ({
  authorization: `Bearer ${accessToken}`,
  ...(typeof providerOptions?.headers === "object" && providerOptions.headers && !Array.isArray(providerOptions.headers)
    ? Object.fromEntries(
        Object.entries(providerOptions.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)])
      )
    : {})
});

const mapRealtimeTranscriptionConfig = (value: boolean | Record<string, unknown> | undefined) => {
  if (value === true) {
    return {};
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
};

const mapRealtimeThinkingConfig = (config: RealtimeSessionConfig) => {
  if (!config.reasoning) {
    return undefined;
  }

  const thinkingConfig = {
    ...(config.reasoning.effort ? { thinkingLevel: config.reasoning.effort } : {}),
    ...(config.reasoning.budgetTokens !== undefined ? { thinkingBudget: config.reasoning.budgetTokens } : {}),
    ...(config.reasoning.includeThoughts !== undefined ? { includeThoughts: config.reasoning.includeThoughts } : {})
  };
  return Object.keys(thinkingConfig).length ? thinkingConfig : undefined;
};

const mapRealtimeTranslationConfig = (config: RealtimeSessionConfig) => {
  const providerTranslationConfig =
    config.providerOptions &&
    typeof config.providerOptions.translationConfig === "object" &&
    config.providerOptions.translationConfig &&
    !Array.isArray(config.providerOptions.translationConfig)
      ? (config.providerOptions.translationConfig as Record<string, unknown>)
      : {};

  const translationConfig = {
    ...providerTranslationConfig,
    ...(config.translation?.targetLanguage ? { targetLanguageCode: config.translation.targetLanguage } : {}),
    ...(config.translation?.sourceLanguage ? { sourceLanguageCode: config.translation.sourceLanguage } : {})
  };

  return Object.keys(translationConfig).length ? translationConfig : undefined;
};

const assertVertexRealtimeTranslateConfig = (config: RealtimeSessionConfig, modelId: string) => {
  if (!isGeminiLiveTranslateModel(modelId)) {
    return;
  }

  if (config.mode && config.mode !== "translation") {
    throw new UnsupportedFeatureError(
      'Model "vertex/gemini-3.5-live-translate-preview" only supports realtime translation mode.'
    );
  }

  if (!config.translation?.targetLanguage) {
    throw new UnsupportedFeatureError(
      'Model "vertex/gemini-3.5-live-translate-preview" requires "translation.targetLanguage".'
    );
  }

  const tools = toToolSet(config.tools);
  if (tools && Object.keys(tools).length > 0) {
    throw new UnsupportedFeatureError(
      'Model "vertex/gemini-3.5-live-translate-preview" does not support realtime tools.'
    );
  }

  if (config.reasoning) {
    throw new UnsupportedFeatureError(
      'Model "vertex/gemini-3.5-live-translate-preview" does not support realtime reasoning.'
    );
  }

  if (config.instructions || config.translation?.instructions) {
    throw new UnsupportedFeatureError(
      'Model "vertex/gemini-3.5-live-translate-preview" does not support realtime system instructions.'
    );
  }
};

const vertexRealtimeSetup = (config: RealtimeSessionConfig, modelId: string) => ({
  setup: {
    model: `models/${modelId}`,
    generationConfig: {
      ...(config.voice
        ? {
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: config.voice
                }
              }
            }
          }
        : {}),
      responseModalities: isGeminiLiveTranslateModel(modelId) || config.outputAudioMediaType || config.voice ? ["AUDIO"] : ["TEXT"],
      ...(mapRealtimeThinkingConfig(config) ? { thinkingConfig: mapRealtimeThinkingConfig(config) } : {})
    },
    ...(mapRealtimeTranslationConfig(config) ? { translationConfig: mapRealtimeTranslationConfig(config) } : {}),
    ...(mapRealtimeTranscriptionConfig(config.inputAudioTranscription ?? (config.inputTranscription ? true : undefined))
      ? {
          inputAudioTranscription: mapRealtimeTranscriptionConfig(
            config.inputAudioTranscription ?? (config.inputTranscription ? true : undefined)
          )
        }
      : {}),
    ...(mapRealtimeTranscriptionConfig(config.outputAudioTranscription)
      ? { outputAudioTranscription: mapRealtimeTranscriptionConfig(config.outputAudioTranscription) }
      : {}),
    ...(config.mediaResolution ? { mediaResolution: config.mediaResolution } : {}),
    ...(config.affectiveDialog !== undefined ? { enableAffectiveDialog: config.affectiveDialog } : {}),
    ...(config.proactiveAudio !== undefined ? { proactivity: { proactiveAudio: config.proactiveAudio } } : {}),
    ...(config.instructions
      ? {
          systemInstruction: {
            parts: [{ text: config.instructions }]
          }
        }
      : {}),
    ...(mapTools(toToolSet(config.tools)) ? { tools: mapTools(toToolSet(config.tools)) } : {}),
    ...mapRealtimeProviderOptions(config.providerOptions as Record<string, unknown> | undefined)
  }
});

const parseVertexRealtimeEvent = (payload: Record<string, unknown>) => {
  if ("setupComplete" in payload) {
    return [];
  }

  const serverContent =
    typeof payload.serverContent === "object" && payload.serverContent
      ? (payload.serverContent as Record<string, unknown>)
      : typeof payload.server_content === "object" && payload.server_content
        ? (payload.server_content as Record<string, unknown>)
        : undefined;
  if (serverContent) {
    const modelTurn =
      typeof serverContent.modelTurn === "object" && serverContent.modelTurn
        ? (serverContent.modelTurn as Record<string, unknown>)
        : typeof serverContent.model_turn === "object" && serverContent.model_turn
          ? (serverContent.model_turn as Record<string, unknown>)
          : {};
    const parts = Array.isArray(modelTurn.parts) ? modelTurn.parts : [];
    const events = [];

    for (const part of parts) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const typedPart = part as Record<string, unknown>;
      if (typeof typedPart.text === "string" && typedPart.text) {
        events.push({
          type: "realtime-text-delta" as const,
          textDelta: typedPart.text,
          providerMetadata: payload as Record<string, JsonValue>
        });
      }
      const inline =
        typeof typedPart.inlineData === "object" && typedPart.inlineData
          ? (typedPart.inlineData as Record<string, unknown>)
          : typeof typedPart.inline_data === "object" && typedPart.inline_data
            ? (typedPart.inline_data as Record<string, unknown>)
            : undefined;
      if (inline && typeof inline.data === "string" && inline.data) {
        events.push({
          type: "realtime-audio-output" as const,
          audio: Buffer.from(inline.data, "base64"),
          mediaType: typeof inline.mimeType === "string" ? inline.mimeType : typeof inline.mime_type === "string" ? inline.mime_type : "audio/pcm",
          providerMetadata: payload as Record<string, JsonValue>
        });
      }
      if (typedPart.functionCall && typeof typedPart.functionCall === "object") {
        const call = typedPart.functionCall as Record<string, unknown>;
        events.push({
          type: "realtime-tool-call" as const,
          toolCall: {
            id: typeof call.id === "string" ? call.id : `${String(call.name ?? "")}-0`,
            name: String(call.name ?? ""),
            input: (call.args ?? {}) as JsonValue
          }
        });
      }
    }

    const inputTranscription =
      typeof serverContent.inputTranscription === "object" && serverContent.inputTranscription
        ? (serverContent.inputTranscription as Record<string, unknown>)
        : typeof serverContent.input_transcription === "object" && serverContent.input_transcription
          ? (serverContent.input_transcription as Record<string, unknown>)
          : undefined;
    if (inputTranscription && typeof inputTranscription.text === "string" && inputTranscription.text) {
      events.push({
        type: "realtime-transcript" as const,
        text: inputTranscription.text,
        role: "user" as const,
        isFinal: Boolean(serverContent.turnComplete ?? serverContent.turn_complete),
        providerMetadata: payload as Record<string, JsonValue>
      });
    }

    const outputTranscription =
      typeof serverContent.outputTranscription === "object" && serverContent.outputTranscription
        ? (serverContent.outputTranscription as Record<string, unknown>)
        : typeof serverContent.output_transcription === "object" && serverContent.output_transcription
          ? (serverContent.output_transcription as Record<string, unknown>)
          : undefined;
    if (outputTranscription && typeof outputTranscription.text === "string" && outputTranscription.text) {
      events.push({
        type: "realtime-transcript" as const,
        text: outputTranscription.text,
        role: "assistant" as const,
        isFinal: Boolean(serverContent.turnComplete ?? serverContent.turn_complete),
        providerMetadata: payload as Record<string, JsonValue>
      });
    }

    if (serverContent.generationComplete || serverContent.generation_complete) {
      events.push({
        type: "realtime-response-complete" as const,
        reason: "generation-complete",
        providerMetadata: payload as Record<string, JsonValue>
      });
    }
    if (serverContent.turnComplete || serverContent.turn_complete) {
      events.push({
        type: "realtime-response-complete" as const,
        reason: "turn-complete",
        providerMetadata: payload as Record<string, JsonValue>
      });
    }

    return events;
  }

  const sessionResumption =
    typeof payload.sessionResumptionUpdate === "object" && payload.sessionResumptionUpdate
      ? (payload.sessionResumptionUpdate as Record<string, unknown>)
      : typeof payload.session_resumption_update === "object" && payload.session_resumption_update
        ? (payload.session_resumption_update as Record<string, unknown>)
        : undefined;
  if (sessionResumption) {
    return [
      {
        type: "realtime-session-resumption" as const,
        handle:
          typeof sessionResumption.newHandle === "string"
            ? sessionResumption.newHandle
            : typeof sessionResumption.new_handle === "string"
              ? sessionResumption.new_handle
              : undefined,
        resumable: typeof sessionResumption.resumable === "boolean" ? sessionResumption.resumable : undefined,
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }

  const goAway =
    typeof payload.goAway === "object" && payload.goAway
      ? (payload.goAway as Record<string, unknown>)
      : typeof payload.go_away === "object" && payload.go_away
        ? (payload.go_away as Record<string, unknown>)
        : undefined;
  if (goAway) {
    return [
      {
        type: "realtime-go-away" as const,
        timeLeftMs:
          typeof goAway.timeLeftMs === "number"
            ? goAway.timeLeftMs
            : typeof goAway.time_left_ms === "number"
              ? goAway.time_left_ms
              : undefined,
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }

  if (payload.error && typeof payload.error === "object") {
    return [
      {
        type: "realtime-end" as const,
        reason: "error",
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }

  return [];
};

const isGemini3Model = (modelId: string) => /^gemini-3([.-]|$)/.test(modelId);

const isGemini3ProModel = (modelId: string) => /^gemini-3([.-].*)?pro([.-]|$)/.test(modelId);

const mapReasoning = (modelId: string, input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  if (isGemini3Model(modelId)) {
    if (input.reasoning.budgetTokens !== undefined) {
      throw new UnsupportedFeatureError(
        'Provider "vertex" uses "reasoning.effort" for Gemini 3 models and does not support "reasoning.budgetTokens".'
      );
    }

    if (input.reasoning.effort === "none") {
      throw new UnsupportedFeatureError('Provider "vertex" does not support "reasoning.effort=none" for Gemini 3 models.');
    }

    if (input.reasoning.effort === "xhigh") {
      throw new UnsupportedFeatureError('Provider "vertex" does not support "reasoning.effort=xhigh".');
    }

    if (input.reasoning.effort === "minimal" && isGemini3ProModel(modelId)) {
      throw new UnsupportedFeatureError(
        'Provider "vertex" does not support "reasoning.effort=minimal" for Gemini 3 Pro models.'
      );
    }

    return input.reasoning.effort !== undefined
      ? {
          thinkingLevel: input.reasoning.effort
        }
      : undefined;
  }

  if (input.reasoning.effort !== undefined) {
    throw new UnsupportedFeatureError(
      'Provider "vertex" does not support "reasoning.effort" for models earlier than Gemini 3.'
    );
  }

  return input.reasoning.budgetTokens !== undefined
    ? {
        thinkingBudget: input.reasoning.budgetTokens
      }
    : undefined;
};

const generationConfig = (modelId: string, input: ModelGenerateInput) => ({
  temperature: input.temperature,
  maxOutputTokens: input.maxTokens,
  ...(input.reasoning
    ? {
        thinkingConfig: mapReasoning(modelId, input)
      }
    : {}),
  ...(input.structuredOutput?.mode === "native"
    ? {
        responseMimeType: "application/json",
        responseSchema: toJSONSchema(input.structuredOutput.schema)
      }
    : {})
});

const parseAssistantMessage = (candidate: any): ModelMessage => ({
  role: "assistant",
  parts:
    candidate?.content?.parts?.map((part: any, index: number) => {
      if (part.text) {
        return { type: "text", text: part.text } as const;
      }
      if (part.functionCall) {
        return {
          type: "tool-call" as const,
          toolCall: {
            id: part.functionCall.id ?? `${part.functionCall.name}-${index}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {}
          }
        };
      }
      if (part.inlineData?.data && String(part.inlineData.mimeType ?? "").startsWith("image/")) {
        return { type: "image", image: part.inlineData.data, mediaType: part.inlineData.mimeType } as const;
      }
      return { type: "text", text: JSON.stringify(part) } as const;
    }) ?? []
});

const extractGroundingSources = (candidate: any): GroundedGenerateResult["sources"] =>
  (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk: any) => ({
      title: chunk.web?.title,
      url: chunk.web?.uri,
      snippet: chunk.web?.snippet,
      providerMetadata: chunk
    }))
    .filter((source: GroundedGenerateResult["sources"][number]) => typeof source.url === "string");

class VertexContextCachesClient implements ContextCachesClient {
  constructor(
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  private resourceBase() {
    const index = this.baseURL.indexOf("/projects/");
    return index >= 0 ? this.baseURL.slice(index + 1) : this.baseURL;
  }

  async create(input: ContextCacheCreateInput): Promise<CachedContent> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/cachedContents`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              model: input.modelId.startsWith("projects/")
                ? input.modelId
                : `${this.resourceBase()}/publishers/google/models/${input.modelId}`,
              contents: mapMessages(input.contents),
              ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : { systemInstruction: systemInstruction(input.contents) }),
              ...(input.tools ? { tools: mapTools(toToolSet(input.tools)) } : {}),
              ...(input.displayName ? { displayName: input.displayName } : {}),
              ...(input.ttl ? { ttl: input.ttl } : {}),
              ...(input.expireTime ? { expireTime: input.expireTime } : {}),
              ...(input.providerOptions ?? {})
            })
          }),
        input
      );
      return normalizeCachedContent(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async get(input: ContextCacheGetInput): Promise<CachedContent> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/${input.name}`, { method: "GET", headers: this.headers(), signal }), input);
      return normalizeCachedContent(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: ContextCacheListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(appendQuery(`${this.baseURL}/cachedContents`, { pageSize: input.pageSize, pageToken: input.pageToken }), {
            method: "GET",
            headers: this.headers(),
            signal
          }),
        input
      );
      const json = await parseJson(response);
      return {
        caches: (json.cachedContents ?? json.cached_contents ?? []).map(normalizeCachedContent),
        nextPageToken: json.nextPageToken,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async delete(input: ContextCacheDeleteInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/${input.name}`, { method: "DELETE", headers: this.headers(), signal }), input);
      const json = await parseJson(response);
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class VertexBatchesClient implements BatchesClient {
  constructor(
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async create(input: BatchCreateInput): Promise<BatchJob> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/publishers/google/models/${input.modelId}:batchGenerateContent`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              batch: {
                ...(input.displayName ? { displayName: input.displayName } : {}),
                inputConfig: input.fileName
                  ? { fileName: input.fileName }
                  : {
                      requests: {
                        requests: input.requests ?? []
                      }
                    },
                ...(input.providerOptions ?? {})
              }
            })
          }),
        input
      );
      return normalizeBatchJob(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async get(input: BatchGetInput): Promise<BatchJob> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/${input.name}`, { method: "GET", headers: this.headers(), signal }), input);
      return normalizeBatchJob(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: BatchListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(appendQuery(`${this.baseURL}/batches`, { pageSize: input.pageSize, pageToken: input.pageToken }), {
            method: "GET",
            headers: this.headers(),
            signal
          }),
        input
      );
      const json = await parseJson(response);
      return {
        batches: (json.batches ?? []).map(normalizeBatchJob),
        nextPageToken: json.nextPageToken,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async cancel(input: BatchCancelInput): Promise<BatchJob> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/${input.name}:cancel`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify(input.providerOptions ?? {})
          }),
        input
      );
      return normalizeBatchJob(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async delete(input: BatchDeleteInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/${input.name}:delete`, { method: "POST", headers: this.headers(), signal }), input);
      const json = await parseJson(response);
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class VertexPredictionModel implements PredictionModel {
  readonly provider = "vertex";
  readonly capabilities: ModelCapabilities = {
    ...capabilities,
    rawPrediction: true
  };

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  private url(action: string) {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:${action}`;
  }

  private body(input: PredictionModelInput) {
    return input.body ?? {
      ...(input.instances ? { instances: input.instances } : {}),
      ...(input.parameters ? { parameters: input.parameters } : {}),
      ...(input.providerOptions ?? {})
    };
  }

  async predictRaw(input: PredictionModelInput): Promise<PredictionResult> {
    const action = typeof input.providerOptions?.action === "string" ? input.providerOptions.action : "predict";
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(action), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify(this.body(input))
          }),
        input
      );
      return normalizePredictionResult(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async rawPredict(input: PredictionModelInput): Promise<PredictionResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("rawPredict"), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify(this.body(input))
          }),
        input
      );
      return normalizePredictionResult(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async invoke(input: PredictionModelInput): Promise<PredictionResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("invoke"), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify(this.body(input))
          }),
        input
      );
      return normalizePredictionResult(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async predictLongRunning(input: PredictionModelInput): Promise<PredictionOperation> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("predictLongRunning"), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify(this.body(input))
          }),
        input
      );
      return normalizeOperation(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async fetchPredictionOperation(input: PredictionOperationInput): Promise<PredictionOperation> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("fetchPredictOperation"), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              operationName: input.name,
              ...(input.providerOptions ?? {})
            })
          }),
        input
      );
      return normalizeOperation(await parseJson(response));
    } finally {
      cleanup();
    }
  }
}

class VertexLanguageModel implements LanguageModel<VertexLanguageModelOptions> {
  readonly provider = "vertex";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(action: string) {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:${action}`;
  }

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async generate(input: ModelGenerateInput<VertexLanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("generateContent"), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: mapMessages(input.messages),
              systemInstruction: systemInstruction(input.messages),
              tools: mapTools(input.tools),
              ...input.providerOptions,
              toolConfig: mapToolConfig(input.toolChoice, input.tools),
              generationConfig: generationConfig(this.modelId, input)
            })
          }),
        input
      );

      const json = await parseJson(response);
      const candidate = json.candidates?.[0];
      const assistantMessage = parseAssistantMessage(candidate);

      return {
        messages: [assistantMessage],
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        finishReason: normalizeFinishReason(candidate?.finishReason),
        providerFinishReason: candidate?.finishReason,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput<VertexLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(this.url("streamGenerateContent?alt=sse"), {
          method: "POST",
          headers: this.headers(),
          signal,
          body: JSON.stringify({
            contents: mapMessages(input.messages),
            systemInstruction: systemInstruction(input.messages),
            tools: mapTools(input.tools),
            ...input.providerOptions,
            toolConfig: mapToolConfig(input.toolChoice, input.tools),
            generationConfig: generationConfig(this.modelId, input)
          })
        }),
      input
    );

    return (async function* () {
      try {
        for await (const event of streamSSE(response)) {
          const json = JSON.parse(event.data);
          const candidate = json.candidates?.[0];
          const parts = candidate?.content?.parts ?? [];

          for (const [index, part] of parts.entries()) {
            if (part.text) {
              yield { type: "text-delta", textDelta: part.text } satisfies StreamEvent;
            }

            if (part.functionCall) {
              yield {
                type: "tool-call",
                toolCall: {
                  id: part.functionCall.id ?? `${part.functionCall.name}-${index}`,
                  name: part.functionCall.name,
                  input: part.functionCall.args ?? {}
                }
              } satisfies StreamEvent;
            }
          }

          if (candidate?.finishReason) {
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(candidate.finishReason),
              providerFinishReason: candidate.finishReason
            } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
  }
}

class VertexEmbeddingModel implements EmbeddingModel {
  readonly provider = "vertex";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url() {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:predict`;
  }

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async embed(input: EmbedInput & { abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<EmbedResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              instances: input.values.map((value) => ({
                content: value
              }))
            })
          }),
        input
      );

      const json = await parseJson(response);
      return {
        embeddings: (json.predictions ?? []).map((prediction: any) => prediction.embeddings?.values ?? []),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class VertexTranscriptionModel implements TranscriptionModel {
  readonly provider = "vertex";
  readonly capabilities = transcriptionCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url() {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:generateContent`;
  }

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async transcribe(input: {
    audio: AudioInput;
    prompt?: string;
    language?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<TranscriptionResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      inlineData: {
                        mimeType: input.audio.mediaType,
                        data: toBase64(input.audio.data)
                      }
                    },
                    {
                      text:
                        input.prompt ??
                        `Transcribe this audio${input.language ? ` in ${input.language}` : ""}. Return only the transcript.`
                    }
                  ]
                }
              ],
              ...input.providerOptions
            })
          }),
        input
      );

      const json = await parseJson(response);
      const text = json.candidates?.[0]?.content?.parts?.find((part: any) => typeof part.text === "string")?.text ?? "";
      return {
        text,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class VertexSpeechModel implements SpeechModel {
  readonly provider = "vertex";
  readonly capabilities = speechCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url() {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:generateContent`;
  }

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async generateSpeech(input: {
    input: string;
    voice?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<SpeechResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: input.input }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: input.voice ?? "Kore"
                    }
                  }
                }
              },
              ...input.providerOptions
            })
          }),
        input
      );

      const json = await parseJson(response);
      const audioPart = json.candidates?.[0]?.content?.parts?.find((part: any) => part.inlineData?.data);
      return {
        audio: Uint8Array.from(Buffer.from(audioPart?.inlineData?.data ?? "", "base64")),
        mediaType: audioPart?.inlineData?.mimeType ?? "audio/wav",
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class VertexImageGenerationModel implements ImageGenerationModel {
  readonly provider = "vertex";
  readonly capabilities = imageGenerationCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async generateImage(input: {
    prompt: string;
    images?: MediaInput[];
    count?: number;
    aspectRatio?: string;
    size?: string;
    negativePrompt?: string;
    outputMimeType?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<ImageGenerationResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      if (isImagenModel(this.modelId)) {
        const response = await withRetry(
          () =>
            this.fetcher(`${this.baseURL}/publishers/google/models/${this.modelId}:predict`, {
              method: "POST",
              headers: this.headers(),
              signal,
              body: JSON.stringify({
                instances: [
                  {
                    prompt: input.prompt
                  }
                ],
                parameters: {
                  ...(input.negativePrompt ? { negativePrompt: input.negativePrompt, negative_prompt: input.negativePrompt } : {}),
                  ...(input.count ? { sampleCount: input.count, number_of_images: input.count } : {}),
                  ...(input.aspectRatio ? { aspectRatio: input.aspectRatio, aspect_ratio: input.aspectRatio } : {}),
                  ...(input.size ? { sampleImageSize: input.size, sample_image_size: input.size } : {}),
                  ...(input.outputMimeType ? { outputMimeType: input.outputMimeType, output_mime_type: input.outputMimeType } : {}),
                  ...input.providerOptions
                }
              })
            }),
          input
        );

        const json = await parseJson(response);
        const images = (Array.isArray(json.predictions) ? json.predictions : [])
          .map((prediction: any) => ({
            data:
              prediction.bytesBase64Encoded || prediction.imageBytes
                ? Uint8Array.from(Buffer.from(prediction.bytesBase64Encoded ?? prediction.imageBytes, "base64"))
                : undefined,
            uri: prediction.gcsUri ?? prediction.uri,
            mediaType: prediction.mimeType ?? input.outputMimeType ?? "image/png",
            text: prediction.prompt ?? prediction.text,
            providerMetadata: prediction
          }))
          .filter((image: GeneratedMedia) => image.data || image.uri);

        return {
          images,
          rawResponse: json
        };
      }

      const { generationConfig, providerOptions } = splitGenerationConfig(input.providerOptions);
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/publishers/google/models/${this.modelId}:generateContent`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: input.negativePrompt ? `${input.prompt}\n\nNegative prompt: ${input.negativePrompt}` : input.prompt },
                    ...(input.images ?? []).map(mediaInputToPart)
                  ]
                }
              ],
              ...providerOptions,
              generationConfig: {
                responseModalities: ["TEXT", "IMAGE"],
                ...(input.count ? { candidateCount: input.count } : {}),
                ...(input.outputMimeType ? { responseMimeType: input.outputMimeType } : {}),
                ...(input.aspectRatio || input.size
                  ? {
                      imageConfig: {
                        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
                        ...(input.size ? { imageSize: input.size } : {})
                      }
                    }
                  : {}),
                ...generationConfig
              }
            })
          }),
        input
      );

      const json = await parseJson(response);
      const { media, text } = collectInlineMedia(json, input.outputMimeType ?? "image/png");
      return {
        images: media,
        text,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class VertexMusicGenerationModel implements MusicGenerationModel {
  readonly provider = "vertex";
  readonly capabilities = musicGenerationCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async generateMusic(input: {
    prompt: string;
    images?: MediaInput[];
    negativePrompt?: string;
    outputMimeType?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<MusicGenerationResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      if (this.modelId === "lyria-002") {
        const response = await withRetry(
          () =>
            this.fetcher(`${this.baseURL}/publishers/google/models/${this.modelId}:predict`, {
              method: "POST",
              headers: this.headers(),
              signal,
              body: JSON.stringify({
                instances: [
                  {
                    prompt: input.prompt,
                    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {})
                  }
                ],
                parameters: {
                  ...input.providerOptions
                }
              })
            }),
          input
        );

        const json = await parseJson(response);
        return {
          audio: (Array.isArray(json.predictions) ? json.predictions : []).map((prediction: any) => ({
            data: Uint8Array.from(Buffer.from(prediction.audioContent ?? "", "base64")),
            mediaType: prediction.mimeType ?? "audio/wav",
            providerMetadata: prediction
          })),
          rawResponse: json
        };
      }

      const { generationConfig, providerOptions } = splitGenerationConfig(input.providerOptions);
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/publishers/google/models/${this.modelId}:generateContent`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: input.negativePrompt ? `${input.prompt}\n\nNegative prompt: ${input.negativePrompt}` : input.prompt },
                    ...(input.images ?? []).map(mediaInputToPart)
                  ]
                }
              ],
              ...providerOptions,
              generationConfig: {
                responseModalities: ["AUDIO", "TEXT"],
                ...(input.outputMimeType ? { responseMimeType: input.outputMimeType } : {}),
                ...generationConfig
              }
            })
          }),
        input
      );

      const json = await parseJson(response);
      const { media, text } = collectInlineMedia(json, input.outputMimeType ?? "audio/mpeg");
      return {
        audio: media,
        text,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class VertexVideoGenerationModel implements VideoGenerationModel {
  readonly provider = "vertex";
  readonly capabilities = videoGenerationCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async generateVideo(input: {
    prompt: string;
    image?: MediaInput;
    count?: number;
    aspectRatio?: string;
    negativePrompt?: string;
    durationSeconds?: number;
    outputStorageUri?: string;
    pollIntervalMs?: number;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<VideoGenerationResult> {
    const timeoutMs = input.timeoutMs ?? 600_000;
    const { signal, cleanup } = withTimeoutSignal({ ...input, timeoutMs });
    const startedAt = Date.now();

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/publishers/google/models/${this.modelId}:predictLongRunning`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              instances: [
                {
                  prompt: input.prompt,
                  ...(input.image ? { image: mediaInputToVeoImage(input.image) } : {})
                }
              ],
              parameters: {
                ...(input.count ? { sampleCount: input.count } : {}),
                ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
                ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
                ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
                ...(input.outputStorageUri ? { storageUri: input.outputStorageUri } : {}),
                ...input.providerOptions
              }
            })
          }),
        input
      );

      let operation = await parseJson(response);
      const operationName = operation.name;
      const pollIntervalMs = input.pollIntervalMs ?? 10_000;

      while (!operation.done) {
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`Vertex video generation timed out after ${timeoutMs}ms.`);
        }
        await sleep(pollIntervalMs, signal);
        const pollResponse = await withRetry(
          () =>
            this.fetcher(`${this.baseURL}/publishers/google/models/${this.modelId}:fetchPredictOperation`, {
              method: "POST",
              headers: this.headers(),
              signal,
              body: JSON.stringify({
                operationName
              })
            }),
          input
        );
        operation = await parseJson(pollResponse);
      }

      return {
        videos: collectVideos(operation),
        operationName,
        rawResponse: operation
      };
    } finally {
      cleanup();
    }
  }
}

class VertexGroundedLanguageModel implements GroundedLanguageModel {
  readonly provider = "vertex";
  readonly capabilities = groundedCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url() {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:generateContent`;
  }

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async generate(input: {
    messages: ModelMessage[];
    temperature?: number;
    maxTokens?: number;
    reasoning?: ModelGenerateInput["reasoning"];
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<GroundedGenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: mapMessages(input.messages),
              systemInstruction: systemInstruction(input.messages),
              tools: [{ googleSearch: {} }],
              generationConfig: generationConfig(this.modelId, {
                messages: input.messages,
                temperature: input.temperature,
                maxTokens: input.maxTokens,
                reasoning: input.reasoning
              } as ModelGenerateInput),
              ...input.providerOptions
            })
          }),
        input
      );

      const json = await parseJson(response);
      const candidate = json.candidates?.[0];
      const assistantMessage = parseAssistantMessage(candidate);
      return {
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        sources: extractGroundingSources(candidate),
        finishReason: normalizeFinishReason(candidate?.finishReason),
        providerFinishReason: candidate?.finishReason,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class VertexRealtimeModel implements RealtimeModel {
  readonly provider = "vertex";
  readonly capabilities = realtimeCapabilities;

  constructor(
    readonly modelId: string,
    private readonly auth: VertexAuth,
    private readonly location: string,
    private readonly apiVersion: string,
    private readonly connectionFactory?: RealtimeConnectionFactory,
    private readonly realtimeURL?: string
  ) {}

  async connect(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions) {
    assertVertexRealtimeTranslateConfig(config, this.modelId);

    if (this.auth.type === "api-key") {
      throw new UnsupportedFeatureError('Provider "vertex" realtime sessions require accessToken or getAccessToken auth.');
    }

    const accessToken = await this.auth.getAccessToken();
    if (!accessToken) {
      throw new ConfigurationError("Missing Vertex access token.");
    }

    const providerOptions = (config.providerOptions ?? {}) as Record<string, unknown>;
    const connection = await (this.connectionFactory ?? openWebSocketConnection)(
      vertexRealtimeURL(this.location, this.apiVersion, providerOptions, this.realtimeURL),
      vertexRealtimeHeaders(accessToken, providerOptions),
      options
    );
    const session = new CallbackRealtimeSession({
      provider: this.provider,
      modelId: this.modelId,
      capabilities: this.capabilities,
      config,
      connection,
      callbacks: {
        parseEvent: parseVertexRealtimeEvent,
        buildAudioPayloads: (frame) => [
          {
            realtimeInput: {
              audio: {
                mimeType: frame.mediaType,
                data: encodeAudioFrame(frame)
              }
            }
          }
        ],
        buildMediaPayloads: (frame) => {
          if (isGeminiLiveTranslateModel(this.modelId)) {
            throw new UnsupportedFeatureError(
              'Model "vertex/gemini-3.5-live-translate-preview" only supports audio input.'
            );
          }

          return [
            {
              realtimeInput: {
                media: {
                  mimeType: frame.mediaType,
                  data: encodeMediaFrame(frame)
                }
              }
            }
          ];
        },
        buildTextPayloads: (text) => {
          if (isGeminiLiveTranslateModel(this.modelId)) {
            throw new UnsupportedFeatureError(
              'Model "vertex/gemini-3.5-live-translate-preview" only supports audio input.'
            );
          }

          return [
            {
              clientContent: {
                turns: [
                  {
                    role: "user",
                    parts: [{ text }]
                  }
                ],
                turnComplete: true
              }
            }
          ];
        },
        buildToolResultPayloads: (result) => [
          {
            toolResponse: {
              functionResponses: [
                {
                  id: result.toolCallId,
                  name: result.toolName,
                  response: toolResultPayload(result)
                }
              ]
            }
          }
        ],
        buildUpdatePayloads: (sessionConfig) => {
          assertVertexRealtimeTranslateConfig(sessionConfig, this.modelId);
          return [vertexRealtimeSetup(sessionConfig, this.modelId)];
        },
        buildInitialPayloads: (sessionConfig) => {
          assertVertexRealtimeTranslateConfig(sessionConfig, this.modelId);
          return [vertexRealtimeSetup(sessionConfig, this.modelId)];
        }
      }
    });
    await session.initialize();
    return session;
  }

  async createBrowserToken() {
    return unsupportedBrowserToken();
  }
}

export const createVertex = (
  options: VertexProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const auth = resolveVertexAuth(options);
  const projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (auth.type === "bearer" && !projectId && !options.baseURL) {
    throw new ConfigurationError("Missing Vertex project ID.");
  }

  const location = options.location ?? process.env.VERTEX_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const apiVersion = options.apiVersion ?? "v1beta1";
  const baseURL =
    options.baseURL ??
    (auth.type === "api-key"
      ? `https://aiplatform.googleapis.com/${apiVersion}`
      : `https://${location}-aiplatform.googleapis.com/${apiVersion}/projects/${projectId}/locations/${location}`);
  const fetcher = createVertexAuthenticatedFetch(options.fetch ?? globalThis.fetch, auth);

  return createProviderAdapter({
    name: "vertex",
    languageModel: (modelId) => new VertexLanguageModel(modelId, baseURL, "", fetcher),
    embeddingModel: (modelId) => new VertexEmbeddingModel(modelId, baseURL, "", fetcher),
    transcriptionModel: (modelId) => new VertexTranscriptionModel(modelId, baseURL, "", fetcher),
    speechModel: (modelId) => new VertexSpeechModel(modelId, baseURL, "", fetcher),
    imageGenerationModel: (modelId) => new VertexImageGenerationModel(modelId, baseURL, "", fetcher),
    videoGenerationModel: (modelId) => new VertexVideoGenerationModel(modelId, baseURL, "", fetcher),
    musicGenerationModel: (modelId) => new VertexMusicGenerationModel(modelId, baseURL, "", fetcher),
    realtimeModel: (modelId) =>
      new VertexRealtimeModel(
        modelId,
        auth,
        location,
        apiVersion,
        options.realtimeConnectionFactory,
        options.realtimeURL
      ),
    groundedLanguageModel: (modelId) => new VertexGroundedLanguageModel(modelId, baseURL, "", fetcher),
    caches: new VertexContextCachesClient(baseURL, "", fetcher),
    batches: new VertexBatchesClient(baseURL, "", fetcher),
    predictionModel: (modelId) => new VertexPredictionModel(modelId, baseURL, "", fetcher),
    rawFetch: fetcher
  });
};

export const vertexMcpTools = createMcpToolSet;
