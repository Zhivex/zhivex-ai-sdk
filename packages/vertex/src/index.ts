import { normalizeVertexTranscriptionConfig, transcriptionRequest, transcriptionResponse, type VertexTranscriptionResult, type VertexTranscriptionModel as VertexTranscriptionModelContract } from "./transcription.js";
export type { VertexAudioTranscriptionConfig, VertexAudioTranscription, VertexTranscriptionOptions, VertexTranscriptionResult, VertexTranscriptionModel } from "./transcription.js";
import { createVertexVirtualTryOnClient, type VertexVirtualTryOnClient } from "./virtual-try-on.js";
import { createVertexEndpointsClient, type VertexEndpointsClient } from "./endpoints.js";
import { createVertexGrpcClient, type VertexGrpcClient } from "./grpc.js";
export type { VertexGrpcServerInput, VertexGrpcClient, VertexGrpcRawInput, VertexGrpcTensorInput, VertexGrpcTensorFrame, VertexGrpcTensorOutput } from "./grpc.js";
export type { VertexTensor, VertexTensorDataType } from "./tensors.js";
export type { VertexEndpointDirectPredictInput, VertexEndpointDirectPredictResult } from "./endpoints.js";
export type { VertexEndpointsClient, VertexEndpointRawPredictInput, VertexEndpointRawPredictResult, VertexEndpointStreamEvent, VertexEndpointDirectRawPredictInput, VertexEndpointDirectRawPredictResult, VertexEndpointExplainInput, VertexEndpointExplainResult } from "./endpoints.js";
export type { VertexVirtualTryOnClient, VertexVirtualTryOnInput, VertexVirtualTryOnResult } from "./virtual-try-on.js";
import { createVertexResponsesModel } from "./responses.js";
import type { VertexGeminiClient, VertexGeminiTokenCountInput } from "./token-counting.js";
export type { VertexGeminiClient, VertexGeminiTokenCountInput, VertexGeminiTokenCountResult } from "./token-counting.js";
import { VertexLegacyMultimodalEmbeddingModel, type VertexMultimodalEmbeddingInput, type VertexMultimodalEmbeddingClient } from "./multimodal-embeddings.js";
export type { VertexMultimodalEmbeddingClient, VertexMultimodalEmbeddingInput, VertexMultimodalEmbeddingResult, VertexVideoSegmentConfig } from "./multimodal-embeddings.js";
import { createVertexInteractionsClient, type VertexInteractionsClient } from "./interactions.js";
export type { VertexInteractionsClient, VertexInteractionResumeInput } from "./interactions.js";
export type { VertexClaudeOptions } from "./anthropic.js";
import { createVertexSpecializedClients, type VertexSpecializedClients } from "./specialized.js";
export type { VertexOCRClient, VertexFIMClient, VertexSpecializedClients } from "./specialized.js";
import { VertexEmbeddingModel, VertexOpenEmbeddingModel } from "./embeddings.js";
export type { VertexEmbeddingOptions } from "./embeddings.js";
import { createVertexChatModel, isVertexChatModel, type VertexChatModelOptions } from "./chat.js";
export type { VertexChatModelOptions } from "./chat.js";
import { createVertexClaudeModel } from "./anthropic.js";
import { createVertexClaudeClient, type VertexClaudeClient } from "./token-counting.js";
export type { VertexClaudeClient, VertexClaudeTokenCountInput, VertexClaudeTokenCountResult } from "./token-counting.js";
import { GoogleAuth } from "google-auth-library";
import { toJSONSchema } from "zod";
import {
  capabilities,
  groundedCapabilities,
  imageGenerationCapabilities,
  isGeminiLiveTranslateModel,
  isVertexLiveTranscribeModel,
  musicGenerationCapabilities,
  realtimeCapabilities,
  speechCapabilities,
  transcriptionCapabilities,
  videoGenerationCapabilities,
} from "./capabilities.js";

import {
  CallbackRealtimeSession,
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  assertTrustedEndpoint,
  createMcpToolSet,
  createProviderAdapter,
  decodeBase64WithLimit,
  encodeAudioFrame,
  encodeMediaFrame,
  isCallableToolDefinition,
  isHostedToolDefinition,
  normalizeFinishReason,
  openWebSocketConnection,
  readErrorBodyWithLimit,
  readJsonWithLimit,
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
  type ContextCacheUpdateInput,
  type ContextCacheDeleteInput,
  type ContextCacheGetInput,
  type ContextCacheListInput,
  type ContextCachesClient,
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
  type RealtimeConnectOptions,
  type RealtimeConnectionFactory,
  type RealtimeEvent,
  type RealtimeModel,
  type RealtimeSessionConfig,
  type SpeechModel,
  type SpeechResult,
  type StreamEvent,
  type VideoGenerationModel,
  type VideoGenerationResult
} from "@zhivex-ai/core/provider";

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
  /** Allow non-HTTPS/private or cross-origin credentialed endpoint overrides. Server-side only. */
  allowUnsafeEndpoints?: boolean;
}

const vertexApiHost = (location: string) => location === "global"
  ? "aiplatform.googleapis.com"
  : location === "us" || location === "eu"
    ? `aiplatform.${location}.rep.googleapis.com`
    : `${encodeVertexPathSegment(location, "Vertex location")}-aiplatform.googleapis.com`;

// Resource names returned by Google are already project-qualified.
const vertexResourceURL = (baseURL: string, name: string) => {
  const encoded = encodeVertexResourceName(name, "Vertex resource name");
  return name.startsWith("projects/")
    ? `${baseURL.replace(/\/projects\/.*$/, "")}/${encoded}`
    : `${baseURL}/${encoded}`;
};

const encodeVertexPathSegment = (value: string, label: string) => {
  if (!value || value === "." || value === ".." || /[\\/?#\s]/.test(value)) {
    throw new ConfigurationError(`${label} must be a non-empty opaque identifier without path separators.`);
  }
  return encodeURIComponent(value);
};

const encodeVertexResourceName = (value: string, label: string) => {
  if (!value || /[\\?#]/.test(value)) {
    throw new ConfigurationError(`${label} must be a non-empty resource name without query or fragment delimiters.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ConfigurationError(`${label} must not contain empty or traversal path segments.`);
  }
  return segments.map(encodeURIComponent).join("/");
};

export interface VertexLanguageModelOptions {
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  candidateCount?: number;
  responseMimeType?: string;
  [key: string]: unknown;
}

const MIB = 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 128 * MIB;
const MAX_MEDIA_RESPONSE_BYTES = 64 * MIB;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

const diagnosticEndpoint = (response: Response): string | undefined => {
  if (!response.url) {
    return undefined;
  }
  try {
    const endpoint = new URL(response.url);
    endpoint.username = "";
    endpoint.password = "";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString();
  } catch {
    return undefined;
  }
};

const parseJson = async (response: Response): Promise<any> => {
  if (!response.ok) {
    const body = await readErrorBodyWithLimit(response, MAX_ERROR_RESPONSE_BYTES);
    throw new ProviderHTTPError(`Vertex request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  return readJsonWithLimit(response, {
    maxBytes: MAX_JSON_RESPONSE_BYTES,
    provider: "vertex",
    endpoint: diagnosticEndpoint(response)
  });
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

const sanitizeMediaResponse = (value: unknown, parentKey?: string): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMediaResponse(item, parentKey));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => {
        if (["videoBytes", "bytesBase64Encoded", "imageBytes", "audioContent"].includes(key)) {
          return false;
        }
        return key !== "data" || !(
          parentKey === "inlineData" ||
          parentKey === "inline_data" ||
          "mimeType" in record ||
          "mime_type" in record
        );
      })
      .map(([key, nested]) => [key, sanitizeMediaResponse(nested, key)])
  );
};

const decodeMedia = (data: string, endpoint: string) =>
  decodeBase64WithLimit(data, {
    maxBytes: MAX_MEDIA_RESPONSE_BYTES,
    provider: "vertex",
    endpoint
  });

const collectInlineMedia = (
  json: any,
  fallbackMediaType: string,
  endpoint: string
): { media: GeneratedMedia[]; text?: string } => {
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
          data: decodeMedia(inlineData.data, endpoint),
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

const collectVideos = (json: any, endpoint: string): GeneratedMedia[] => {
  const samples =
    json.response?.generateVideoResponse?.generatedSamples ??
    json.response?.generatedVideos ??
    json.response?.generated_videos ??
    [];

  return (Array.isArray(samples) ? samples : [])
    .map((sample: any) => sample.video ?? sample)
    .map((video: any): GeneratedMedia => ({
      data: video.videoBytes
        ? decodeMedia(video.videoBytes, endpoint)
        : video.bytesBase64Encoded
          ? decodeMedia(video.bytesBase64Encoded, endpoint)
          : undefined,
      uri: video.uri ?? video.gcsUri,
      mediaType: video.mimeType ?? "video/mp4",
      providerMetadata: sanitizeMediaResponse(video) as Record<string, unknown>
    }))
    .filter((video) => Boolean(video.data || video.uri));
};

const isImagenModel = (modelId: string) => modelId.startsWith("imagen-") || modelId.startsWith("imagegeneration@");
const isVeoModel = (modelId: string) => modelId.startsWith("veo-");

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
  done: json.done ?? (["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_PARTIALLY_SUCCEEDED"].includes(json.state ?? json.metadata?.state)),
  createTime: json.createTime ?? json.create_time ?? json.metadata?.createTime,
  updateTime: json.updateTime ?? json.update_time ?? json.metadata?.updateTime,
  rawResponse: json,
  providerMetadata: json
});

const definedNumber = (value: unknown) => (typeof value === "number" ? value : undefined);

const normalizeGenerateContentUsage = (usage: any): GenerateResult["usage"] => {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const normalized = {
    inputTokens: definedNumber(usage.promptTokenCount ?? usage.prompt_token_count),
    cachedInputTokens: definedNumber(usage.cachedContentTokenCount ?? usage.cached_content_token_count),
    outputTokens: definedNumber(usage.candidatesTokenCount ?? usage.candidates_token_count),
    reasoningTokens: definedNumber(usage.thoughtsTokenCount ?? usage.thoughts_token_count),
    totalTokens: definedNumber(usage.totalTokenCount ?? usage.total_token_count)
  };

  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
};

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

const awaitVertexToken = async (getAccessToken: Extract<VertexAuth, { type: "bearer" }>["getAccessToken"], signal?: AbortSignal | null) => {
  signal?.throwIfAborted();
  const token = Promise.resolve().then(getAccessToken);
  const accessToken = signal ? await new Promise<string | null | undefined>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    token.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  }) : await token;
  signal?.throwIfAborted();
  if (!accessToken) throw new ConfigurationError("Missing Vertex access token.");
  return accessToken;
};

const createVertexAuthenticatedFetch = (fetcher: typeof globalThis.fetch, auth: VertexAuth): typeof globalThis.fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    if (auth.type === "bearer") {
      const accessToken = await awaitVertexToken(auth.getAccessToken, signal);
      headers.set("authorization", `Bearer ${accessToken}`);
    }

    signal?.throwIfAborted();

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

const toVertexSchema = (schema: unknown): JsonValue => {
  if (Array.isArray(schema)) {
    return schema.map(toVertexSchema) as JsonValue;
  }

  if (!schema || typeof schema !== "object") {
    return schema as JsonValue;
  }

  const mapped: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key.startsWith("$") || key === "additionalProperties" || value === undefined) {
      continue;
    }
    mapped[key] = toVertexSchema(value);
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
            parameters: toVertexSchema(toJSONSchema(tool.schema))
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

          if (tool.type === "googleMaps") {
            const config =
              tool.config && typeof tool.config === "object" && !Array.isArray(tool.config)
                ? { ...(tool.config as Record<string, JsonValue>) }
                : {};
            if (config.enableWidget !== undefined && typeof config.enableWidget !== "boolean") {
              throw new ConfigurationError("Vertex Google Maps enableWidget must be boolean.");
            }
            delete config.latitude;
            delete config.longitude;
            mappedTools.push({ googleMaps: config });
            continue;
          }

          mappedTools.push({
            [tool.type]: tool.config && typeof tool.config === "object" ? tool.config : {}
          });
        }

        return mappedTools.length ? mappedTools : undefined;
      })()
    : undefined;

const mapGoogleMapsRetrievalConfig = (tools: ModelGenerateInput["tools"]) => {
  const mapsTool = Object.values(tools ?? {})
    .filter(isHostedToolDefinition)
    .find((tool) => tool.type === "googleMaps");
  if (!mapsTool || !mapsTool.config || typeof mapsTool.config !== "object" || Array.isArray(mapsTool.config)) {
    return undefined;
  }

  const config = mapsTool.config as Record<string, JsonValue>;
  const latitude = config.latitude;
  const longitude = config.longitude;
  if (latitude === undefined && longitude === undefined) {
    return undefined;
  }
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new ConfigurationError('Provider "vertex" Google Maps grounding requires finite latitude in [-90, 90] and longitude in [-180, 180].');
  }

  return {
    latLng: {
      latitude,
      longitude
    }
  };
};

const mapToolConfig = (toolChoice: ModelGenerateInput["toolChoice"], tools: ModelGenerateInput["tools"], messages: ModelMessage[]) => {
  const retrievalConfig = mapGoogleMapsRetrievalConfig(tools);
  // A forced initial call must not prevent answering after its result arrives.
  if (messages.at(-1)?.role === "tool" && toolChoice !== "none") return retrievalConfig ? { retrievalConfig } : undefined;
  if (!toolChoice || toolChoice === "auto") {
    return retrievalConfig ? { retrievalConfig } : undefined;
  }

  if (toolChoice === "none") {
    return {
      ...(retrievalConfig ? { retrievalConfig } : {}),
      functionCallingConfig: {
        mode: "NONE"
      }
    };
  }

  if (toolChoice === "required") {
    return {
      ...(retrievalConfig ? { retrievalConfig } : {}),
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
    ...(retrievalConfig ? { retrievalConfig } : {}),
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


const vertexRealtimeURL = (
  location: string,
  apiVersion: string,
  providerOptions?: Record<string, unknown>,
  override?: string
) => {
  const candidate = override ?? (typeof providerOptions?.realtime_url === "string" ? providerOptions.realtime_url : undefined);
  const host = vertexApiHost(location);
  return candidate || `wss://${host}/ws/google.cloud.aiplatform.${apiVersion}.LlmBidiService/BidiGenerateContent`;
};

const vertexRealtimeHeaders = (accessToken: string, providerOptions?: Record<string, unknown>) => ({
  ...(typeof providerOptions?.headers === "object" && providerOptions.headers && !Array.isArray(providerOptions.headers)
    ? Object.fromEntries(
        Object.entries(providerOptions.headers as Record<string, unknown>)
          .filter(([key]) => !["authorization", "content-length", "host", "connection", "transfer-encoding"].includes(key.toLowerCase()))
          .map(([key, value]) => [key, String(value)])
      )
    : {}),
  authorization: `Bearer ${accessToken}`
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
    ...(config.translation?.targetLanguage ? { targetLanguageCode: config.translation.targetLanguage } : {})
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

  if (config.translation.sourceLanguage !== undefined) {
    throw new UnsupportedFeatureError("Vertex Live Translate detects the source language automatically; translation.sourceLanguage is not supported.");
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

const liveTranscriptionConfig = (config: RealtimeSessionConfig) => {
  if (config.inputAudioTranscription === false) throw new UnsupportedFeatureError("Live Transcribe cannot disable input transcription.");
  const value = normalizeVertexTranscriptionConfig(config.inputAudioTranscription === true ? {} : config.inputAudioTranscription, config.inputTranscription?.language);
  if (value.wordTimestamp || value.diarization) throw new UnsupportedFeatureError("Live Transcribe does not support word timestamps or diarization.");
  return value;
};

const assertVertexRealtimeConfig = (config: RealtimeSessionConfig, modelId: string) => {
  assertVertexRealtimeTranslateConfig(config, modelId);
  if (isVertexLiveTranscribeModel(modelId)) {
    if (config.mode !== undefined && config.mode !== "transcription") throw new UnsupportedFeatureError("Live Transcribe requires transcription mode.");
    for (const key of ["instructions", "voice", "reasoning", "translation", "mediaResolution", "affectiveDialog", "proactiveAudio", "outputAudioMediaType", "outputSampleRateHz", "turnDetection", "noiseReduction", "autoResponse"] as const) {
      if (config[key] !== undefined) throw new UnsupportedFeatureError(`Live Transcribe does not support ${key}.`);
    }
    if (config.outputAudioTranscription) throw new UnsupportedFeatureError("Live Transcribe does not produce output audio transcription.");
    if (Object.keys(toToolSet(config.tools) ?? {}).length) throw new UnsupportedFeatureError("Live Transcribe does not support tools.");
    if (config.toolChoice !== undefined && config.toolChoice !== "none") throw new UnsupportedFeatureError("Live Transcribe does not support tool selection.");
    if (config.inputTranscription && Object.keys(config.inputTranscription).some(key => key !== "language")) throw new UnsupportedFeatureError("Live Transcribe inputTranscription accepts only language; use inputAudioTranscription for native options.");
    for (const key of ["model", "generationConfig", "generation_config", "inputAudioTranscription", "input_audio_transcription", "systemInstruction", "system_instruction", "tools", "translationConfig", "outputAudioTranscription"]) {
      if (config.providerOptions?.[key] !== undefined) throw new ConfigurationError(`Live Transcribe does not accept providerOptions.${key}.`);
    }
    liveTranscriptionConfig(config);
  }
  if (config.toolChoice !== undefined && !["auto", "none"].includes(String(config.toolChoice))) {
    throw new UnsupportedFeatureError(
      "Vertex Live supports automatic tool selection or tool disabling, but not required or named tool choice."
    );
  }
};

const vertexRealtimeSetup = (config: RealtimeSessionConfig, modelResource: string) => isVertexLiveTranscribeModel(modelResource.split("/").at(-1)!) ? {
  setup: {
    ...mapRealtimeProviderOptions(config.providerOptions),
    model: modelResource,
    generationConfig: { responseModalities: ["TEXT"] },
    inputAudioTranscription: liveTranscriptionConfig(config)
  }
} : ({
  setup: {
    model: modelResource,
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
      responseModalities: isGeminiLiveTranslateModel(modelResource.split("/").at(-1)!) && config.outputAudioTranscription
        ? ["AUDIO", "TEXT"] : ["AUDIO"],
      ...(mapRealtimeTranslationConfig(config) ? { translationConfig: mapRealtimeTranslationConfig(config) } : {}),
      ...(mapRealtimeThinkingConfig(config) ? { thinkingConfig: mapRealtimeThinkingConfig(config) } : {})
    },
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
    ...(config.toolChoice !== "none" && mapTools(toToolSet(config.tools))
      ? { tools: mapTools(toToolSet(config.tools)) }
      : {}),
    ...mapRealtimeProviderOptions(config.providerOptions as Record<string, unknown> | undefined)
  }
});

const vertexRealtimeTimeLeftMs = (goAway: Record<string, unknown>): number | undefined => {
  const milliseconds = goAway.timeLeftMs ?? goAway.time_left_ms;
  if (typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  const duration = goAway.timeLeft ?? goAway.time_left;
  if (typeof duration !== "string" || !/^\d+(?:\.\d{1,9})?s$/.test(duration)) return undefined;
  const value = Number(duration.slice(0, -1)) * 1000;
  return Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
};

const parseVertexRealtimeEvent = (payload: Record<string, unknown>, transcriptionOnly = false) => {
  if ("setupComplete" in payload) {
    return [];
  }
  const providerMetadata = sanitizeMediaResponse(payload) as Record<string, JsonValue>;

  const cancellation = payload.toolCallCancellation ?? payload.tool_call_cancellation;
  if (cancellation !== undefined) {
    const ids = cancellation && typeof cancellation === "object" ? (cancellation as Record<string, unknown>).ids : undefined;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id)) {
      throw new ConfigurationError("Vertex Live returned invalid tool cancellation IDs.");
    }
    return [{ type: "realtime-tool-call-cancellation" as const, toolCallIds: [...new Set(ids as string[])] }];
  }

  const liveToolCall = payload.toolCall ?? payload.tool_call;
  if (liveToolCall && typeof liveToolCall === "object") {
    const calls = (liveToolCall as Record<string, unknown>).functionCalls ?? (liveToolCall as Record<string, unknown>).function_calls;
    if (!Array.isArray(calls)) throw new ConfigurationError("Vertex Live returned an invalid function calls array.");
    const ids = new Set<string>();
    return calls.map((call): RealtimeEvent => {
      if (!call || typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name
        || ids.has(call.id) || (call.args !== undefined && (!call.args || typeof call.args !== "object" || Array.isArray(call.args)))) {
        throw new ConfigurationError("Vertex Live returned an invalid or duplicate function call.");
      }
      ids.add(call.id);
      return { type: "realtime-tool-call", toolCall: { id: call.id, name: call.name, input: (call.args ?? {}) as JsonValue } };
    });
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
          providerMetadata
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
          audio: decodeMedia(inline.data, "realtime"),
          mediaType: typeof inline.mimeType === "string" ? inline.mimeType : typeof inline.mime_type === "string" ? inline.mime_type : "audio/pcm",
          providerMetadata
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

    const interim = serverContent.interimInputTranscription ?? serverContent.interim_input_transcription;
    if (transcriptionOnly && interim && typeof interim === "object") {
      // Interim hypotheses can replace earlier words; they are not text deltas.
      events.push({ type: "realtime-provider-data" as const, provider: "vertex", data: { type: "vertex_transcription_interim", transcription: sanitizeMediaResponse(interim) as JsonValue } });
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
        isFinal: transcriptionOnly || Boolean(inputTranscription.finished ?? serverContent.turnComplete ?? serverContent.turn_complete),
        providerMetadata
      });
    }

    const outputTranscription =
      typeof serverContent.outputTranscription === "object" && serverContent.outputTranscription
        ? (serverContent.outputTranscription as Record<string, unknown>)
        : typeof serverContent.output_transcription === "object" && serverContent.output_transcription
          ? (serverContent.output_transcription as Record<string, unknown>)
          : undefined;
    if (outputTranscription && typeof outputTranscription.text === "string") {
      events.push({
        type: "realtime-transcript" as const,
        text: outputTranscription.text,
        role: "assistant" as const,
        isFinal: Boolean(outputTranscription.finished ?? serverContent.turnComplete ?? serverContent.turn_complete),
        providerMetadata
      });
    }

    if (serverContent.interrupted === true) {
      events.push({
        type: "realtime-response-complete" as const,
        reason: "interrupted",
        providerMetadata
      });
    }
    if (serverContent.generationComplete || serverContent.generation_complete) {
      events.push({
        type: "realtime-response-complete" as const,
        reason: "generation-complete",
        providerMetadata
      });
    }
    if (serverContent.turnComplete || serverContent.turn_complete) {
      events.push({
        type: "realtime-response-complete" as const,
        reason: "turn-complete",
        providerMetadata
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
        providerMetadata
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
        timeLeftMs: vertexRealtimeTimeLeftMs(goAway),
        providerMetadata
      }
    ];
  }

  if (payload.error && typeof payload.error === "object") {
    return [
      {
        type: "realtime-end" as const,
        reason: "error",
        providerMetadata
      }
    ];
  }

  return [];
};

const createVertexRealtimeEventParser = (transcriptionOnly = false) => {
  let outputTranscript = "";

  return (payload: Record<string, unknown>): RealtimeEvent[] => {
    const events: RealtimeEvent[] = [];
    for (const event of parseVertexRealtimeEvent(payload, transcriptionOnly)) {
      if (event.type === "realtime-response-complete" && event.reason === "interrupted") {
        outputTranscript = "";
      }
      if (event.type === "realtime-transcript" && event.role === "assistant") {
        if (event.isFinal) {
          const completeText = event.text.startsWith(outputTranscript)
            ? event.text
            : `${outputTranscript}${event.text}`;
          outputTranscript = "";
          events.push({ ...event, text: completeText });
        } else {
          outputTranscript += event.text;
          events.push(event);
        }
        continue;
      }
      if (
        event.type === "realtime-response-complete" &&
        event.reason === "turn-complete" &&
        outputTranscript
      ) {
        events.push({
          type: "realtime-transcript",
          text: outputTranscript,
          role: "assistant",
          isFinal: true,
          providerMetadata: event.providerMetadata
        });
        outputTranscript = "";
      }
      events.push(event);
    }
    return events;
  };
};

const isGemini3Model = (modelId: string) => /^gemini-3([.-]|$)/.test(modelId);

const isGemini3ProModel = (modelId: string) => /^gemini-3([.-].*)?pro([.-]|$)/.test(modelId);

const usesCurrentGeminiRequestRules = (modelId: string) =>
  modelId === "gemini-3.8-flash" ||
  modelId === "gemini-3.7-flash" ||
  modelId === "gemini-3.6-flash" ||
  modelId === "gemini-3.5-flash-lite";

const currentGeminiReasoningEfforts: NonNullable<ModelCapabilities["reasoningEfforts"]> = [
  "minimal",
  "low",
  "medium",
  "high"
];

const reasoningEffortsForModel = (modelId: string) =>
  (modelId === "gemini-3.8-flash" || modelId === "gemini-3.7-flash")
    ? (["low", "medium", "high"] satisfies NonNullable<ModelCapabilities["reasoningEfforts"]>)
    : currentGeminiReasoningEfforts;

const modelCapabilities = (
  modelId: string,
  baseCapabilities: ModelCapabilities = capabilities
): ModelCapabilities =>
  usesCurrentGeminiRequestRules(modelId)
    ? {
        ...baseCapabilities,
        computerUse: modelId === "gemini-3.8-flash",
        reasoningEfforts: [...reasoningEffortsForModel(modelId)],
        agentCapabilities: baseCapabilities.agentCapabilities
          ? {
              ...baseCapabilities.agentCapabilities,
              computerUse: modelId === "gemini-3.8-flash"
            }
          : undefined
      }
    : baseCapabilities;

const currentGeminiGenerationControlKeys = [
  "temperature",
  "topP",
  "top_p",
  "topK",
  "top_k",
  "candidateCount",
  "candidate_count",
  "frequencyPenalty",
  "frequency_penalty",
  "presencePenalty",
  "presence_penalty"
] as const;

const firstUnsupportedGenerationControl = (...sources: unknown[]) => {
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    for (const key of currentGeminiGenerationControlKeys) {
      if ((source as Record<string, unknown>)[key] !== undefined) {
        return key;
      }
    }
  }
  return undefined;
};

const hasAssistantPrefill = (messages: ModelMessage[]) =>
  messages
    .slice()
    .reverse()
    .find((message) => message.role !== "system" && message.parts.length > 0)?.role === "assistant";

const assertCurrentGeminiGenerateInput = (
  provider: "gemini" | "vertex",
  modelId: string,
  input: ModelGenerateInput
) => {
  if (!usesCurrentGeminiRequestRules(modelId)) {
    return;
  }

  if (input.reasoning?.effort !== undefined && !reasoningEffortsForModel(modelId).includes(input.reasoning.effort)) {
    throw new UnsupportedFeatureError(`Provider "${provider}" does not support reasoning effort "${input.reasoning.effort}" for model "${modelId}".`);
  }
  const providerOptions = input.providerOptions as Record<string, unknown> | undefined;
  const rawConfig = providerOptions?.generationConfig ?? providerOptions?.generation_config;
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig as Record<string, unknown> : {};
  const rawThinking = config.thinkingConfig ?? config.thinking_config ?? providerOptions?.thinkingConfig ?? providerOptions?.thinking_config;
  if (rawThinking && typeof rawThinking === "object") {
    const thinking = rawThinking as Record<string, unknown>;
    const effort = thinking.thinkingLevel ?? thinking.thinking_level;
    if (effort !== undefined && !reasoningEffortsForModel(modelId).some((supported) => supported === String(effort).toLowerCase())) {
      throw new UnsupportedFeatureError(`Provider "${provider}" does not support thinking level "${effort}" for model "${modelId}".`);
    }
    if (thinking.thinkingBudget !== undefined || thinking.thinking_budget !== undefined) {
      throw new UnsupportedFeatureError(`Provider "${provider}" requires thinking levels instead of budgets for model "${modelId}".`);
    }
  }
  const unsupportedControl = firstUnsupportedGenerationControl(
    input.temperature === undefined ? undefined : { temperature: input.temperature },
    providerOptions,
    providerOptions?.generationConfig,
    providerOptions?.generation_config
  );
  if (unsupportedControl) {
    throw new UnsupportedFeatureError(
      `Provider "${provider}" does not support generation control "${unsupportedControl}" for model "${modelId}". ` +
        "Remove temperature, topP/top_p, topK/top_k, candidateCount/candidate_count, and frequency/presence penalties; " +
        "these models use provider-managed sampling."
    );
  }

  if (hasAssistantPrefill(input.messages)) {
    throw new UnsupportedFeatureError(
      `Provider "${provider}" does not support assistant prefill for model "${modelId}".`
    );
  }
};

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

    if (input.reasoning.effort === "minimal" && ["gemini-3.8-flash", "gemini-3.7-flash"].includes(modelId)) {
      throw new UnsupportedFeatureError(
        'Provider "vertex" does not support "reasoning.effort=minimal" for Gemini 3.7 Flash.'
      );
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
        responseSchema: toVertexSchema(toJSONSchema(input.structuredOutput.schema))
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

class VertexContextCachesClient implements ContextCachesClient {
  constructor(
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly assertModelLocation: (modelId: string) => void
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
    const modelId = input.modelId.replace(/^publishers\/google\/models\//, "");
    this.assertModelLocation(modelId);
    if (input.ttl !== undefined && input.expireTime !== undefined) {
      throw new ConfigurationError("Vertex context caches accept either ttl or expireTime, not both.");
    }
    for (const key of ["model", "contents", "systemInstruction", "system_instruction", "tools", "displayName", "display_name", "ttl", "expireTime", "expire_time"]) {
      if (input.providerOptions?.[key] !== undefined) {
        throw new ConfigurationError(`Vertex context cache providerOptions.${key} conflicts with a dedicated input field.`);
      }
    }
    const nativeOptions = { ...input.providerOptions };
    if (nativeOptions.kmsKeyName !== undefined) {
      if (nativeOptions.encryptionSpec !== undefined || nativeOptions.encryption_spec !== undefined) {
        throw new ConfigurationError("Vertex cache kmsKeyName conflicts with encryptionSpec.");
      }
      if (typeof nativeOptions.kmsKeyName !== "string" || !/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(nativeOptions.kmsKeyName)) {
        throw new ConfigurationError("Vertex cache kmsKeyName must identify a Cloud KMS crypto key.");
      }
      nativeOptions.encryptionSpec = { kmsKeyName: nativeOptions.kmsKeyName };
      delete nativeOptions.kmsKeyName;
    }
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/cachedContents`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              model: modelId.startsWith("projects/")
                ? modelId
                : `${this.resourceBase()}/publishers/google/models/${modelId}`,
              contents: mapMessages(input.contents),
              ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : { systemInstruction: systemInstruction(input.contents) }),
              ...(input.tools ? { tools: mapTools(toToolSet(input.tools)) } : {}),
              ...(input.displayName ? { displayName: input.displayName } : {}),
              ...(input.ttl ? { ttl: input.ttl } : {}),
              ...(input.expireTime ? { expireTime: input.expireTime } : {}),
              ...nativeOptions
            })
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );
      return normalizeCachedContent(json);
    } finally {
      cleanup();
    }
  }

  async get(input: ContextCacheGetInput): Promise<CachedContent> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await withRetry(() => this.fetcher(vertexResourceURL(this.baseURL, input.name), { method: "GET", headers: this.headers(), signal }).then(parseJson), { ...input, abortSignal: signal });
      return normalizeCachedContent(json);
    } finally {
      cleanup();
    }
  }

  async update(input: ContextCacheUpdateInput): Promise<CachedContent> {
    if ((input.ttl !== undefined) === (input.expireTime !== undefined)) {
      throw new ConfigurationError("Vertex cache update requires exactly one of ttl or expireTime.");
    }
    if (input.ttl !== undefined && (!/^\d+(?:\.\d{1,9})?s$/.test(input.ttl) || Number(input.ttl.slice(0, -1)) <= 0)) {
      throw new ConfigurationError("Vertex cache ttl must be a positive duration in seconds, such as 3600s.");
    }
    if (input.expireTime !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.expireTime) || !Number.isFinite(Date.parse(input.expireTime)))) {
      throw new ConfigurationError("Vertex cache expireTime must be an RFC 3339 timestamp.");
    }
    const field = input.ttl !== undefined ? "ttl" : "expireTime";
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await withRetry(() => this.fetcher(
        appendQuery(vertexResourceURL(this.baseURL, input.name), { updateMask: field }),
        { method: "PATCH", headers: this.headers(), redirect: "error", signal, body: JSON.stringify({ [field]: input[field] }) }
      ).then(parseJson), { ...input, abortSignal: signal });
      return normalizeCachedContent(json);
    } finally {
      cleanup();
    }
  }

  async list(input: ContextCacheListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await withRetry(
        () =>
          this.fetcher(appendQuery(`${this.baseURL}/cachedContents`, { pageSize: input.pageSize, pageToken: input.pageToken }), {
            method: "GET",
            headers: this.headers(),
            signal
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );
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
      const json = await withRetry(async () => {
        const response = await this.fetcher(vertexResourceURL(this.baseURL, input.name), { method: "DELETE", headers: this.headers(), signal });
        return response.status === 204 ? {} : await parseJson(response);
      }, { ...input, abortSignal: signal });
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class VertexBatchesClient implements BatchesClient {
  constructor(
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly assertAccess: () => void
  ) {}

  private async request(path: string, method: string, input: BatchGetInput | BatchListInput | BatchCreateInput, body?: unknown) {
    this.assertAccess();
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(async () => {
        const result = await this.fetcher(path, {
          method, headers: { "content-type": "application/json" }, redirect: "error", signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        if (!result.ok) await parseJson(result);
        return result;
      }, { ...input, abortSignal: signal });
      // Cancel returns Empty; delete returns a long-running operation.
      if (response.status === 204) return {};
      return await parseJson(response);
    } finally { cleanup(); }
  }

  async create(input: BatchCreateInput): Promise<BatchJob> {
    this.assertAccess();
    if (input.requests) throw new UnsupportedFeatureError("Vertex batch jobs require Cloud Storage or BigQuery input; upload inline requests first.");
    const options = input.providerOptions ?? {};
    if (input.fileName !== undefined && options.inputConfig !== undefined) {
      throw new ConfigurationError("Vertex batch input requires either fileName or providerOptions.inputConfig, not both.");
    }
    if (input.fileName?.startsWith("bq://") && !/^bq:\/\/[^.\s/]+\.[^.\s/]+\.[^.\s/]+$/.test(input.fileName)) {
      throw new ConfigurationError("Vertex batch BigQuery input must use bq://project.dataset.table.");
    }
    if (input.fileName && !input.fileName.startsWith("gs://") && !input.fileName.startsWith("bq://")) {
      throw new ConfigurationError("Vertex batch fileName must be a gs:// or bq:// URI, not a Gemini Files API ID.");
    }
    const inputConfig = options.inputConfig ?? (input.fileName?.startsWith("gs://")
      ? { instancesFormat: "jsonl", gcsSource: { uris: [input.fileName] } }
      : input.fileName ? { instancesFormat: "bigquery", bigquerySource: { inputUri: input.fileName } } : undefined);
    if (!inputConfig || !options.outputConfig) throw new ConfigurationError("Vertex batch jobs require inputConfig (or fileName) and providerOptions.outputConfig.");
    const model = input.modelId.startsWith("projects/")
      ? (encodeVertexResourceName(input.modelId, "Vertex batch model"), input.modelId)
      : input.modelId.startsWith("claude-") ? `publishers/anthropic/models/${encodeVertexPathSegment(input.modelId, "Vertex Claude model")}`
        : vertexPublisherResource(input.modelId);
    const publisher = model.match(/(?:^|\/)publishers\/([^/]+)\/models\//)?.[1];
    if (publisher && publisher !== "google" && /\/locations\/global\/?$/.test(new URL(this.baseURL).pathname)) {
      throw new ConfigurationError("Vertex partner batch jobs require a supported regional endpoint; global is not supported. Configure location for the selected model.");
    }
    const json = await this.request(`${this.baseURL}/batchPredictionJobs`, "POST", input, {
      ...options, displayName: input.displayName ?? "zhivex-batch", model, inputConfig
    });
    return normalizeBatchJob(json);
  }

  async get(input: BatchGetInput): Promise<BatchJob> {
    return normalizeBatchJob(await this.request(vertexResourceURL(this.baseURL, input.name), "GET", input));
  }

  async list(input: BatchListInput = {}) {
    const json = await this.request(appendQuery(`${this.baseURL}/batchPredictionJobs`, {
      pageSize: input.pageSize, pageToken: input.pageToken,
      filter: typeof input.providerOptions?.filter === "string" ? input.providerOptions.filter : undefined
    }), "GET", input);
    return { batches: (json.batchPredictionJobs ?? []).map(normalizeBatchJob), nextPageToken: json.nextPageToken, rawResponse: json };
  }

  async cancel(input: BatchCancelInput): Promise<BatchJob> {
    await this.request(`${vertexResourceURL(this.baseURL, input.name)}:cancel`, "POST", input, {});
    // Cancellation is asynchronous; report the actual job state.
    return this.get(input);
  }

  async delete(input: BatchDeleteInput) {
    const json = await this.request(vertexResourceURL(this.baseURL, input.name), "DELETE", input);
    return { name: input.name, rawResponse: json };
  }
}

const vertexPublisherResource = (modelId: string): string => {
  if (/^(?:projects\/[^/]+\/locations\/[^/]+\/)?endpoints\/[^/]+$/.test(modelId)) {
    return encodeVertexResourceName(modelId, "Vertex endpoint");
  }
  if (modelId.startsWith("endpoints/") || modelId.startsWith("projects/")) {
    throw new ConfigurationError("Vertex prediction endpoint must use endpoints/<id> or projects/<project>/locations/<location>/endpoints/<id>.");
  }
  if (modelId.startsWith("publishers/")) {
    const segments = modelId.split("/");
    if (segments.length !== 4 || segments[2] !== "models") {
      throw new ConfigurationError("Vertex publisher model must use publishers/<publisher>/models/<modelId>.");
    }
    return `publishers/${encodeVertexPathSegment(segments[1], "Vertex publisher")}/models/${encodeVertexPathSegment(segments[3], "Vertex model ID")}`;
  }
  if (/^[^/]+\/[^/]+$/.test(modelId)) {
    const [publisher, model] = modelId.split("/");
    return `publishers/${encodeVertexPathSegment(publisher, "Vertex publisher")}/models/${encodeVertexPathSegment(model, "Vertex model ID")}`;
  }
  return `publishers/google/models/${encodeVertexPathSegment(modelId, "Vertex model ID")}`;
};

class VertexPredictionModel implements PredictionModel {
  readonly provider = "vertex";
  readonly capabilities: ModelCapabilities = {
    streaming: false, tools: false, structuredOutput: false, jsonMode: false,
    toolChoice: false, parallelToolCalls: false, vision: false, files: false,
    audioInput: false, audioOutput: false, embeddings: false, reasoning: false,
    webSearch: false, rawPrediction: true
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
    const resource = vertexPublisherResource(this.modelId);
    const base = this.modelId.startsWith("projects/") ? this.baseURL.replace(/\/projects\/.*$/, "") : this.baseURL;
    return `${base}/${resource}:${encodeVertexPathSegment(action, "Vertex prediction action")}`;
  }

  private body(input: PredictionModelInput) {
    if (input.body !== undefined) return input.body;
    const nativeOptions = { ...input.providerOptions };
    delete nativeOptions.action;
    for (const key of ["instances", "parameters"] as const) {
      if (input[key] !== undefined && nativeOptions[key] !== undefined) {
        throw new ConfigurationError(`Vertex prediction providerOptions.${key} conflicts with a dedicated input field.`);
      }
    }
    return {
      ...(input.instances ? { instances: input.instances } : {}),
      ...(input.parameters ? { parameters: input.parameters } : {}),
      ...nativeOptions
    };
  }

  async predictRaw(input: PredictionModelInput): Promise<PredictionResult> {
    const action = typeof input.providerOptions?.action === "string" ? input.providerOptions.action : "predict";
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await withRetry(
        () =>
          this.fetcher(this.url(action), {
            method: "POST",
            redirect: "error",
            headers: this.headers(),
            signal,
            body: JSON.stringify(this.body(input))
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );
      return normalizePredictionResult(json);
    } finally {
      cleanup();
    }
  }

  async rawPredict(input: PredictionModelInput): Promise<PredictionResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await withRetry(
        () =>
          this.fetcher(this.url("rawPredict"), {
            method: "POST",
            redirect: "error",
            headers: this.headers(),
            signal,
            body: JSON.stringify(this.body(input))
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );
      return normalizePredictionResult(json);
    } finally {
      cleanup();
    }
  }

  async invoke(input: PredictionModelInput): Promise<PredictionResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await withRetry(
        () =>
          this.fetcher(this.url("invoke"), {
            method: "POST",
            redirect: "error",
            headers: this.headers(),
            signal,
            body: JSON.stringify(this.body(input))
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );
      return normalizePredictionResult(json);
    } finally {
      cleanup();
    }
  }

  async predictLongRunning(input: PredictionModelInput): Promise<PredictionOperation> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await withRetry(
        () =>
          this.fetcher(this.url("predictLongRunning"), {
            method: "POST",
            redirect: "error",
            headers: this.headers(),
            signal,
            body: JSON.stringify(this.body(input))
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );
      return normalizeOperation(json);
    } finally {
      cleanup();
    }
  }

  async fetchPredictionOperation(input: PredictionOperationInput): Promise<PredictionOperation> {
    if (input.providerOptions?.operationName !== undefined || input.providerOptions?.operation_name !== undefined) {
      throw new ConfigurationError("Vertex prediction operationName must be supplied through name.");
    }
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const json = await withRetry(
        () =>
          this.fetcher(this.url("fetchPredictOperation"), {
            method: "POST",
            redirect: "error",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              operationName: input.name,
              ...(input.providerOptions ?? {})
            })
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );
      return normalizeOperation(json);
    } finally {
      cleanup();
    }
  }
}

class VertexLanguageModel implements LanguageModel<VertexLanguageModelOptions> {
  readonly provider = "vertex";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {
    this.capabilities = modelCapabilities(modelId);
  }

  private url(action: string) {
    return `${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:${action}`;
  }

  private headers() {
    return {
      "content-type": "application/json"
    };
  }

  async generate(input: ModelGenerateInput<VertexLanguageModelOptions>): Promise<GenerateResult> {
    assertCurrentGeminiGenerateInput("vertex", this.modelId, input);
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const json = await withRetry(
        () =>
          this.fetcher(this.url("generateContent"), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              contents: mapMessages(input.messages),
              systemInstruction: systemInstruction(input.messages),
              tools: mapTools(input.tools),
              toolConfig: mapToolConfig(input.toolChoice, input.tools, input.messages),
              generationConfig: generationConfig(this.modelId, input)
            })
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );

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
        usage: normalizeGenerateContentUsage(json.usageMetadata ?? json.usage_metadata),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput<VertexLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    assertCurrentGeminiGenerateInput("vertex", this.modelId, input);
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(this.url("streamGenerateContent?alt=sse"), {
          method: "POST",
          headers: this.headers(),
          signal,
          body: JSON.stringify({
            ...input.providerOptions,
            contents: mapMessages(input.messages),
            systemInstruction: systemInstruction(input.messages),
            tools: mapTools(input.tools),
            toolConfig: mapToolConfig(input.toolChoice, input.tools, input.messages),
            generationConfig: generationConfig(this.modelId, input)
          })
        }).then(async (response) => {
          if (!response.ok) await parseJson(response);
          return response;
        }),
      { ...input, abortSignal: signal }
    ).catch((error) => {
      cleanup();
      throw error;
    });

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
              providerFinishReason: candidate.finishReason,
              usage: normalizeGenerateContentUsage(json.usageMetadata ?? json.usage_metadata)
            } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
  }
}

class VertexTranscriptionModel implements VertexTranscriptionModelContract {
  readonly provider = "vertex";
  readonly capabilities = transcriptionCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url() {
    return `${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:generateContent`;
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
  }): Promise<VertexTranscriptionResult> {
    const body = transcriptionRequest(this.modelId, input, toBase64(input.audio.data));
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const json = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify(body)
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );
      return transcriptionResponse(json);
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

  private url(method = "generateContent") {
    return `${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:${method}`;
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
      const json = await withRetry(
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
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );
      const audioPart = json.candidates?.[0]?.content?.parts?.find((part: any) => part.inlineData?.data);
      return {
        audio: decodeMedia(audioPart?.inlineData?.data ?? "", "models.generateContent"),
        mediaType: audioPart?.inlineData?.mimeType ?? "audio/wav",
        rawResponse: sanitizeMediaResponse(json)
      };
    } finally {
      cleanup();
    }
  }

  async streamSpeech(input: {
    input: string;
    voice?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<AsyncIterable<SpeechResult>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(`${this.url("streamGenerateContent")}?alt=sse`, {
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
        }).then(async response => {
          if (!response.ok) await parseJson(response);
          return response;
        }),
      { ...input, abortSignal: signal }
    ).catch(error => { cleanup(); throw error; });

    return (async function* () {
      try {
        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            continue;
          }
          const json = JSON.parse(event.data);
          const parts = json.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (typeof part.inlineData?.data !== "string") {
              continue;
            }
            yield {
              audio: decodeMedia(part.inlineData.data, "models.streamGenerateContent"),
              mediaType: part.inlineData.mimeType ?? "audio/pcm",
              rawResponse: sanitizeMediaResponse(json)
            } satisfies SpeechResult;
          }
        }
      } finally {
        cleanup();
      }
    })();
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
        if (input.images?.length) throw new UnsupportedFeatureError("Imagen text-to-image generation does not accept images; use the native editing referenceImages contract through predictionModel().");
        const outputOptions = input.providerOptions?.outputOptions;
        if (input.outputMimeType !== undefined && outputOptions !== undefined &&
          (!outputOptions || typeof outputOptions !== "object" || Array.isArray(outputOptions))) {
          throw new ConfigurationError("Imagen providerOptions.outputOptions must be an object.");
        }
        const nativeOutputOptions = outputOptions as Record<string, unknown> | undefined;
        if (input.outputMimeType !== undefined && nativeOutputOptions?.mimeType !== undefined &&
          nativeOutputOptions.mimeType !== input.outputMimeType) throw new ConfigurationError("Conflicting Imagen output MIME types.");
        const json = await withRetry(
          () =>
            this.fetcher(`${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:predict`, {
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
                  ...input.providerOptions,
                  ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
                  ...(input.count ? { sampleCount: input.count } : {}),
                  ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
                  ...(input.size ? { sampleImageSize: input.size } : {}),
                  ...(input.outputMimeType ? { outputOptions: { ...nativeOutputOptions, mimeType: input.outputMimeType } } : {})
                }
              })
            }).then(parseJson),
          { ...input, abortSignal: signal }
        );

        const images = (Array.isArray(json.predictions) ? json.predictions : [])
          .map((prediction: any) => ({
            data:
              prediction.bytesBase64Encoded || prediction.imageBytes
                ? decodeMedia(prediction.bytesBase64Encoded ?? prediction.imageBytes, "models.predict")
                : undefined,
            uri: prediction.gcsUri ?? prediction.uri,
            mediaType: prediction.mimeType ?? input.outputMimeType ?? "image/png",
            text: prediction.prompt ?? prediction.text,
            providerMetadata: sanitizeMediaResponse(prediction)
          }))
          .filter((image: GeneratedMedia) => image.data || image.uri);

        return {
          images,
          rawResponse: sanitizeMediaResponse(json)
        };
      }

      const { generationConfig, providerOptions } = splitGenerationConfig(input.providerOptions);
      const json = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:generateContent`, {
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
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );

      const { media, text } = collectInlineMedia(json, input.outputMimeType ?? "image/png", "models.generateContent");
      return {
        images: media,
        text,
        rawResponse: sanitizeMediaResponse(json)
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
    private readonly fetcher: typeof globalThis.fetch,
    private readonly interactions?: VertexInteractionsClient
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
    if (this.modelId.startsWith("lyria-3-")) {
      if (!this.interactions) throw new ConfigurationError("Lyria 3 requires Vertex Interactions.");
      if (input.negativePrompt || input.outputMimeType) throw new UnsupportedFeatureError("Vertex Lyria 3 does not expose negativePrompt or outputMimeType; describe the desired music in prompt.");
      const content: Array<Record<string, unknown>> = [{ type: "text", text: input.prompt }];
      for (const image of input.images ?? []) {
        if (!image.mediaType.startsWith("image/") || (image.data === undefined) === (image.uri === undefined)) throw new ConfigurationError("Lyria 3 image input requires exactly one data or uri and an image media type.");
        const part = mediaInputToPart(image);
        content.push({ type: "image", mime_type: image.mediaType,
          ...(part.inlineData ? { data: part.inlineData.data } : { uri: image.uri }) });
      }
      const result = await this.interactions.create({ ...input, modelId: this.modelId, input: content, background: false });
      const audio = (result.outputs ?? []).filter((output): output is Record<string, unknown> => !!output && typeof output === "object" && "type" in output && output.type === "audio").map((output) => {
        if (typeof output.data !== "string") throw new ConfigurationError("Lyria 3 returned audio without inline data; use interactions for asynchronous output.");
        return { data: decodeMedia(output.data, "interactions"), mediaType: typeof output.mime_type === "string" ? output.mime_type : "audio/mpeg" };
      });
      if (result.status !== "completed" || !audio.length) throw new ConfigurationError("Lyria 3 did not return completed audio; use interactions to inspect the operation.");
      return { audio, text: result.outputText, rawResponse: sanitizeMediaResponse(result.rawResponse) };
    }
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      if (this.modelId === "lyria-002") {
        const json = await withRetry(
          () =>
            this.fetcher(`${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:predict`, {
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
            }).then(parseJson),
          { ...input, abortSignal: signal }
        );

        return {
          audio: (Array.isArray(json.predictions) ? json.predictions : []).map((prediction: any) => ({
            data: decodeMedia(prediction.audioContent ?? "", "models.predict"),
            mediaType: prediction.mimeType ?? "audio/wav",
            providerMetadata: sanitizeMediaResponse(prediction)
          })),
          rawResponse: sanitizeMediaResponse(json)
        };
      }

      const { generationConfig, providerOptions } = splitGenerationConfig(input.providerOptions);
      const json = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:generateContent`, {
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
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );

      const { media, text } = collectInlineMedia(json, input.outputMimeType ?? "audio/mpeg", "models.generateContent");
      return {
        audio: media,
        text,
        rawResponse: sanitizeMediaResponse(json)
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
    private readonly fetcher: typeof globalThis.fetch,
    private readonly interactions?: VertexInteractionsClient
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
    if (this.modelId.startsWith("gemini-omni-")) {
      if (!this.interactions) throw new ConfigurationError("Gemini Omni video requires Vertex Interactions.");
      if (input.count !== undefined && input.count !== 1) throw new UnsupportedFeatureError("Gemini Omni generates one video per interaction.");
      if (input.pollIntervalMs !== undefined) throw new UnsupportedFeatureError("Gemini Omni synchronous generation does not poll; use interactions for asynchronous workflows.");
      if (input.negativePrompt !== undefined) throw new UnsupportedFeatureError("Gemini Omni does not expose negativePrompt; describe the desired video in prompt.");
      if (input.durationSeconds !== undefined && (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 3 || input.durationSeconds > 10)) throw new ConfigurationError("Gemini Omni durationSeconds must be an integer from 3 to 10.");
      if (input.aspectRatio !== undefined && !["16:9", "9:16"].includes(input.aspectRatio)) throw new ConfigurationError("Gemini Omni aspectRatio must be 16:9 or 9:16.");
      if (input.outputStorageUri !== undefined && !/^gs:\/\/[^/\s]+\/[^\s]*$/.test(input.outputStorageUri)) throw new ConfigurationError("Gemini Omni outputStorageUri must be a gs:// bucket path.");
      const options = input.providerOptions ?? {};
      for (const key of Object.keys(options)) if (key !== "resolution") throw new UnsupportedFeatureError(`Gemini Omni video does not expose providerOptions.${key}; use interactions for advanced video workflows.`);
      const resolutions = this.modelId.startsWith("gemini-omni-1.1-") ? ["360p", "720p", "1080p", "4k"] : ["720p"];
      if (options.resolution !== undefined && !resolutions.includes(String(options.resolution))) throw new ConfigurationError("Unsupported Gemini Omni video resolution for this model.");
      const content: Array<Record<string, unknown>> = [{ type: "text", text: input.prompt }];
      if (input.image) {
        if (!input.image.mediaType.startsWith("image/") || (input.image.data === undefined) === (input.image.uri === undefined)) throw new ConfigurationError("Gemini Omni image requires an image MIME type and exactly one data or uri.");
        const part = mediaInputToPart(input.image);
        content.push({ type: "image", mime_type: input.image.mediaType,
          ...(part.inlineData ? { data: part.inlineData.data } : { uri: input.image.uri }) });
      }
      const result = await this.interactions.create({ modelId: this.modelId, input: content,
        responseFormat: [{ type: "video", ...(input.outputStorageUri ? { delivery: "uri", gcs_uri: input.outputStorageUri } : {}),
          ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
          ...(input.durationSeconds !== undefined ? { duration: `${input.durationSeconds}s` } : {}),
          ...(options.resolution ? { resolution: String(options.resolution) } : {}) }],
        generationConfig: { video_config: { task: input.image ? "image_to_video" : "text_to_video" } },
        background: false, store: false, abortSignal: input.abortSignal, timeoutMs: input.timeoutMs ?? 600_000,
        maxRetries: input.maxRetries, retryBackoffMs: input.retryBackoffMs });
      const videos: GeneratedMedia[] = (result.outputs ?? []).filter((output): output is Record<string, unknown> => !!output && typeof output === "object" && "type" in output && output.type === "video").map((output) => ({
        ...(typeof output.data === "string" ? { data: decodeMedia(output.data, "interactions") } : {}),
        ...(typeof output.uri === "string" ? { uri: output.uri } : {}),
        mediaType: typeof output.mime_type === "string" ? output.mime_type : "video/mp4"
      }));
      if (result.status !== "completed" || !videos.length || videos.some((video) => !video.data?.length && !video.uri)) throw new ConfigurationError("Gemini Omni did not return completed video; use interactions for asynchronous workflows.");
      return { videos, rawResponse: sanitizeMediaResponse(result.rawResponse) };
    }
    const timeoutMs = input.timeoutMs ?? 600_000;
    const { signal, cleanup } = withTimeoutSignal({ ...input, timeoutMs });
    const startedAt = Date.now();

    try {
      const json = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:predictLongRunning`, {
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
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );

      let operation = json;
      const operationName = operation.name;
      const pollIntervalMs = input.pollIntervalMs ?? 10_000;

      while (!operation.done) {
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`Vertex video generation timed out after ${timeoutMs}ms.`);
        }
        await sleep(pollIntervalMs, signal);
        const pollResult = await withRetry(
          () =>
            this.fetcher(`${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:fetchPredictOperation`, {
              method: "POST",
              headers: this.headers(),
              signal,
              body: JSON.stringify({
                operationName
              })
            }).then(parseJson),
          { ...input, abortSignal: signal }
        );
        operation = pollResult;
      }

      return {
        videos: collectVideos(operation, "models.predictLongRunning"),
        operationName,
        rawResponse: sanitizeMediaResponse(operation)
      };
    } finally {
      cleanup();
    }
  }
}

class VertexGroundedLanguageModel implements GroundedLanguageModel {
  readonly provider = "vertex";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {
    this.capabilities = modelCapabilities(modelId, groundedCapabilities);
  }

  private url() {
    return `${this.baseURL}/publishers/google/models/${encodeVertexPathSegment(this.modelId, "Vertex model ID")}:generateContent`;
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
    assertCurrentGeminiGenerateInput("vertex", this.modelId, input as ModelGenerateInput);
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const json = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              contents: mapMessages(input.messages),
              systemInstruction: systemInstruction(input.messages),
              tools: [{ googleSearch: {} }],
              generationConfig: generationConfig(this.modelId, {
                messages: input.messages,
                temperature: input.temperature,
                maxTokens: input.maxTokens,
                reasoning: input.reasoning
              } as ModelGenerateInput)
            })
          }).then(parseJson),
        { ...input, abortSignal: signal }
      );

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
        usage: normalizeGenerateContentUsage(json.usageMetadata ?? json.usage_metadata),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class VertexRealtimeModel implements RealtimeModel {
  readonly provider = "vertex";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly auth: VertexAuth,
    private readonly location: string,
    private readonly apiVersion: string,
    private readonly connectionFactory?: RealtimeConnectionFactory,
    private readonly realtimeURL?: string,
    private readonly allowUnsafeEndpoints = false,
    private readonly projectResource?: string
  ) {
    this.capabilities = realtimeCapabilities(modelId);
  }

  async connect(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions) {
    assertVertexRealtimeConfig(config, this.modelId);

    if (this.auth.type === "api-key") {
      throw new UnsupportedFeatureError('Provider "vertex" realtime sessions require accessToken or getAccessToken auth.');
    }

    if (!this.projectResource) throw new ConfigurationError("Vertex Live requires a project ID or project-scoped baseURL.");
    const modelResource = `${this.projectResource}/publishers/google/models/${this.modelId}`;
    const started = performance.now();
    const authDeadline = withTimeoutSignal({ timeoutMs: options?.timeoutMs, abortSignal: options?.signal });
    let accessToken: string;
    try { accessToken = await awaitVertexToken(this.auth.getAccessToken, authDeadline.signal); }
    finally { authDeadline.cleanup(); }
    const remainingTimeout = options?.timeoutMs === undefined ? undefined : Math.floor(options.timeoutMs - (performance.now() - started));
    if (remainingTimeout !== undefined && remainingTimeout <= 0) throw new DOMException("The operation timed out.", "TimeoutError");
    options?.signal?.throwIfAborted();

    const providerOptions = (config.providerOptions ?? {}) as Record<string, unknown>;
    const expectedRealtimeURL = vertexRealtimeURL(this.location, this.apiVersion, undefined, this.realtimeURL);
    const realtimeEndpoint = assertTrustedEndpoint(
      vertexRealtimeURL(this.location, this.apiVersion, providerOptions, this.realtimeURL),
      {
        label: "Vertex realtime endpoint",
        protocols: ["wss"],
        allowedHosts: [new URL(expectedRealtimeURL).hostname],
        allowUnsafe: this.allowUnsafeEndpoints
      }
    ).toString();
    const connection = await (this.connectionFactory ?? openWebSocketConnection)(
      realtimeEndpoint,
      vertexRealtimeHeaders(accessToken, providerOptions),
      { ...options, timeoutMs: remainingTimeout }
    );
    let inputMuted = false;
    const session = new CallbackRealtimeSession({
      provider: this.provider,
      modelId: this.modelId,
      capabilities: this.capabilities,
      config,
      connection,
      initializationTimeoutMs: options?.timeoutMs,
      callbacks: {
        parseEvent: createVertexRealtimeEventParser(isVertexLiveTranscribeModel(this.modelId)),
        isReadyPayload: (payload) => "setupComplete" in payload || "setup_complete" in payload,
        buildAudioPayloads: (frame) => inputMuted ? [] : [
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
          if (isGeminiLiveTranslateModel(this.modelId) || isVertexLiveTranscribeModel(this.modelId)) {
            throw new UnsupportedFeatureError(
              `Model "vertex/${this.modelId}" only supports audio input.`
            );
          }

          return [
            {
              realtimeInput: {
                mediaChunks: [{
                  mimeType: frame.mediaType,
                  data: encodeMediaFrame(frame)
                }]
              }
            }
          ];
        },
        buildTextPayloads: (text) => {
          if (isGeminiLiveTranslateModel(this.modelId) || isVertexLiveTranscribeModel(this.modelId)) {
            throw new UnsupportedFeatureError(
              `Model "vertex/${this.modelId}" only supports audio input.`
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
        buildInputMutePayloads: (muted) => {
          if (!isVertexLiveTranscribeModel(this.modelId) && !isGeminiLiveTranslateModel(this.modelId)) throw new UnsupportedFeatureError("Vertex input muting is only exposed for Live Transcribe and Live Translate.");
          if (inputMuted === muted) return [];
          inputMuted = muted;
          return muted ? [{ realtimeInput: { audioStreamEnd: true } }] : [];
        },
        buildToolResultPayloads: (result) => {
          if (isVertexLiveTranscribeModel(this.modelId)) throw new UnsupportedFeatureError("Live Transcribe does not support tool results.");
          return [
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
          ];
        },
        buildInterruptPayloads: (sessionConfig) => {
          if (isGeminiLiveTranslateModel(this.modelId) || isVertexLiveTranscribeModel(this.modelId)) {
            throw new UnsupportedFeatureError("This Vertex Live model does not support client-content interruption.");
          }
          const inputConfig = sessionConfig.providerOptions?.realtimeInputConfig as { automaticActivityDetection?: { disabled?: boolean } } | undefined;
          if (inputConfig?.automaticActivityDetection?.disabled !== true) {
            throw new UnsupportedFeatureError("Vertex explicit interruption requires providerOptions.realtimeInputConfig.automaticActivityDetection.disabled=true; automatic VAD interrupts on user speech.");
          }
          return [{ realtimeInput: { activityStart: {} } }, { realtimeInput: { activityEnd: {} } }];
        },
        buildUpdatePayloads: (sessionConfig, previousConfig) => {
          assertVertexRealtimeConfig(sessionConfig, this.modelId);
          for (const key of new Set([...Object.keys(previousConfig), ...Object.keys(sessionConfig)])) {
            if (key !== "instructions" && !Object.is(previousConfig[key as keyof RealtimeSessionConfig], sessionConfig[key as keyof RealtimeSessionConfig])) {
              throw new UnsupportedFeatureError(`Vertex Live cannot update "${key}" after connection; reconnect with the new configuration.`);
            }
          }
          if (sessionConfig.instructions === previousConfig.instructions) return [];
          if (typeof sessionConfig.instructions !== "string" || !sessionConfig.instructions.trim()) {
            throw new UnsupportedFeatureError("Vertex Live requires non-empty replacement instructions; reconnect to remove instructions.");
          }
          return [{ clientContent: { turns: [{ role: "system", parts: [{ text: sessionConfig.instructions }] }], turnComplete: false } }];
        },
        buildInitialPayloads: (sessionConfig) => {
          assertVertexRealtimeConfig(sessionConfig, this.modelId);
          return [vertexRealtimeSetup(sessionConfig, modelResource)];
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
): { transcriptionModel: (modelId: string) => VertexTranscriptionModelContract } & CallableProviderAdapter<LanguageModel<VertexLanguageModelOptions>> & VertexSpecializedClients & {
  caches: ContextCachesClient & { update(input: ContextCacheUpdateInput): Promise<CachedContent> };
  multimodalEmbeddings: VertexMultimodalEmbeddingClient;
  rawFetch: typeof globalThis.fetch;
  interactions: VertexInteractionsClient;
  claude: VertexClaudeClient;
  gemini: VertexGeminiClient;
  embeddingModel: (modelId: string) => import("@zhivex-ai/core/provider").EmbeddingModel;
  chatModel: (modelId: string, options?: VertexChatModelOptions) => LanguageModel;
  responsesModel: (modelId: string) => LanguageModel;
  virtualTryOn: VertexVirtualTryOnClient;
  endpoints: VertexEndpointsClient & VertexGrpcClient;
} => {
  const auth = resolveVertexAuth(options);
  const projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (auth.type === "bearer" && !projectId && !options.baseURL) {
    throw new ConfigurationError("Missing Vertex project ID.");
  }

  const location = options.location ?? process.env.VERTEX_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? "global";
  const apiVersion = options.apiVersion ?? "v1";
  const apiHost = vertexApiHost(location);
  const configuredBaseURL =
    options.baseURL ??
    (auth.type === "api-key"
      ? `https://aiplatform.googleapis.com/${apiVersion}`
      : `https://${apiHost}/${apiVersion}/projects/${projectId}/locations/${location}`);
  const baseURL = assertTrustedEndpoint(configuredBaseURL, {
    label: "Vertex baseURL",
    protocols: ["https"],
    allowUnsafe: options.allowUnsafeEndpoints
  }).toString().replace(/\/+$/, "");
  const veoLocation = location === "global" ? "us-central1" : location;
  const veoBaseURL =
    (options.baseURL ? baseURL : undefined) ??
    (auth.type === "api-key"
      ? baseURL
      : `https://${veoLocation}-aiplatform.googleapis.com/${apiVersion}/projects/${projectId}/locations/${veoLocation}`);
  const rawFetch = options.fetch ?? globalThis.fetch;
  const fetcher = createVertexAuthenticatedFetch(rawFetch, auth);
  const interactions = createVertexInteractionsClient(baseURL, fetcher, () => {
    if (auth.type !== "bearer" || !/\/projects\/[^/]+\/locations\/[^/]+$/.test(baseURL)) throw new ConfigurationError("Vertex Interactions requires Google Cloud bearer credentials and a project-scoped endpoint.");
  });
  const assertModelLocation = (modelId: string) => {
    if (modelId.replace(/^publishers\/google\/models\//, "").startsWith("virtual-try-on-")) throw new UnsupportedFeatureError("Virtual Try-On requires vertex.virtualTryOn.generate() with person and product images.");
    if (modelId.startsWith("claude-")) {
      throw new UnsupportedFeatureError("Claude on Vertex is available through languageModel(); this Google-specific surface is not supported.");
    }
    if (isVertexChatModel(modelId) || /^(?:intfloat\/|publishers\/(?!google\/)|anthropic\/)/.test(modelId)) {
      throw new UnsupportedFeatureError(`Vertex model "${modelId}" cannot use this Google-specific surface; select its publisher API.`);
    }
    if (options.baseURL || auth.type !== "bearer") {
      return;
    }
    const supportedLocations =
      modelId === "gemini-3.7-flash" || modelId === "gemini-3.6-flash" || modelId === "gemini-3.5-transcribe-preview" || isVertexLiveTranscribeModel(modelId) || isGeminiLiveTranslateModel(modelId)
        ? ["global"]
        : modelId === "gemini-3.8-flash" || modelId === "gemini-3.5-flash-lite"
          ? ["global", "us", "eu"]
          : undefined;
    if (supportedLocations && !supportedLocations.includes(location)) {
      throw new ConfigurationError(
        `Vertex model "${modelId}" is not available in location "${location}". ` +
          `Use ${supportedLocations.map((supportedLocation) => `"${supportedLocation}"`).join(", ")} or provide a custom baseURL.`
      );
    }
  };
  const googleModelId = (modelId: string) => {
    assertModelLocation(modelId);
    return modelId;
  };
  const chatModel = (modelId: string, chatOptions?: VertexChatModelOptions) => {
    if (auth.type !== "bearer") throw new ConfigurationError("Vertex partner chat requires Google Cloud bearer credentials.");
    return createVertexChatModel(modelId, baseURL, fetcher, chatOptions);
  };
  const assertLanguageSurface = (modelId: string) => {
    if (isVertexLiveTranscribeModel(modelId) || isGeminiLiveTranslateModel(modelId)) {
      throw new UnsupportedFeatureError(`Vertex model "${modelId}" requires realtimeModel(), not a language model factory.`);
    }
    if (modelId === "gemini-3.5-transcribe-preview") {
      throw new UnsupportedFeatureError(`Vertex model "${modelId}" requires transcriptionModel(), not a language model factory.`);
    }
  };
  const languageModel = (modelId: string) => {
    assertLanguageSurface(modelId);
    if (isVertexChatModel(modelId)) return chatModel(modelId);
    if (modelId.startsWith("claude-")) {
      const encodedId = encodeVertexPathSegment(modelId, "Vertex Claude model ID");
      if (auth.type !== "bearer") {
        throw new ConfigurationError("Claude on Vertex requires Google Cloud bearer credentials (ADC, authClient, getAccessToken, or accessToken), not an API key.");
      }
      return createVertexClaudeModel(modelId, `${baseURL}/publishers/anthropic/models/${encodedId}`, fetcher);
    }
    assertModelLocation(modelId);
    return new VertexLanguageModel(modelId, baseURL, "", fetcher);
  };
  const groundedLanguageModel = (modelId: string) => {
    assertLanguageSurface(modelId);
    if (modelId.startsWith("claude-")) {
      throw new UnsupportedFeatureError("Claude on Vertex does not support Google grounded generation; use languageModel().");
    }
    assertModelLocation(modelId);
    return new VertexGroundedLanguageModel(modelId, baseURL, "", fetcher);
  };

  return createProviderAdapter({
    name: "vertex",
    endpoints: { ...createVertexEndpointsClient(fetcher, (endpoint, action) => {
      if (!/^(?:projects\/[^/]+\/locations\/[^/]+\/)?endpoints\/[^/]+$/.test(endpoint)) throw new ConfigurationError("Vertex endpoint must use endpoints/<id> or projects/<project>/locations/<location>/endpoints/<id>.");
      return `${vertexResourceURL(baseURL, endpoint)}:${action}`;
    }, () => {
      if (auth.type !== "bearer") throw new ConfigurationError("Vertex deployed endpoints require Google Cloud bearer credentials.");
    }, parseJson), ...createVertexGrpcClient(baseURL, (endpoint, allowPublisher) => {
      const deployed = /^(?:projects\/[^/]+\/locations\/[^/]+\/)?endpoints\/[^/]+$/;
      const publisher = /^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/[^/]+\/models\/[^/]+$/;
      if (!deployed.test(endpoint) && !(allowPublisher && publisher.test(endpoint))) throw new ConfigurationError(allowPublisher
        ? "Vertex serverStreamingPredict requires an endpoint or publisher model resource."
        : "Vertex gRPC endpoint must be a deployed endpoint resource.");
      const encoded = new URL(vertexResourceURL(baseURL, endpoint)).pathname.replace(/^\/v1(?:beta1)?\//, "");
      // gRPC carries a resource name in protobuf, not an escaped HTTP URL path.
      const resource = decodeURIComponent(encoded);
      if (!/^projects\/[^/]+\/locations\/[^/]+\//.test(resource) || (!deployed.test(resource) && !(allowPublisher && publisher.test(resource)))) throw new ConfigurationError("Vertex gRPC requires a project-scoped resource.");
      return resource;
    }, async signal => {
      if (auth.type !== "bearer") throw new ConfigurationError("Vertex gRPC requires Google Cloud bearer credentials.");
      return awaitVertexToken(auth.getAccessToken, signal);
    }) },
    virtualTryOn: createVertexVirtualTryOnClient(new VertexPredictionModel("virtual-try-on-001", baseURL, "", fetcher), () => {
      if (auth.type !== "bearer") throw new ConfigurationError("Virtual Try-On requires Google Cloud bearer credentials.");
    }, sanitizeMediaResponse),
    interactions,
    claude: createVertexClaudeClient(baseURL, fetcher, () => {
      if (auth.type !== "bearer") throw new ConfigurationError("Vertex Claude token counting requires Google Cloud bearer credentials.");
      if (!options.baseURL && !["global", "us", "eu", "asia-southeast1"].includes(location)) throw new ConfigurationError("Vertex Claude token counting requires global, us, eu or asia-southeast1.");
    }),
    ...createVertexSpecializedClients(baseURL, fetcher, () => {
      if (auth.type !== "bearer") throw new ConfigurationError("Vertex OCR and FIM require Google Cloud bearer credentials.");
    }),
    languageModel,
    chatModel,
    responsesModel: (modelId: string) => {
      if (auth.type !== "bearer") throw new ConfigurationError("Vertex Grok Responses requires Google Cloud bearer credentials.");
      return createVertexResponsesModel(modelId, baseURL, fetcher, options.allowUnsafeEndpoints);
    },
    gemini: {
      async countTokens(input: VertexGeminiTokenCountInput) {
        const modelId = googleModelId(input.modelId.replace(/^publishers\/google\/models\//, ""));
        if (!/^gemini-[a-z0-9@.-]+$/.test(modelId)) throw new ConfigurationError("Vertex Gemini token counting requires a Gemini model ID.");
        const body = JSON.stringify({ contents: mapMessages(input.messages),
          systemInstruction: input.system !== undefined ? { parts: [{ text: input.system }] } : systemInstruction(input.messages),
          tools: input.tools ? mapTools(toToolSet(input.tools)) : undefined,
          generationConfig: input.generationConfig });
        const { signal, cleanup } = withTimeoutSignal(input);
        try {
          const json = await withRetry(() => fetcher(`${baseURL}/publishers/google/models/${encodeVertexPathSegment(modelId, "Vertex model ID")}:countTokens`, {
            method: "POST", headers: { "content-type": "application/json" }, body, signal, redirect: "error"
          }).then(parseJson), { ...input, abortSignal: signal });
          if (!Number.isSafeInteger(json.totalTokens) || json.totalTokens < 0) throw new ConfigurationError("Vertex returned invalid token count.");
          if (json.totalBillableCharacters !== undefined && (!Number.isSafeInteger(json.totalBillableCharacters) || json.totalBillableCharacters < 0)) throw new ConfigurationError("Vertex returned invalid billable character count.");
          return { inputTokens: json.totalTokens, ...(json.totalBillableCharacters !== undefined ? { totalBillableCharacters: json.totalBillableCharacters } : {}), rawResponse: json };
        } finally { cleanup(); }
      }
    },
    multimodalEmbeddings: { embed: (input: VertexMultimodalEmbeddingInput) => new VertexLegacyMultimodalEmbeddingModel(baseURL, fetcher, () => {
      if (auth.type !== "bearer") throw new ConfigurationError("Vertex legacy multimodal embeddings require Google Cloud bearer credentials.");
    }).embedMultimodal(input) },
    embeddingModel: (modelId) => {
      if (modelId.replace(/^publishers\/google\/models\//, "") === "multimodalembedding@001") return new VertexLegacyMultimodalEmbeddingModel(baseURL, fetcher, () => {
        if (auth.type !== "bearer") throw new ConfigurationError("Vertex legacy multimodal embeddings require Google Cloud bearer credentials.");
      });
      const openModel = modelId.replace(/^publishers\/intfloat\/models\//, "intfloat/");
      if (openModel.startsWith("intfloat/")) {
        if (!/^intfloat\/multilingual-e5-(?:small|large-instruct)-maas$/.test(openModel)) throw new ConfigurationError(`Unsupported Vertex E5 embedding model "${modelId}".`);
        if (auth.type !== "bearer") throw new ConfigurationError("Vertex E5 embeddings require Google Cloud bearer credentials.");
        return new VertexOpenEmbeddingModel(openModel, baseURL, fetcher);
      }
      return new VertexEmbeddingModel(googleModelId(modelId), baseURL, fetcher);
    },
    transcriptionModel: (modelId) => {
      if (modelId === "gemini-3.5-transcribe-live-preview") throw new UnsupportedFeatureError("The Live transcription model requires a dedicated realtime session, not transcriptionModel().");
      return new VertexTranscriptionModel(googleModelId(modelId), baseURL, "", fetcher);
    },
    speechModel: (modelId) => new VertexSpeechModel(googleModelId(modelId), baseURL, "", fetcher),
    imageGenerationModel: (modelId) => new VertexImageGenerationModel(googleModelId(modelId), baseURL, "", fetcher),
    videoGenerationModel: (modelId) =>
      new VertexVideoGenerationModel(googleModelId(modelId), isVeoModel(modelId) ? veoBaseURL : baseURL, "", fetcher, interactions),
    musicGenerationModel: (modelId) => new VertexMusicGenerationModel(googleModelId(modelId), baseURL, "", fetcher, interactions),
    realtimeModel: (modelId) =>
      new VertexRealtimeModel(
        googleModelId(modelId),
        auth,
        location,
        apiVersion,
        options.realtimeConnectionFactory,
        options.realtimeURL
          ? assertTrustedEndpoint(options.realtimeURL, {
              label: "Vertex realtimeURL",
              protocols: ["wss"],
              allowedHosts: [apiHost],
              allowUnsafe: options.allowUnsafeEndpoints
            }).toString()
          : undefined,
        options.allowUnsafeEndpoints,
        baseURL.match(/\/(projects\/[^/]+\/locations\/[^/]+)(?:\/|$)/)?.[1] ?? (projectId ? `projects/${projectId}/locations/${location}` : undefined)
      ),
    groundedLanguageModel,
    caches: new VertexContextCachesClient(baseURL, "", fetcher, assertModelLocation),
    batches: new VertexBatchesClient(baseURL, fetcher, () => {
      if (auth.type !== "bearer") throw new ConfigurationError("Vertex batch jobs require Google Cloud bearer credentials and a project-scoped endpoint.");
    }),
    predictionModel: (modelId) => {
      const resource = vertexPublisherResource(modelId);
      if (modelId.startsWith("claude-")) {
        throw new ConfigurationError('Use vertex(claudeModelId) or predictionModel("publishers/anthropic/models/<modelId>") for Claude.');
      }
      if (!resource.startsWith("publishers/google/") && auth.type !== "bearer") {
        throw new ConfigurationError("Vertex partner publisher predictions require Google Cloud bearer credentials.");
      }
      return new VertexPredictionModel(modelId, baseURL, "", fetcher);
    },
    rawFetch
  });
};

export const vertexMcpTools = createMcpToolSet;
