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
  type BatchCreateInput,
  type BatchJob,
  type BatchGetInput,
  type BatchListInput,
  type BatchCancelInput,
  type BatchDeleteInput,
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
  type EmbedValue,
  type FileDeleteInput,
  type FileGetInput,
  type FileListInput,
  type FileSearchStore,
  type FileSearchStoreCreateInput,
  type FileSearchStoreDeleteInput,
  type FileSearchStoreGetInput,
  type FileSearchStoreImportInput,
  type FileSearchStoreListInput,
  type FileSearchStoreUploadInput,
  type FileSearchStoresClient,
  type FileUploadInput,
  type FilesClient,
  type GenerateResult,
  type GeneratedMedia,
  type GroundedGenerateResult,
  type GroundedLanguageModel,
  type ImageGenerationModel,
  type ImageGenerationResult,
  type InteractionCreateInput,
  type InteractionGetInput,
  type InteractionsClient,
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
  type RealtimeTokenResult,
  type SpeechModel,
  type SpeechResult,
  type StreamEvent,
  type TranscriptionModel,
  type TranscriptionResult,
  type UploadedFile,
  type VideoGenerationModel,
  type VideoGenerationResult
} from "@zhivex-ai/core";

export interface GeminiProviderOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  realtimeURL?: string;
  browserTokenURL?: string;
  realtimeConnectionFactory?: RealtimeConnectionFactory;
}

export interface GeminiLanguageModelOptions {
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
  audioInput: true,
  audioOutput: false,
  embeddings: true,
  fileSearch: true,
  urlContext: true,
  contextCaching: true,
  batch: true,
  interactions: true,
  rawPrediction: true,
  computerUse: true,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: true,
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
    browserTokens: true
  }
};

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Gemini request failed with status ${response.status}.`, response.status, {
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

const embeddingValueToPart = (value: EmbedValue, modelId: string) => {
  if (typeof value === "string") {
    return { text: value };
  }

  if (modelId !== "gemini-embedding-2") {
    throw new UnsupportedFeatureError(
      `Model "gemini/${modelId}" does not support multimodal embedding values. Use "gemini-embedding-2" for Gemini multimodal embeddings.`
    );
  }

  if (!value.uri && value.data === undefined) {
    throw new UnsupportedFeatureError('Provider "gemini" requires embedding media values to include "data" or "uri".');
  }

  return mediaInputToPart(value);
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

const dataToBytes = async (data: FileUploadInput["data"]): Promise<Uint8Array> => {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(await data.arrayBuffer());
};

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const normalizeUploadedFile = (json: any): UploadedFile => {
  const file = json.file ?? json;
  return {
    name: file.name ?? "",
    uri: file.uri ?? file.fileUri ?? file.file_uri,
    mimeType: file.mimeType ?? file.mime_type,
    sizeBytes: file.sizeBytes ?? file.size_bytes,
    state: file.state,
    displayName: file.displayName ?? file.display_name,
    rawResponse: json,
    providerMetadata: file
  };
};

const normalizeFileSearchStore = (json: any): FileSearchStore => ({
  name: json.name ?? "",
  displayName: json.displayName ?? json.display_name,
  createTime: json.createTime ?? json.create_time,
  updateTime: json.updateTime ?? json.update_time,
  rawResponse: json,
  providerMetadata: json
});

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

const normalizeInteraction = (json: any) => ({
  id: json.id ?? json.name ?? "",
  name: json.name,
  model: json.model,
  status: json.status,
  outputs: json.outputs,
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

const geminiUploadBaseURL = (baseURL: string) => baseURL.replace(/\/v1beta\/?$/, "/upload/v1beta");

const pollGeminiOperation = async (
  operation: PredictionOperation,
  baseURL: string,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
  options: { pollIntervalMs?: number; timeoutMs?: number; abortSignal?: AbortSignal; maxRetries?: number; retryBackoffMs?: number }
) => {
  if (options.pollIntervalMs === undefined && options.timeoutMs === undefined) {
    return operation;
  }

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 600_000;
  let current = operation;

  while (!current.done) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Gemini operation "${operation.name}" timed out after ${timeoutMs}ms.`);
    }
    await sleep(options.pollIntervalMs ?? 5_000, options.abortSignal);
    const response = await withRetry(
      () =>
        fetcher(`${baseURL}/${current.name}?key=${apiKey}`, {
          method: "GET",
          signal: options.abortSignal
        }),
      options
    );
    current = normalizeOperation(await parseJson(response));
  }

  return current;
};

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
    case "audio":
      return {
        inlineData: {
          mimeType: part.mediaType,
          data: toBase64(part.data)
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
          id: part.toolCall.id,
          name: part.toolCall.name,
          args: part.toolCall.input
        },
        ...(typeof part.toolCall.providerMetadata?.geminiThoughtSignature === "string"
          ? { thoughtSignature: part.toolCall.providerMetadata.geminiThoughtSignature }
          : {})
      };
    case "tool-result":
      return {
        functionResponse: {
          id: part.toolResult.toolCallId,
          name: part.toolResult.toolName,
          response: {
            name: part.toolResult.toolName,
            content: part.toolResult.isError ? part.toolResult.error : part.toolResult.output
          }
        }
      };
    default:
      return {
        text: JSON.stringify(part)
      };
  }
};

const mapMessages = (messages: ModelMessage[]) =>
  messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: message.parts.map(mapPart)
    }));

const toGeminiSchema = (schema: unknown): JsonValue => {
  if (Array.isArray(schema)) {
    return schema.map(toGeminiSchema) as JsonValue;
  }

  if (!schema || typeof schema !== "object") {
    return schema as JsonValue;
  }

  const mapped: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key.startsWith("$") || key === "additionalProperties" || value === undefined) {
      continue;
    }
    mapped[key] = toGeminiSchema(value);
  }
  return mapped;
};

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? (() => {
        const mappedTools: Array<Record<string, unknown>> = [];
        const functionDeclarations = Object.values(tools)
          .filter(isCallableToolDefinition)
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toGeminiSchema(toJSONSchema(tool.schema))
          }));

        if (functionDeclarations.length) {
          mappedTools.push({ functionDeclarations });
        }

        for (const tool of Object.values(tools).filter(isHostedToolDefinition)) {
          if (tool.provider && tool.provider !== "gemini") {
            throw new UnsupportedFeatureError(
              `Provider "gemini" does not support hosted tools declared for provider "${tool.provider}".`
            );
          }

          mappedTools.push({
            [tool.type]: tool.config && typeof tool.config === "object" ? tool.config : {}
          });
        }

        return mappedTools.length ? mappedTools : undefined;
      })()
    : undefined;

const mapToolConfig = (
  toolChoice: ModelGenerateInput["toolChoice"],
  tools: ModelGenerateInput["tools"],
  messages: ModelMessage[]
) => {
  const latestMessage = messages.at(-1);
  if (latestMessage?.role === "tool" && toolChoice !== "none") {
    return undefined;
  }

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
    throw new UnsupportedFeatureError('Provider "gemini" does not support selecting a hosted tool by name.');
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
        Object.entries(providerOptions).filter(
          ([key]) =>
            ![
              "headers",
              "realtime_url",
              "realtime_query",
              "access_token",
              "accessToken",
              "apiVersion",
              "api_version",
              "translationConfig"
            ].includes(key)
        )
      )
    : {};

const isGeminiLiveTranslateModel = (modelId: string) => /^gemini-3\.5-live-translate(?:-preview)?$/i.test(modelId.trim());
const isGemini31FlashLiveModel = (modelId: string) => /^gemini-3\.1-flash-live(?:-preview)?$/i.test(modelId.trim());

const geminiRealtimeURL = (baseURL: string, apiKey: string, providerOptions?: Record<string, unknown>) => {
  const override = providerOptions?.realtime_url;
  if (typeof override === "string" && override) {
    return override;
  }

  const url = new URL(baseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  const apiVersion = providerOptions?.apiVersion ?? providerOptions?.api_version ?? "v1beta";
  url.pathname = `/ws/google.ai.generativelanguage.${String(apiVersion)}.GenerativeService.BidiGenerateContent`;
  const extraQuery = providerOptions?.realtime_query;
  if (extraQuery && typeof extraQuery === "object" && !Array.isArray(extraQuery)) {
    for (const [key, value] of Object.entries(extraQuery as Record<string, unknown>)) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  const accessToken = providerOptions?.access_token ?? providerOptions?.accessToken;
  if (typeof accessToken === "string" && accessToken) {
    url.searchParams.set("access_token", accessToken);
  } else {
    url.searchParams.set("key", apiKey);
  }
  return url.toString();
};

const geminiRealtimeHeaders = (providerOptions?: Record<string, unknown>) =>
  typeof providerOptions?.headers === "object" && providerOptions.headers && !Array.isArray(providerOptions.headers)
    ? Object.fromEntries(
        Object.entries(providerOptions.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)])
      )
    : {};

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

const assertGeminiRealtimeTranslateConfig = (config: RealtimeSessionConfig, modelId: string) => {
  if (!isGeminiLiveTranslateModel(modelId)) {
    return;
  }

  if (config.mode && config.mode !== "translation") {
    throw new UnsupportedFeatureError(
      'Model "gemini/gemini-3.5-live-translate-preview" only supports realtime translation mode.'
    );
  }

  if (!config.translation?.targetLanguage) {
    throw new UnsupportedFeatureError(
      'Model "gemini/gemini-3.5-live-translate-preview" requires "translation.targetLanguage".'
    );
  }

  const tools = toToolSet(config.tools);
  if (tools && Object.keys(tools).length > 0) {
    throw new UnsupportedFeatureError(
      'Model "gemini/gemini-3.5-live-translate-preview" does not support realtime tools.'
    );
  }

  if (config.reasoning) {
    throw new UnsupportedFeatureError(
      'Model "gemini/gemini-3.5-live-translate-preview" does not support realtime reasoning.'
    );
  }

  if (config.instructions || config.translation?.instructions) {
    throw new UnsupportedFeatureError(
      'Model "gemini/gemini-3.5-live-translate-preview" does not support realtime system instructions.'
    );
  }
};

const assertGeminiRealtimeConfig = (config: RealtimeSessionConfig, modelId: string) => {
  assertGeminiRealtimeTranslateConfig(config, modelId);

  if (!isGemini31FlashLiveModel(modelId)) {
    return;
  }

  if (config.affectiveDialog !== undefined) {
    throw new UnsupportedFeatureError(
      'Model "gemini/gemini-3.1-flash-live-preview" does not support realtime affectiveDialog.'
    );
  }

  if (config.proactiveAudio !== undefined) {
    throw new UnsupportedFeatureError(
      'Model "gemini/gemini-3.1-flash-live-preview" does not support realtime proactiveAudio.'
    );
  }
};

const geminiRealtimeSetup = (config: RealtimeSessionConfig, modelId: string) => ({
  setup: {
    model: `models/${modelId}`,
    generationConfig: {
      responseModalities: isGeminiLiveTranslateModel(modelId) || config.outputAudioMediaType || config.voice ? ["AUDIO"] : ["TEXT"],
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

const parseGeminiRealtimeEvent = (payload: Record<string, unknown>) => {
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

  const toolCall =
    typeof payload.toolCall === "object" && payload.toolCall
      ? (payload.toolCall as Record<string, unknown>)
      : typeof payload.tool_call === "object" && payload.tool_call
        ? (payload.tool_call as Record<string, unknown>)
        : undefined;
  if (toolCall) {
    const calls = Array.isArray(toolCall.functionCalls)
      ? toolCall.functionCalls
      : Array.isArray(toolCall.function_calls)
        ? toolCall.function_calls
        : [toolCall];
    return calls
      .filter((call): call is Record<string, unknown> => Boolean(call && typeof call === "object"))
      .map((call) => ({
        type: "realtime-tool-call" as const,
        toolCall: {
          id: typeof call.id === "string" ? call.id : `${String(call.name ?? "")}-0`,
          name: String(call.name ?? ""),
          input: (call.args ?? {}) as JsonValue
        }
      }));
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
        'Provider "gemini" uses "reasoning.effort" for Gemini 3 models and does not support "reasoning.budgetTokens".'
      );
    }

    if (input.reasoning.effort === "none") {
      throw new UnsupportedFeatureError('Provider "gemini" does not support "reasoning.effort=none" for Gemini 3 models.');
    }

    if (input.reasoning.effort === "xhigh") {
      throw new UnsupportedFeatureError('Provider "gemini" does not support "reasoning.effort=xhigh".');
    }

    if (input.reasoning.effort === "minimal" && isGemini3ProModel(modelId)) {
      throw new UnsupportedFeatureError(
        'Provider "gemini" does not support "reasoning.effort=minimal" for Gemini 3 Pro models.'
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
      'Provider "gemini" does not support "reasoning.effort" for models earlier than Gemini 3.'
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
        responseSchema: toGeminiSchema(toJSONSchema(input.structuredOutput.schema))
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
            input: part.functionCall.args ?? {},
            ...(typeof part.thoughtSignature === "string"
              ? { providerMetadata: { geminiThoughtSignature: part.thoughtSignature } }
              : {})
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

class GeminiFilesClient implements FilesClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(path: string, query: Record<string, string | number | undefined> = {}) {
    return appendQuery(`${this.baseURL}/${path}`, { key: this.apiKey, ...query });
  }

  private uploadUrl(path: string) {
    return appendQuery(`${geminiUploadBaseURL(this.baseURL)}/${path}`, { key: this.apiKey });
  }

  async upload(input: FileUploadInput): Promise<UploadedFile> {
    const bytes = await dataToBytes(input.data);
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const startResponse = await withRetry(
        () =>
          this.fetcher(this.uploadUrl("files"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-upload-protocol": "resumable",
              "x-goog-upload-command": "start",
              "x-goog-upload-header-content-length": String(bytes.byteLength),
              "x-goog-upload-header-content-type": input.mediaType
            },
            signal,
            body: JSON.stringify({
              file: {
                ...(input.displayName ? { displayName: input.displayName } : {}),
                ...(input.name ? { name: input.name } : {}),
                ...(input.providerOptions ?? {})
              }
            })
          }),
        input
      );
      if (!startResponse.ok) {
        await parseJson(startResponse);
      }
      const resumableUrl = startResponse.headers.get("x-goog-upload-url");
      if (!resumableUrl) {
        throw new ProviderHTTPError('Gemini file upload did not return "x-goog-upload-url".', 500);
      }

      const uploadResponse = await withRetry(
        () =>
          this.fetcher(resumableUrl, {
            method: "POST",
            headers: {
              "content-type": input.mediaType,
              "x-goog-upload-command": "upload, finalize",
              "x-goog-upload-offset": "0"
            },
            signal,
            body: new Blob([bytesToArrayBuffer(bytes)], { type: input.mediaType })
          }),
        input
      );
      return normalizeUploadedFile(await parseJson(uploadResponse));
    } finally {
      cleanup();
    }
  }

  async get(input: FileGetInput): Promise<UploadedFile> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(this.url(input.name), { method: "GET", signal }), input);
      return normalizeUploadedFile(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: FileListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () => this.fetcher(this.url("files", { pageSize: input.pageSize, pageToken: input.pageToken }), { method: "GET", signal }),
        input
      );
      const json = await parseJson(response);
      return {
        files: (json.files ?? []).map(normalizeUploadedFile),
        nextPageToken: json.nextPageToken,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async delete(input: FileDeleteInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(this.url(input.name), { method: "DELETE", signal }), input);
      const json = await parseJson(response);
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class GeminiFileSearchStoresClient implements FileSearchStoresClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(path: string, query: Record<string, string | number | undefined> = {}) {
    return appendQuery(`${this.baseURL}/${path}`, { key: this.apiKey, ...query });
  }

  private uploadUrl(path: string) {
    return appendQuery(`${geminiUploadBaseURL(this.baseURL)}/${path}`, { key: this.apiKey });
  }

  async create(input: FileSearchStoreCreateInput = {}): Promise<FileSearchStore> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("fileSearchStores"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
              ...(input.displayName ? { displayName: input.displayName } : {}),
              ...(input.providerOptions ?? {})
            })
          }),
        input
      );
      return normalizeFileSearchStore(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async upload(input: FileSearchStoreUploadInput): Promise<PredictionOperation> {
    const bytes = await dataToBytes(input.data);
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const startResponse = await withRetry(
        () =>
          this.fetcher(this.uploadUrl(`${input.storeName}:uploadToFileSearchStore`), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-upload-protocol": "resumable",
              "x-goog-upload-command": "start",
              "x-goog-upload-header-content-length": String(bytes.byteLength),
              "x-goog-upload-header-content-type": input.mediaType
            },
            signal,
            body: JSON.stringify({
              file: {
                ...(input.displayName ? { displayName: input.displayName } : {}),
                ...(input.filename ? { name: input.filename } : {})
              },
              ...(input.providerOptions ?? {})
            })
          }),
        input
      );
      if (!startResponse.ok) {
        await parseJson(startResponse);
      }
      const resumableUrl = startResponse.headers.get("x-goog-upload-url");
      if (!resumableUrl) {
        throw new ProviderHTTPError('Gemini file search upload did not return "x-goog-upload-url".', 500);
      }
      const uploadResponse = await withRetry(
        () =>
          this.fetcher(resumableUrl, {
            method: "POST",
            headers: {
              "content-type": input.mediaType,
              "x-goog-upload-command": "upload, finalize",
              "x-goog-upload-offset": "0"
            },
            signal,
            body: new Blob([bytesToArrayBuffer(bytes)], { type: input.mediaType })
          }),
        input
      );
      return pollGeminiOperation(normalizeOperation(await parseJson(uploadResponse)), this.baseURL, this.apiKey, this.fetcher, {
        ...input,
        abortSignal: signal
      });
    } finally {
      cleanup();
    }
  }

  async importFile(input: FileSearchStoreImportInput): Promise<PredictionOperation> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(`${input.storeName}:importFile`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
              fileName: input.fileName,
              ...(input.providerOptions ?? {})
            })
          }),
        input
      );
      return pollGeminiOperation(normalizeOperation(await parseJson(response)), this.baseURL, this.apiKey, this.fetcher, {
        ...input,
        abortSignal: signal
      });
    } finally {
      cleanup();
    }
  }

  async get(input: FileSearchStoreGetInput): Promise<FileSearchStore> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(this.url(input.name), { method: "GET", signal }), input);
      return normalizeFileSearchStore(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: FileSearchStoreListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () => this.fetcher(this.url("fileSearchStores", { pageSize: input.pageSize, pageToken: input.pageToken }), { method: "GET", signal }),
        input
      );
      const json = await parseJson(response);
      return {
        stores: (json.fileSearchStores ?? json.file_search_stores ?? []).map(normalizeFileSearchStore),
        nextPageToken: json.nextPageToken,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async delete(input: FileSearchStoreDeleteInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(this.url(input.name), { method: "DELETE", signal }), input);
      const json = await parseJson(response);
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class GeminiContextCachesClient implements ContextCachesClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(path: string, query: Record<string, string | number | undefined> = {}) {
    return appendQuery(`${this.baseURL}/${path}`, { key: this.apiKey, ...query });
  }

  async create(input: ContextCacheCreateInput): Promise<CachedContent> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("cachedContents"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
              model: input.modelId.startsWith("models/") ? input.modelId : `models/${input.modelId}`,
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
      const response = await withRetry(() => this.fetcher(this.url(input.name), { method: "GET", signal }), input);
      return normalizeCachedContent(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: ContextCacheListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () => this.fetcher(this.url("cachedContents", { pageSize: input.pageSize, pageToken: input.pageToken }), { method: "GET", signal }),
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
      const response = await withRetry(() => this.fetcher(this.url(input.name), { method: "DELETE", signal }), input);
      const json = await parseJson(response);
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class GeminiBatchesClient implements BatchesClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(path: string, query: Record<string, string | number | undefined> = {}) {
    return appendQuery(`${this.baseURL}/${path}`, { key: this.apiKey, ...query });
  }

  async create(input: BatchCreateInput): Promise<BatchJob> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(`models/${input.modelId}:batchGenerateContent`), {
            method: "POST",
            headers: { "content-type": "application/json" },
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
      const response = await withRetry(() => this.fetcher(this.url(input.name), { method: "GET", signal }), input);
      return normalizeBatchJob(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: BatchListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () => this.fetcher(this.url("batches", { pageSize: input.pageSize, pageToken: input.pageToken }), { method: "GET", signal }),
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
          this.fetcher(this.url(`${input.name}:cancel`), {
            method: "POST",
            headers: { "content-type": "application/json" },
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
      const response = await withRetry(() => this.fetcher(this.url(`${input.name}:delete`), { method: "POST", signal }), input);
      const json = await parseJson(response);
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class GeminiInteractionsClient implements InteractionsClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(path: string, query: Record<string, string | number | undefined> = {}) {
    return appendQuery(`${this.baseURL}/${path}`, { key: this.apiKey, ...query });
  }

  private body(input: InteractionCreateInput, stream = false) {
    return {
      ...(input.modelId ? { model: input.modelId } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      input: input.input,
      ...(input.previousInteractionId ? { previous_interaction_id: input.previousInteractionId } : {}),
      ...(input.tools ? { tools: mapTools(toToolSet(input.tools)) } : {}),
      ...(input.background !== undefined ? { background: input.background } : {}),
      ...(input.store !== undefined ? { store: input.store } : {}),
      ...(stream ? { stream: true } : {}),
      ...(input.providerOptions ?? {})
    };
  }

  async create(input: InteractionCreateInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("interactions"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify(this.body(input))
          }),
        input
      );
      return normalizeInteraction(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async get(input: InteractionGetInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(this.url(`interactions/${input.id}`), { method: "GET", signal }), input);
      return normalizeInteraction(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async stream(input: InteractionCreateInput): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(this.url("interactions", { alt: "sse" }), {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify(this.body(input, true))
        }),
      input
    );

    return (async function* () {
      try {
        for await (const event of streamSSE(response)) {
          const json = JSON.parse(event.data);
          const text =
            json.text ??
            json.delta?.text ??
            json.output?.text ??
            (Array.isArray(json.outputs) ? json.outputs.find((output: any) => typeof output.text === "string")?.text : undefined);
          if (typeof text === "string" && text) {
            yield { type: "text-delta", textDelta: text } satisfies StreamEvent;
          } else {
            yield { type: "provider-data", provider: "gemini", data: json } satisfies StreamEvent;
          }
          if (json.status === "completed" || json.done) {
            yield { type: "finish", finishReason: "stop" } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
  }
}

class GeminiPredictionModel implements PredictionModel {
  readonly provider = "gemini";
  readonly capabilities: ModelCapabilities = {
    ...capabilities,
    rawPrediction: true
  };

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(action: string) {
    return `${this.baseURL}/models/${this.modelId}:${action}?key=${this.apiKey}`;
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
            headers: { "content-type": "application/json" },
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
            headers: { "content-type": "application/json" },
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
            headers: { "content-type": "application/json" },
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
            headers: { "content-type": "application/json" },
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
          this.fetcher(`${this.baseURL}/${input.name}?key=${this.apiKey}`, {
            method: "GET",
            signal
          }),
        input
      );
      return normalizeOperation(await parseJson(response));
    } finally {
      cleanup();
    }
  }
}

class GeminiLanguageModel implements LanguageModel<GeminiLanguageModelOptions> {
  readonly provider = "gemini";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(action: string) {
    const separator = action.includes("?") ? "&" : "?";
    return `${this.baseURL}/models/${this.modelId}:${action}${separator}key=${this.apiKey}`;
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("generateContent"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
              contents: mapMessages(input.messages),
              systemInstruction: systemInstruction(input.messages),
              tools: mapTools(input.tools),
              ...input.providerOptions,
              toolConfig: mapToolConfig(input.toolChoice, input.tools, input.messages),
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

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(this.url("streamGenerateContent?alt=sse"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            contents: mapMessages(input.messages),
            systemInstruction: systemInstruction(input.messages),
            tools: mapTools(input.tools),
            ...input.providerOptions,
            toolConfig: mapToolConfig(input.toolChoice, input.tools, input.messages),
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
                  input: part.functionCall.args ?? {},
                  ...(typeof part.thoughtSignature === "string"
                    ? { providerMetadata: { geminiThoughtSignature: part.thoughtSignature } }
                    : {})
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

class GeminiEmbeddingModel implements EmbeddingModel {
  readonly provider = "gemini";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async embed(input: EmbedInput & { abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<EmbedResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const embeddings = await Promise.all(
        input.values.map(async (value) => {
          const part = embeddingValueToPart(value, this.modelId);
          const response = await withRetry(
            () =>
              this.fetcher(`${this.baseURL}/models/${this.modelId}:embedContent?key=${this.apiKey}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal,
                body: JSON.stringify({
                  content: { parts: [part] }
                })
              }),
            input
          );
          const json = await parseJson(response);
          return json.embedding.values;
        })
      );

      return {
        embeddings
      };
    } finally {
      cleanup();
    }
  }
}

class GeminiTranscriptionModel implements TranscriptionModel {
  readonly provider = "gemini";
  readonly capabilities = transcriptionCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

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
          this.fetcher(`${this.baseURL}/models/${this.modelId}:generateContent?key=${this.apiKey}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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
      const candidate = json.candidates?.[0];
      const text = candidate?.content?.parts?.find((part: any) => typeof part.text === "string")?.text ?? "";
      return {
        text,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class GeminiSpeechModel implements SpeechModel {
  readonly provider = "gemini";
  readonly capabilities = speechCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

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
          this.fetcher(`${this.baseURL}/models/${this.modelId}:generateContent?key=${this.apiKey}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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

class GeminiImageGenerationModel implements ImageGenerationModel {
  readonly provider = "gemini";
  readonly capabilities = imageGenerationCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

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
    const { generationConfig, providerOptions } = splitGenerationConfig(input.providerOptions);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/models/${this.modelId}:generateContent?key=${this.apiKey}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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

class GeminiMusicGenerationModel implements MusicGenerationModel {
  readonly provider = "gemini";
  readonly capabilities = musicGenerationCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

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
    const { generationConfig, providerOptions } = splitGenerationConfig(input.providerOptions);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/models/${this.modelId}:generateContent?key=${this.apiKey}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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

class GeminiVideoGenerationModel implements VideoGenerationModel {
  readonly provider = "gemini";
  readonly capabilities = videoGenerationCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

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
          this.fetcher(`${this.baseURL}/models/${this.modelId}:predictLongRunning?key=${this.apiKey}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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
          throw new Error(`Gemini video generation timed out after ${timeoutMs}ms.`);
        }
        await sleep(pollIntervalMs, signal);
        const pollResponse = await withRetry(
          () =>
            this.fetcher(`${this.baseURL}/${operationName}?key=${this.apiKey}`, {
              method: "GET",
              signal
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

class GeminiGroundedLanguageModel implements GroundedLanguageModel {
  readonly provider = "gemini";
  readonly capabilities = groundedCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

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
          this.fetcher(`${this.baseURL}/models/${this.modelId}:generateContent?key=${this.apiKey}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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

class GeminiRealtimeModel implements RealtimeModel {
  readonly provider = "gemini";
  readonly capabilities = realtimeCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly connectionFactory?: RealtimeConnectionFactory,
    private readonly realtimeURL?: string,
    private readonly browserTokenURL?: string
  ) {}

  async connect(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions) {
    assertGeminiRealtimeConfig(config, this.modelId);

    const providerOptions = (config.providerOptions ?? {}) as Record<string, unknown>;
    const connection = await (this.connectionFactory ?? openWebSocketConnection)(
      this.realtimeURL ?? geminiRealtimeURL(this.baseURL, this.apiKey, providerOptions),
      geminiRealtimeHeaders(providerOptions),
      options
    );
    const session = new CallbackRealtimeSession({
      provider: this.provider,
      modelId: this.modelId,
      capabilities: this.capabilities,
      config,
      connection,
      callbacks: {
        parseEvent: parseGeminiRealtimeEvent,
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
              'Model "gemini/gemini-3.5-live-translate-preview" only supports audio input.'
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
              'Model "gemini/gemini-3.5-live-translate-preview" only supports audio input.'
            );
          }

          return [
            {
              realtimeInput: {
                text
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
          assertGeminiRealtimeConfig(sessionConfig, this.modelId);
          return [geminiRealtimeSetup(sessionConfig, this.modelId)];
        },
        buildInitialPayloads: (sessionConfig) => {
          assertGeminiRealtimeConfig(sessionConfig, this.modelId);
          return [geminiRealtimeSetup(sessionConfig, this.modelId)];
        }
      }
    });
    await session.initialize();
    return session;
  }

  async createBrowserToken(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions): Promise<RealtimeTokenResult> {
    const providerOptions = (config.providerOptions ?? {}) as Record<string, unknown>;
    const url =
      this.browserTokenURL ??
      `${this.baseURL.replace(/\/v1beta\/?$/, "")}/v1alpha/authTokens?key=${encodeURIComponent(this.apiKey)}`;
    const response = await withRetry(
      () =>
        this.fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: options?.signal,
          body: JSON.stringify({
            authToken: {
              ...(providerOptions.expireTime || providerOptions.expire_time
                ? { expireTime: providerOptions.expireTime ?? providerOptions.expire_time }
                : {}),
              ...(providerOptions.newSessionExpireTime || providerOptions.new_session_expire_time
                ? { newSessionExpireTime: providerOptions.newSessionExpireTime ?? providerOptions.new_session_expire_time }
                : {}),
              ...(providerOptions.uses ? { uses: providerOptions.uses } : {})
            }
          })
        }),
      {
        timeoutMs: options?.timeoutMs
      }
    );
    const body = await parseJson(response);
    const authToken =
      typeof body.authToken === "object" && body.authToken ? (body.authToken as Record<string, unknown>) : (body as Record<string, unknown>);
    const value =
      typeof authToken.name === "string"
        ? authToken.name
        : typeof authToken.token === "string"
          ? authToken.token
          : typeof authToken.accessToken === "string"
            ? authToken.accessToken
            : "";
    if (!value) {
      throw new ProviderHTTPError('Provider "gemini" did not return a valid ephemeral token.', 500);
    }
    return {
      value,
      expiresAtMs:
        typeof authToken.expireTime === "string" ? Date.parse(authToken.expireTime) : typeof authToken.expire_time === "string" ? Date.parse(authToken.expire_time) : undefined,
      rawResponse: body
    };
  }
}

export const createGemini = (
  options: GeminiProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Gemini API key.");
  }

  const baseURL = options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta";
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "gemini",
    languageModel: (modelId) => new GeminiLanguageModel(modelId, apiKey, baseURL, fetcher),
    embeddingModel: (modelId) => new GeminiEmbeddingModel(modelId, apiKey, baseURL, fetcher),
    transcriptionModel: (modelId) => new GeminiTranscriptionModel(modelId, apiKey, baseURL, fetcher),
    speechModel: (modelId) => new GeminiSpeechModel(modelId, apiKey, baseURL, fetcher),
    imageGenerationModel: (modelId) => new GeminiImageGenerationModel(modelId, apiKey, baseURL, fetcher),
    videoGenerationModel: (modelId) => new GeminiVideoGenerationModel(modelId, apiKey, baseURL, fetcher),
    musicGenerationModel: (modelId) => new GeminiMusicGenerationModel(modelId, apiKey, baseURL, fetcher),
    realtimeModel: (modelId) =>
      new GeminiRealtimeModel(
        modelId,
        apiKey,
        baseURL,
        fetcher,
        options.realtimeConnectionFactory,
        options.realtimeURL,
        options.browserTokenURL
      ),
    groundedLanguageModel: (modelId) => new GeminiGroundedLanguageModel(modelId, apiKey, baseURL, fetcher),
    files: new GeminiFilesClient(apiKey, baseURL, fetcher),
    fileSearchStores: new GeminiFileSearchStoresClient(apiKey, baseURL, fetcher),
    caches: new GeminiContextCachesClient(apiKey, baseURL, fetcher),
    batches: new GeminiBatchesClient(apiKey, baseURL, fetcher),
    interactions: new GeminiInteractionsClient(apiKey, baseURL, fetcher),
    predictionModel: (modelId) => new GeminiPredictionModel(modelId, apiKey, baseURL, fetcher),
    rawFetch: fetcher
  });
};

export const geminiMcpTools = createMcpToolSet;
