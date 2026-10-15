import { toJSONSchema, z } from "zod";
import {
  capabilities,
  groundedCapabilities,
  modelCapabilities,
  isAzureAstraModel,
  isAzureReasoningChatModel,
  isKnownAzureModelFamily,
  realtimeCapabilities,
  speechCapabilities,
  supportsAzureOpenAIHostedHarnessTools,
  transcriptionCapabilities,
} from "./capabilities.js";

import {
  imageInputToDataUrl,
  CallbackRealtimeSession,
  ConfigurationError,
  ProviderHTTPError,
  ProviderToolCallError,
  assertTrustedEndpoint,
  decodeBase64WithLimit,
  readBodyWithLimit,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  resolveAudioResponseLimits,
  openWebSocketConnection,
  hostedTool,
  providerDataPart,
  UnsupportedFeatureError,
  createProviderAdapter,
  encodeAudioFrame,
  encodeMediaFrame,
  isCallableToolDefinition,
  isHostedToolDefinition,
  normalizeFinishReason,
  streamSSE,
  streamChatCompletions,
  toToolSet,
  toolResultPayload,
  withResponseRetry,
  withTimeoutSignal,
  type AudioFrame,
  type AudioInput,
  type AudioResponseLimits,
  type CallableProviderAdapter,
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  type GenerateResult,
  type GroundedGenerateResult,
  type GroundedLanguageModel,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type RealtimeConnectOptions,
  type RealtimeConnectionFactory,
  type RealtimeModel,
  type RealtimeSessionConfig,
  type RealtimeTokenResult,
  type SpeechModel,
  type SpeechResult,
  type RetryOptions,
  type StreamEvent,
  type TokenUsage,
  type ToolDefinition,
  type TranscriptionModel,
  type TranscriptionResult
} from "@zhivex-ai/core/provider";

export interface AzureOpenAIDeploymentConfig {
  /**
   * Base model id used for capabilities, Responses vs Chat, and token-limit fields.
   * The deployment name is still what gets sent as `model` on the v1 API.
   */
  model: string;
}

/**
 * Structural match for `@azure/identity` credentials. This package does not depend on that SDK.
 * Typical scopes are `https://cognitiveservices.azure.com/.default` and `https://ai.azure.com/.default`.
 */
export interface AzureTokenCredential {
  getToken(scope: string | string[]): Promise<{ token: string; expiresOnTimestamp?: number } | null>;
}

export const azureEntraTokenProvider = (
  credential: AzureTokenCredential,
  scope = "https://cognitiveservices.azure.com/.default"
) => async () => {
  const result = await credential.getToken(scope);
  if (!result?.token) {
    throw new ConfigurationError("Azure token credential did not return a token.");
  }
  return result.token;
};

export interface AzureOpenAIProviderOptions {
  apiKey?: string;
  /**
   * Entra ID (or other) bearer token factory. Called on every request.
   * Mutually exclusive with `apiKey`. When set, `AZURE_OPENAI_API_KEY` is ignored.
   */
  tokenProvider?: () => string | Promise<string>;
  /** Maps an opaque deployment name to the base model that should drive capabilities and request shape. */
  deployments?: Record<string, AzureOpenAIDeploymentConfig>;
  /**
   * Default retry count for this provider when a call omits `maxRetries`.
   * Azure throttling is common enough that the default is 2. Pass `0` to disable.
   */
  maxRetries?: number;
  endpoint?: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
  realtimeConnectionFactory?: RealtimeConnectionFactory;
  realtimeURL?: string;
  browserTokenURL?: string;
  responseLimits?: AudioResponseLimits;
  /** Allow non-HTTPS/private or cross-origin credentialed endpoint overrides. Server-side only. */
  allowUnsafeEndpoints?: boolean;
}

export interface AzureOpenAIWebSearchToolConfig {
  type?: "web_search_preview";
  search_context_size?: "small" | "medium" | "large" | "low" | "high";
  user_location?: {
    type: "approximate";
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
}

export interface AzureOpenAIFileSearchToolConfig {
  vector_store_ids?: string[];
  max_num_results?: number;
  ranking_options?: Record<string, unknown>;
  filters?: Record<string, unknown>;
}

export interface AzureOpenAIMcpToolFilter {
  read_only?: boolean;
  tool_names?: string[];
}

export type AzureOpenAIMcpAllowedTools = string[] | AzureOpenAIMcpToolFilter;
export type AzureOpenAIMcpRequireApproval =
  | "never"
  | "always"
  | {
      always?: AzureOpenAIMcpToolFilter;
      never?: AzureOpenAIMcpToolFilter;
    };

type AzureOpenAIRemoteMcpToolSharedConfig = {
  server_label?: string;
  server_description?: string;
  headers?: Record<string, string>;
  authorization?: string;
  require_approval?: AzureOpenAIMcpRequireApproval;
  allowed_tools?: AzureOpenAIMcpAllowedTools;
};

export type AzureOpenAIRemoteMcpToolConfig =
  | (AzureOpenAIRemoteMcpToolSharedConfig & {
      server_url: string;
      connector_id?: never;
    })
  | (AzureOpenAIRemoteMcpToolSharedConfig & {
      server_url?: never;
      connector_id:
        | "connector_dropbox"
        | "connector_gmail"
        | "connector_googlecalendar"
        | "connector_googledrive"
        | "connector_microsoftteams"
        | "connector_outlookcalendar"
        | "connector_outlookemail"
        | "connector_sharepoint";
    });

export interface AzureOpenAIComputerUseToolConfig {
  environment: "browser" | "mac" | "windows" | "linux" | "ubuntu";
  display_width?: number;
  display_height?: number;
}

export interface AzureOpenAICodeInterpreterToolConfig {
  container:
    | string
    | {
        type: "auto";
        memory_limit?: "1g" | "4g" | "16g" | "64g";
        file_ids?: string[];
      };
}

export interface AzureOpenAIShellToolConfig {
  name?: string;
  cwd?: string;
  rootDir?: string;
  timeoutMs?: number;
  maxOutputLength?: number;
  execute?: (input: AzureOpenAIShellToolInput) => Promise<AzureOpenAIShellToolOutput> | AzureOpenAIShellToolOutput;
}

export interface AzureOpenAIShellToolInput {
  command?: string;
  action?: {
    command?: string;
    max_output_length?: number;
    maxOutputLength?: number;
  };
  maxOutputLength?: number;
  max_output_length?: number;
}

export interface AzureOpenAIShellToolOutput {
  stdout: string;
  stderr: string;
  outcome: {
    type: "exit" | "timeout";
    exitCode?: number;
  };
  maxOutputLength?: number;
}

export interface AzureOpenAIApplyPatchOperation {
  type: "create_file" | "update_file" | "delete_file";
  path: string;
  diff?: string;
}

export interface AzureOpenAIApplyPatchToolInput {
  operation: AzureOpenAIApplyPatchOperation;
}

export interface AzureOpenAIApplyPatchToolOutput {
  status: "completed" | "failed";
  output?: string;
}

export interface AzureOpenAIApplyPatchToolConfig {
  name?: string;
  rootDir?: string;
  applyOperation: (operation: AzureOpenAIApplyPatchOperation) => Promise<AzureOpenAIApplyPatchToolOutput> | AzureOpenAIApplyPatchToolOutput;
}

export interface AzureOpenAIToolSearchToolConfig {
  [key: string]: unknown;
}

const azureOpenAIResponsesToolMetadataKey = "azure-openai.responses_tool_type";

const azureOpenAILocalResponsesToolType = (tool: ToolDefinition) => {
  const type = tool.metadata?.[azureOpenAIResponsesToolMetadataKey];
  return typeof type === "string" ? type : undefined;
};

const azureOpenAILocalResponsesToolConfig = (tool: ToolDefinition) => {
  const config = tool.metadata?.["azure-openai.responses_tool_config"];
  return config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : undefined;
};

const assertAzureOpenAIToolPathInsideRoot = async (rootDir: string | undefined, targetPath: string, label: string) => {
  if (!rootDir) {
    return targetPath;
  }

  const path = await import("node:path");
  const root = path.resolve(rootDir);
  const target = path.resolve(root, targetPath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Azure OpenAI ${label} path escapes rootDir.`);
  }

  return target;
};

export interface AzureOpenAIMcpApprovalRequest {
  type: "mcp_approval_request";
  id: string;
  arguments: string;
  name: string;
  server_label: string;
}

export interface AzureOpenAIMcpApprovalResponse {
  type: "mcp_approval_response";
  approval_request_id: string;
  approve: boolean;
  id?: string;
  reason?: string;
}

export interface AzureOpenAIMcpCall {
  type: "mcp_call";
  id: string;
  arguments: string;
  name: string;
  server_label: string;
  approval_request_id?: string;
  error?: string;
  output?: string;
  status?: "in_progress" | "completed" | "incomplete" | "calling" | "failed";
}

export interface AzureOpenAIMcpListTools {
  type: "mcp_list_tools";
  id?: string;
  server_label?: string;
  tools?: JsonValue;
}

export type AzureOpenAIProviderData =
  | { responseId: string }
  | AzureOpenAIMcpApprovalRequest
  | AzureOpenAIMcpApprovalResponse
  | AzureOpenAIMcpCall
  | AzureOpenAIMcpListTools;

export interface AzureOpenAILanguageModelOptions {
  /** Explicitly select Responses for opaque deployment names. */
  apiMode?: "auto" | "chat" | "responses";
  /**
   * Base model id when `modelId` is an opaque deployment name.
   * Overrides the provider `deployments` map for request shape on this call.
   * Reasoning validation uses it when core calls `resolveCapabilities`.
   * Core 1.30.1 does not, so set `deployments` for those checks.
   */
  baseModel?: string;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  [key: string]: unknown;
}

interface AzureAuth {
  headers: (extra?: Record<string, string>) => Promise<Record<string, string>>;
  maxRetries: number;
}

const AZURE_AUTH_HINT =
  "Assign the Cognitive Services OpenAI User role and request a token for https://cognitiveservices.azure.com/.default or https://ai.azure.com/.default.";

export class AzureOpenAIAuthenticationError extends ConfigurationError {
  readonly status = 401;
}

export class AzureOpenAIContentFilterError extends ProviderHTTPError {
  readonly code = "content_filter";

  constructor(message: string, options?: { cause?: unknown; responseBody?: unknown }) {
    super(message, 400, options);
  }
}

const contentFilterCode = (body: unknown) => {
  if (typeof body !== "string" || !body.trim()) {
    return false;
  }
  try {
    const json = JSON.parse(body) as { code?: unknown; error?: { code?: unknown } };
    return json.code === "content_filter" || json.error?.code === "content_filter";
  } catch {
    return false;
  }
};

const classifyAzureError = (error: unknown) => {
  if (!(error instanceof ProviderHTTPError) || error instanceof AzureOpenAIContentFilterError) {
    return error;
  }
  if (error.status === 401) {
    return new AzureOpenAIAuthenticationError(
      `Azure OpenAI request failed with status 401. ${AZURE_AUTH_HINT}`,
      { cause: error }
    );
  }
  if (error.status === 400 && contentFilterCode(error.responseBody)) {
    return new AzureOpenAIContentFilterError("Azure OpenAI rejected the request with content_filter.", {
      cause: error,
      responseBody: error.responseBody
    });
  }
  return error;
};

const sendAzure = (
  operation: () => Promise<Response>,
  options: RetryOptions | undefined,
  defaultMaxRetries: number
) => withResponseRetry(
  operation,
  { ...options, maxRetries: options?.maxRetries ?? defaultMaxRetries },
  "Azure OpenAI"
).catch((error) => {
  throw classifyAzureError(error);
});

const warnedDeployments = new Set<string>();

const noteOpaqueDeployment = (deployment: string, resolvedModel: string) => {
  if (
    resolvedModel !== deployment ||
    isKnownAzureModelFamily(deployment) ||
    warnedDeployments.has(deployment) ||
    !deployment ||
    deployment === "." ||
    deployment === ".." ||
    /[\\/?#\s]/.test(deployment)
  ) {
    return;
  }
  warnedDeployments.add(deployment);
  console.warn(
    `Azure OpenAI deployment "${deployment}" does not match a known model id. Pass deployments or providerOptions.baseModel so capabilities and token limits are not inferred from the deployment name.`
  );
};

const azureUsage = (usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
} | undefined): TokenUsage | undefined => {
  if (!usage) {
    return undefined;
  }
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens,
    outputTokens: usage.completion_tokens ?? usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {})
  };
};

const AZURE_OPENAI_JSON_RESPONSE_MAX_BYTES = 128 * 1024 * 1024;
const AZURE_OPENAI_REALTIME_AUDIO_MAX_BYTES = 16 * 1024 * 1024;

const parseJson = async (
  response: Response,
  options: {
    maxBytes?: number;
    errorBodyBytes?: number;
    endpoint?: string;
    abort?: (reason?: unknown) => void;
  } = {}
) => {
  if (!response.ok) {
    const body = await readErrorBodyWithLimit(response, options.errorBodyBytes);
    throw classifyAzureError(new ProviderHTTPError(`Azure OpenAI request failed with status ${response.status}.`, response.status, {
      responseBody: body
    }));
  }
  return readJsonWithLimit<any>(response, {
    maxBytes: options.maxBytes ?? AZURE_OPENAI_JSON_RESPONSE_MAX_BYTES,
    provider: "azure-openai",
    endpoint: options.endpoint,
    abort: options.abort
  });
};

const rejectCredentialedRedirects = (fetcher: typeof globalThis.fetch): typeof globalThis.fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) =>
    fetcher(input, {
      ...init,
      redirect: "error"
    })) as typeof globalThis.fetch;

const toUint8Array = (data: AudioInput["data"]) => {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return Uint8Array.from(Buffer.from(data, "base64"));
};

const createAudioFile = (audio: AudioInput) => {
  const bytes = toUint8Array(audio.data);
  return new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], audio.filename ?? "audio", {
    type: audio.mediaType
  });
};

const mapContentParts = (message: ModelMessage) => {
  const textParts = message.parts.filter((part) => part.type === "text");
  const imageParts = message.parts.filter((part) => part.type === "image");

  if (!imageParts.length) {
    return textParts.map((part) => part.text).join("");
  }

  return [
    ...textParts.map((part) => ({
      type: "text",
      text: part.text
    })),
    ...imageParts.map((part) => ({
      type: "image_url",
      image_url: {
        url: imageInputToDataUrl(part)
      }
    }))
  ];
};

const mapMessages = (messages: ModelMessage[]) =>
  messages.map((message) => {
    if (message.role === "tool") {
      const toolResult = message.parts.find((part) => part.type === "tool-result");
      return {
        role: "tool",
        tool_call_id: toolResult?.type === "tool-result" ? toolResult.toolResult.toolCallId : undefined,
        content:
          toolResult?.type === "tool-result"
            ? JSON.stringify(toolResult.toolResult.isError ? toolResult.toolResult.error : toolResult.toolResult.output)
            : ""
      };
    }

    const toolCalls = message.parts
      .filter((part) => part.type === "tool-call")
      .map((part) => ({
        id: part.toolCall.id,
        type: "function",
        function: {
          name: part.toolCall.name,
          arguments: JSON.stringify(part.toolCall.input)
        }
      }));

    const payload: Record<string, unknown> = {
      role: message.role,
      content: mapContentParts(message)
    };

    if (toolCalls.length) {
      payload.tool_calls = toolCalls;
    }

    return payload;
  });

const hasResponsesOnlyTools = (tools: ModelGenerateInput["tools"]) =>
  Object.values(tools ?? {}).some(
    (tool) => isHostedToolDefinition(tool) || (isCallableToolDefinition(tool) && azureOpenAILocalResponsesToolType(tool))
  );

const assertResponsesToolsSupported = (modelId: string, tools: ModelGenerateInput["tools"]) => {
  const currentCapabilities = modelCapabilities(modelId).agentCapabilities;
  for (const definition of Object.values(tools ?? {})) {
    const type = isCallableToolDefinition(definition) ? azureOpenAILocalResponsesToolType(definition) : definition.type;
    if (type === "tool_search" && !currentCapabilities?.toolSearch) {
      throw new UnsupportedFeatureError(`Provider "azure-openai" model "${modelId}" does not support the Responses tool_search tool.`);
    }
    if (type === "computer_use_preview" && !currentCapabilities?.computerUse) {
      throw new UnsupportedFeatureError(`Provider "azure-openai" model "${modelId}" does not support the Responses computer_use tool.`);
    }
    if ((type === "shell" || type === "apply_patch") && !supportsAzureOpenAIHostedHarnessTools(modelId)) {
      throw new UnsupportedFeatureError(`Provider "azure-openai" model "${modelId}" does not support the Responses ${type} tool.`);
    }
  }
};

const normalizeWebSearchConfig = (config: AzureOpenAIWebSearchToolConfig = {}) => ({
  ...config,
  ...(config.search_context_size === "small" ? { search_context_size: "low" } : {}),
  ...(config.search_context_size === "large" ? { search_context_size: "high" } : {})
});

const mapTools = (input: ModelGenerateInput["tools"]) =>
  input
    ? Object.values(input).map((tool) => {
        if (isCallableToolDefinition(tool)) {
          return {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: toJSONSchema(tool.schema)
            }
          };
        }

        if (tool.provider && tool.provider !== "azure-openai" && tool.provider !== "openai") {
          throw new UnsupportedFeatureError(
            `Provider "azure-openai" does not support hosted tools declared for provider "${tool.provider}".`
          );
        }

        return {
          type: tool.type,
          ...(tool.config && typeof tool.config === "object" ? tool.config : {})
        };
      })
    : undefined;

const mapResponsesTools = (input: ModelGenerateInput["tools"]) =>
  input
    ? Object.values(input).map((tool) => {
        if (isCallableToolDefinition(tool)) {
          const responsesToolType = azureOpenAILocalResponsesToolType(tool);
          if (responsesToolType) {
            return {
              type: responsesToolType,
              ...azureOpenAILocalResponsesToolConfig(tool)
            };
          }

          return {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema)
          };
        }

        if (tool.provider && tool.provider !== "azure-openai" && tool.provider !== "openai") {
          throw new UnsupportedFeatureError(
            `Provider "azure-openai" does not support hosted tools declared for provider "${tool.provider}".`
          );
        }

        return {
          type: tool.type,
          ...(tool.config && typeof tool.config === "object" ? tool.config : {})
        };
      })
    : undefined;

const mapToolChoice = (toolChoice: ModelGenerateInput["toolChoice"]) => {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    return toolChoice;
  }

  return {
    type: "function",
    function: {
      name: toolChoice.toolName
    }
  };
};

const mapRealtimeProviderOptions = (providerOptions: Record<string, unknown> | undefined) => {
  if (!providerOptions) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(providerOptions).filter(([key]) => !["headers", "realtime_url", "realtime_query", "expires_after"].includes(key))
  );
};

const mapRealtimeAudioFormat = (mediaType: string | undefined, sampleRateHz: number | undefined) =>
  mediaType || sampleRateHz
    ? {
        ...(mediaType ? { type: mediaType } : {}),
        ...(sampleRateHz ? { rate: sampleRateHz } : {})
      }
    : undefined;

const mapRealtimeSessionConfig = (config: RealtimeSessionConfig, modelId?: string) => ({
  type: "realtime",
  model: modelId,
  instructions: config.instructions,
  output_modalities: config.outputAudioMediaType || config.voice ? ["audio"] : ["text"],
  tools: mapTools(toToolSet(config.tools)),
  tool_choice: config.toolChoice ? mapToolChoice(config.toolChoice) : undefined,
  audio: {
    input: {
      format: mapRealtimeAudioFormat(config.inputAudioMediaType, config.inputSampleRateHz),
      turn_detection: config.turnDetection ?? undefined
    },
    output: {
      format: mapRealtimeAudioFormat(config.outputAudioMediaType, config.outputSampleRateHz),
      voice: config.voice
    }
  },
  ...mapRealtimeProviderOptions(config.providerOptions)
});

const azureOpenAIRealtimeURL = (endpoint: string, modelId: string, apiVersion: string | undefined, override?: string) => {
  if (override) {
    return override;
  }

  const url = new URL(endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  if (apiVersion) {
    url.pathname = "/openai/realtime";
    url.searchParams.set("api-version", apiVersion);
    url.searchParams.set("deployment", modelId);
  } else {
    url.pathname = "/openai/v1/realtime";
    url.searchParams.set("model", modelId);
  }
  return url.toString();
};

const parseAzureRealtimeEvent = (payload: Record<string, unknown>) => {
  const type = String(payload.type ?? "");
  if (type === "session.created" || type === "session.updated") {
    return [];
  }
  if (type === "response.text.delta" || type === "response.output_text.delta") {
    return [
      {
        type: "realtime-text-delta" as const,
        textDelta: String(payload.delta ?? ""),
        itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        responseId: typeof payload.response_id === "string" ? payload.response_id : undefined,
        role: "assistant" as const,
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }
  if (type === "response.audio.delta" || type === "response.output_audio.delta") {
    return [
      {
        type: "realtime-audio-output" as const,
        audio: decodeBase64WithLimit(String(payload.delta ?? ""), {
          maxBytes: AZURE_OPENAI_REALTIME_AUDIO_MAX_BYTES,
          provider: "azure-openai",
          endpoint: "realtime"
        }),
        mediaType: typeof payload.media_type === "string" ? payload.media_type : "audio/pcm",
        sampleRateHz: typeof payload.sample_rate_hz === "number" ? payload.sample_rate_hz : undefined,
        channels: typeof payload.channels === "number" ? payload.channels : undefined,
        itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        responseId: typeof payload.response_id === "string" ? payload.response_id : undefined,
        providerMetadata: payload as Record<string, JsonValue>
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
        providerMetadata: payload as Record<string, JsonValue>
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
        providerMetadata: payload as Record<string, JsonValue>
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
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }
  if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
    const item = payload.item && typeof payload.item === "object" ? (payload.item as Record<string, unknown>) : undefined;
    const name = typeof payload.name === "string" ? payload.name : typeof item?.name === "string" ? item.name : undefined;
    const callId = typeof payload.call_id === "string" ? payload.call_id : typeof item?.call_id === "string" ? item.call_id : undefined;
    const rawArgs = typeof payload.arguments === "string" ? payload.arguments : typeof item?.arguments === "string" ? item.arguments : "{}";
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
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }
  if (type === "error") {
    return [
      {
        type: "realtime-error" as const,
        message: typeof payload.message === "string" ? payload.message : "Realtime API error.",
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }
  return [];
};

const mapStructuredOutput = (input: ModelGenerateInput) => {
  if (!input.structuredOutput || input.structuredOutput.mode !== "native") {
    return undefined;
  }

  return {
    type: "json_schema",
    json_schema: {
      name: input.structuredOutput.name ?? "response",
      strict: true,
      schema: toJSONSchema(input.structuredOutput.schema)
    }
  };
};

const mapResponsesStructuredOutput = (input: ModelGenerateInput) => {
  if (!input.structuredOutput || input.structuredOutput.mode !== "native") {
    return undefined;
  }

  return {
    format: {
      type: "json_schema",
      name: input.structuredOutput.name ?? "response",
      strict: true,
      schema: toJSONSchema(input.structuredOutput.schema)
    }
  };
};

const mapReasoning = (input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return {};
  }

  if (input.reasoning.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "azure-openai" does not support "reasoning.budgetTokens".');
  }

  return input.reasoning.effort === undefined ? {} : { reasoning_effort: input.reasoning.effort };
};

const chatTokenFields = (modelId: string, input: ModelGenerateInput) => {
  if (input.maxTokens === undefined) {
    return {};
  }
  if (input.reasoning || isAzureReasoningChatModel(modelId)) {
    return { max_completion_tokens: input.maxTokens };
  }
  return { max_tokens: input.maxTokens };
};

const azureBodyOptions = (input: Pick<ModelGenerateInput, "providerOptions">) => {
  const { apiMode: _apiMode, baseModel: _baseModel, ...body } = input.providerOptions ?? {};
  return body;
};

const useAzureResponses = (modelId: string, input: ModelGenerateInput) => {
  const options = input.providerOptions ?? {};
  if (isAzureAstraModel(modelId)) {
    const effort = input.reasoning?.effort ?? options.reasoning_effort ?? (options.reasoning as { effort?: string } | undefined)?.effort;
    if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(String(effort))) {
      throw new UnsupportedFeatureError(`Azure GPT-6 Astra does not support reasoning effort "${effort}".`);
    }
    if (input.temperature !== undefined || options.temperature !== undefined || options.top_p !== undefined) {
      throw new UnsupportedFeatureError("Azure GPT-6 Astra does not support temperature or top_p.");
    }
    if (options.apiMode === "chat" && Object.keys(input.tools ?? {}).length) {
      throw new UnsupportedFeatureError("Azure GPT-6 Astra tool calling requires Responses.");
    }
  }
  const required = hasResponsesOnlyTools(input.tools);
  if (options.apiMode === "chat" && required) {
    throw new UnsupportedFeatureError("Responses-only tools cannot use Azure Chat Completions.");
  }
  return options.apiMode === "responses" || required || (isAzureAstraModel(modelId) && options.apiMode !== "chat");
};

const azureResponsesBodyOptions = (input: ModelGenerateInput) => {
  const { reasoning_effort: _effort, max_completion_tokens: _max, ...body } = azureBodyOptions(input);
  return body;
};

const mapAzureResponsesReasoning = (input: ModelGenerateInput) => {
  if (input.reasoning?.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "azure-openai" does not support "reasoning.budgetTokens".');
  }
  const options = input.providerOptions ?? {};
  const effort = input.reasoning?.effort ?? options.reasoning_effort;
  return effort === undefined ? {} : { reasoning: { ...(options.reasoning as Record<string, unknown> | undefined), effort } };
};

const getProviderResponseId = (messages: ModelMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }

    const providerData = message.parts.find(
      (part) =>
        part.type === "provider-data" &&
        part.provider === "azure-openai" &&
        part.data &&
        typeof part.data === "object" &&
        typeof (part.data as Record<string, unknown>).responseId === "string"
    );

    if (providerData?.type === "provider-data") {
      return {
        responseId: (providerData.data as { responseId: string }).responseId,
        index
      };
    }
  }

  return undefined;
};

const serializeToolOutput = (message: ModelMessage) =>
  message.parts
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "tool-result" }> => part.type === "tool-result")
    .map((part) => {
      if (part.toolResult.toolName === "shell") {
        return {
          type: "shell_call_output",
          call_id: part.toolResult.toolCallId,
          output: part.toolResult.isError
            ? {
                stdout: "",
                stderr: part.toolResult.error?.message ?? "Shell execution failed.",
                outcome: { type: "exit", exitCode: 1 }
              }
            : part.toolResult.output
        };
      }

      if (part.toolResult.toolName === "apply_patch") {
        const output = part.toolResult.output;
        const outputRecord =
          output && typeof output === "object" && !Array.isArray(output)
            ? (output as Record<string, unknown>)
            : undefined;
        return {
          type: "apply_patch_call_output",
          call_id: part.toolResult.toolCallId,
          status: part.toolResult.isError ? "failed" : outputRecord?.status ?? "completed",
          output: part.toolResult.isError ? part.toolResult.error?.message : outputRecord?.output
        };
      }

      return {
        type: "function_call_output",
        call_id: part.toolResult.toolCallId,
        output: JSON.stringify(part.toolResult.isError ? part.toolResult.error : part.toolResult.output ?? null)
      };
    });

const serializeProviderDataInput = (message: ModelMessage) =>
  message.parts
    .filter(
      (part): part is Extract<ModelMessage["parts"][number], { type: "provider-data" }> =>
        part.type === "provider-data" &&
        part.provider === "azure-openai" &&
        part.data !== null &&
        typeof part.data === "object" &&
        (part.data as Record<string, unknown>).type === "mcp_approval_response"
    )
    .map((part) => part.data as Record<string, unknown>);

const parseResponsesProviderData = (item: unknown) => {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const typedItem = item as Record<string, unknown>;
  if (
    typeof typedItem.type !== "string" ||
    ["message", "function_call", "shell_call", "apply_patch_call"].includes(typedItem.type)
  ) {
    return undefined;
  }

  return item as JsonValue;
};

const parseShellCallInput = (item: Record<string, unknown>) => {
  const action = item.action && typeof item.action === "object" ? (item.action as Record<string, unknown>) : undefined;
  return {
    command: typeof action?.command === "string" ? action.command : typeof item.command === "string" ? item.command : undefined,
    action: action as JsonValue | undefined,
    maxOutputLength:
      typeof action?.max_output_length === "number"
        ? action.max_output_length
        : typeof item.max_output_length === "number"
          ? item.max_output_length
          : typeof item.maxOutputLength === "number"
            ? item.maxOutputLength
            : undefined
  };
};

const parseApplyPatchCallInput = (item: Record<string, unknown>) => ({
  operation: item.operation && typeof item.operation === "object" ? (item.operation as JsonValue) : {}
});

const parseAssistantMessage = (message: any): ModelMessage => ({
  role: "assistant",
  parts: [
    ...(typeof message.content === "string" && message.content
      ? [{ type: "text", text: message.content } as const]
      : []),
    ...((message.tool_calls ?? []).map((call: any) => ({
      type: "tool-call" as const,
      toolCall: {
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments ?? "{}")
      }
    })) ?? [])
  ]
});

const toResponsesInput = (messages: ModelMessage[]) => {
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push(...serializeToolOutput(message));
      continue;
    }

    input.push(...serializeProviderDataInput(message));

    const content: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          content.push({ type: "input_text", text: part.text });
          break;
        case "image":
          content.push({ type: "input_image", image_url: imageInputToDataUrl(part) });
          break;
        case "tool-call":
          if (message.role === "assistant") {
            content.push({
              type: "function_call",
              call_id: part.toolCall.id,
              name: part.toolCall.name,
              arguments: JSON.stringify(part.toolCall.input)
            });
          }
          break;
      }
    }

    if (content.length) {
      input.push({
        role: message.role,
        content
      });
    }
  }

  return input;
};

const parseResponsesAssistantMessage = (json: any): ModelMessage => {
  const parts: ModelMessage["parts"] = [];

  for (const [index, item] of (json.output ?? []).entries()) {
    if (item?.type === "message") {
      for (const content of item.content ?? []) {
        if (typeof content?.text === "string" && content.text) {
          parts.push({ type: "text", text: content.text });
        }
      }
      continue;
    }

    if (item?.type === "function_call") {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: item.call_id ?? item.id ?? `${item.name}-${index}`,
          name: item.name,
          input: JSON.parse(item.arguments ?? "{}")
        }
      });
      continue;
    }

    if (item?.type === "shell_call") {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: item.call_id ?? item.id ?? `shell-${index}`,
          name: "shell",
          input: parseShellCallInput(item) as JsonValue
        }
      });
      continue;
    }

    if (item?.type === "apply_patch_call") {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: item.call_id ?? item.id ?? `apply_patch-${index}`,
          name: "apply_patch",
          input: parseApplyPatchCallInput(item) as JsonValue
        }
      });
      continue;
    }

    const providerData = parseResponsesProviderData(item);
    if (providerData) {
      parts.push(providerDataPart("azure-openai", providerData));
    }
  }

  if (!parts.some((part) => part.type === "text") && typeof json.output_text === "string" && json.output_text) {
    parts.push({ type: "text", text: json.output_text });
  }

  if (typeof json.id === "string") {
    parts.push({
      type: "provider-data",
      provider: "azure-openai",
      data: {
        responseId: json.id
      }
    });
  }

  return {
    role: "assistant",
    parts
  };
};

const normalizeResponsesFinishReason = (
  status: string | undefined,
  hasToolCalls: boolean,
  incompleteReason?: string
) => {
  if (hasToolCalls) {
    return "tool-calls" as const;
  }

  if (status === "completed") {
    return "stop" as const;
  }

  if (status === "failed") {
    return "error" as const;
  }

  if (status === "incomplete") {
    if (incompleteReason === "content_filter") {
      return "content-filter" as const;
    }
    if (incompleteReason === "max_output_tokens") {
      return "length" as const;
    }
  }

  return normalizeFinishReason(status);
};

const parseResponseArguments = (raw: string): JsonValue => {
  try {
    const value = raw ? JSON.parse(raw) as unknown : {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Azure OpenAI tool arguments must be a JSON object.");
    }
    return value as JsonValue;
  } catch (cause) {
    throw new ProviderToolCallError({
      provider: "azure-openai",
      transport: "responses",
      diagnosticCode: "AZURE_OPENAI_MALFORMED_TOOL_USE",
      reason: "invalid_json",
      retryable: false,
      effectsPossible: false,
      cause
    });
  }
};

const streamResponses = async function* (
  response: Response
): AsyncGenerator<StreamEvent, void, undefined> {
  const toolBuffers = new Map<string, { callId: string; name: string; args: string }>();
  const hostedCalls: Array<{ id: string; name: string; input: JsonValue }> = [];
  let sawTerminal = false;
  let providerEffectsPossible = false;

  const bufferTool = (key: string) => {
    const existing = toolBuffers.get(key) ?? { callId: key, name: "", args: "" };
    toolBuffers.set(key, existing);
    return existing;
  };

  const releaseCalls = function* () {
    for (const toolCall of toolBuffers.values()) {
      if (!toolCall.callId || !toolCall.name) {
        throw new ConfigurationError("Incomplete Azure OpenAI function call.");
      }
      yield {
        type: "tool-call",
        toolCall: {
          id: toolCall.callId,
          name: toolCall.name,
          input: parseResponseArguments(toolCall.args)
        }
      } satisfies StreamEvent;
    }
    for (const toolCall of hostedCalls) {
      yield { type: "tool-call", toolCall } satisfies StreamEvent;
    }
  };

  const interrupted = (error: unknown) => {
    if (error instanceof ProviderToolCallError || !providerEffectsPossible) {
      return error;
    }
    return new ProviderToolCallError({
      provider: "azure-openai",
      transport: "responses",
      diagnosticCode: "AZURE_OPENAI_STREAM_INTERRUPTED",
      reason: "stream_truncated",
      retryable: false,
      effectsPossible: true,
      cause: error
    });
  };

  try {
    for await (const event of streamSSE(response)) {
      if (event.data === "[DONE]") {
        break;
      }

      let json: Record<string, any>;
      try {
        json = JSON.parse(event.data) as Record<string, any>;
      } catch (cause) {
        throw new ConfigurationError("Azure OpenAI response stream event was not valid JSON.", { cause });
      }
      const type = json.type as string | undefined;

      if (type === "response.output_text.delta" && typeof json.delta === "string") {
        yield { type: "text-delta", textDelta: json.delta } satisfies StreamEvent;
        continue;
      }

      if (type === "error") {
        throw new ConfigurationError("Azure OpenAI reported a response stream error.");
      }

      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = json.item;
        if (item?.type === "function_call") {
          const key = item.id ?? json.item_id ?? `${json.output_index ?? toolBuffers.size}`;
          const existing = bufferTool(String(key));
          existing.callId = item.call_id ?? existing.callId;
          existing.name ||= item.name ?? "";
          if (typeof item.arguments === "string") {
            existing.args = item.arguments;
          }
        }

        if (item?.type === "shell_call" && type === "response.output_item.done") {
          hostedCalls.push({
            id: item.call_id ?? item.id ?? `${json.output_index ?? "shell"}`,
            name: "shell",
            input: parseShellCallInput(item) as JsonValue
          });
        }

        if (item?.type === "apply_patch_call" && type === "response.output_item.done") {
          hostedCalls.push({
            id: item.call_id ?? item.id ?? `${json.output_index ?? "apply_patch"}`,
            name: "apply_patch",
            input: parseApplyPatchCallInput(item) as JsonValue
          });
        }

        const providerData = parseResponsesProviderData(item);
        if (providerData && type === "response.output_item.done") {
          providerEffectsPossible = true;
          yield {
            type: "provider-data",
            provider: "azure-openai",
            data: providerData
          } satisfies StreamEvent;
        }
        continue;
      }

      if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
        const key = json.item_id ?? `${json.output_index ?? toolBuffers.size}`;
        const existing = bufferTool(String(key));
        if (type === "response.function_call_arguments.delta") {
          existing.args += typeof json.delta === "string" ? json.delta : "";
        } else if (typeof json.arguments === "string") {
          existing.args = json.arguments;
        }
        continue;
      }

      if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
        sawTerminal = true;
        const responseData = json.response ?? {};
        const status = typeof responseData.status === "string" ? responseData.status : type.slice("response.".length);
        const usage = azureUsage(responseData.usage);
        const incompleteReason = typeof responseData.incomplete_details?.reason === "string"
          ? responseData.incomplete_details.reason
          : undefined;
        if (status === "completed") {
          yield* releaseCalls();
        }
        yield {
          type: "finish",
          finishReason: normalizeResponsesFinishReason(status, status === "completed" && (toolBuffers.size > 0 || hostedCalls.length > 0), incompleteReason),
          providerFinishReason: status,
          usage
        } satisfies StreamEvent;
        if (status === "failed") {
          throw new ProviderToolCallError({
            provider: "azure-openai",
            transport: "responses",
            diagnosticCode: "AZURE_OPENAI_RESPONSE_FAILED",
            reason: "response_failed",
            retryable: false,
            effectsPossible: providerEffectsPossible,
            ...(usage ? { usage } : {})
          });
        }
        return;
      }
    }
  } catch (error) {
    throw interrupted(error);
  }

  if (!sawTerminal) {
    throw interrupted(new ConfigurationError("Azure OpenAI response stream ended without a terminal event."));
  }
};

const extractSources = (value: any): GroundedGenerateResult["sources"] => {
  const sources: GroundedGenerateResult["sources"] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (typeof node.url === "string") {
      sources.push({
        title: typeof node.title === "string" ? node.title : undefined,
        url: node.url,
        snippet: typeof node.snippet === "string" ? node.snippet : undefined,
        providerMetadata: node
      });
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  };

  visit(value);
  return sources.filter(
    (source, index, list) => list.findIndex((candidate) => candidate.url === source.url) === index
  );
};

class AzureOpenAILanguageModel implements LanguageModel<AzureOpenAILanguageModelOptions> {
  readonly provider = "azure-openai";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly auth: AzureAuth,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly resolveURL: (modelId: string, path: AzurePath) => string,
    private readonly baseModel: string
  ) {
    this.capabilities = modelCapabilities(baseModel);
  }

  resolveCapabilities(input: { providerOptions?: { baseModel?: string } }) {
    return modelCapabilities(this.resolvedModel(input));
  }

  private resolvedModel(input: { providerOptions?: { baseModel?: string } }) {
    const override = input.providerOptions?.baseModel;
    const model = typeof override === "string" && override.trim() ? override.trim() : this.baseModel;
    noteOpaqueDeployment(this.modelId, model);
    return model;
  }

  async generate(input: ModelGenerateInput<AzureOpenAILanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const resolvedModel = this.resolvedModel(input);
    try {
      if (useAzureResponses(resolvedModel, input)) {
        assertResponsesToolsSupported(resolvedModel, input.tools);
        const previousResponse = getProviderResponseId(input.messages);
        const messages =
          previousResponse && previousResponse.index < input.messages.length - 1
            ? input.messages.slice(previousResponse.index + 1)
            : input.messages;
        const response = await sendAzure(
          async () =>
            this.fetcher(this.resolveURL(this.modelId, "responses"), {
              method: "POST",
              headers: await this.auth.headers({ "content-type": "application/json" }),
              signal,
              body: JSON.stringify({
                ...azureResponsesBodyOptions(input),
                model: this.modelId,
                ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
                ...(messages.length ? { input: toResponsesInput(messages) } : {}),
                tools: mapResponsesTools(input.tools),
                tool_choice: typeof input.toolChoice === "object" ? { type: "function", name: input.toolChoice.toolName } : mapToolChoice(input.toolChoice),
                text: mapResponsesStructuredOutput(input),
                temperature: input.temperature,
                max_output_tokens: input.maxTokens,
                ...mapAzureResponsesReasoning(input)
              })
            }),
          { ...input, abortSignal: signal },
          this.auth.maxRetries
        );

        const json = await parseJson(response);
        const assistantMessage = parseResponsesAssistantMessage(json);
        const hasToolCalls = assistantMessage.parts.some((part) => part.type === "tool-call");

        return {
          messages: [assistantMessage],
          text: assistantMessage.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
          finishReason: normalizeResponsesFinishReason(json.status, hasToolCalls, json.incomplete_details?.reason),
          providerFinishReason: json.status,
          usage: azureUsage(json.usage),
          rawResponse: json
        };
      }

      const response = await sendAzure(
        async () =>
          this.fetcher(this.resolveURL(this.modelId, "chat/completions"), {
            method: "POST",
            headers: await this.auth.headers({ "content-type": "application/json" }),
            signal,
            body: JSON.stringify({
              ...azureBodyOptions(input),
              model: this.baseURL.endsWith("/openai/v1") ? this.modelId : undefined,
              messages: mapMessages(input.messages),
              tools: mapTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              ...chatTokenFields(resolvedModel, input),
              ...mapReasoning(input),
              stream: false
            })
          }),
        { ...input, abortSignal: signal },
        this.auth.maxRetries
      );

      const json = await parseJson(response);
      const choice = json.choices?.[0];
      const message = choice?.message ?? {};
      const assistantMessage = parseAssistantMessage(message);

      return {
        messages: [assistantMessage],
        text: assistantMessage.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
        finishReason: normalizeFinishReason(choice?.finish_reason),
        providerFinishReason: choice?.finish_reason,
        usage: azureUsage(json.usage),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput<AzureOpenAILanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const resolvedModel = this.resolvedModel(input);
    try {
      if (useAzureResponses(resolvedModel, input)) {
        assertResponsesToolsSupported(resolvedModel, input.tools);
        const response = await sendAzure(
          async () =>
            this.fetcher(this.resolveURL(this.modelId, "responses"), {
              method: "POST",
              headers: await this.auth.headers({ "content-type": "application/json" }),
              signal,
              body: JSON.stringify({
                ...azureResponsesBodyOptions(input),
                model: this.modelId,
                input: toResponsesInput(input.messages),
                tools: mapResponsesTools(input.tools),
                tool_choice: typeof input.toolChoice === "object" ? { type: "function", name: input.toolChoice.toolName } : mapToolChoice(input.toolChoice),
                text: mapResponsesStructuredOutput(input),
                temperature: input.temperature,
                max_output_tokens: input.maxTokens,
                ...mapAzureResponsesReasoning(input),
                stream: true
              })
            }),
          { ...input, abortSignal: signal },
          this.auth.maxRetries
        );

        return (async function* () {
          try {
            yield* streamResponses(response);
          } finally {
            await response.body?.cancel().catch(() => {});
            cleanup();
          }
        })();
      }

      const response = await sendAzure(
        async () =>
          this.fetcher(this.resolveURL(this.modelId, "chat/completions"), {
            method: "POST",
            headers: await this.auth.headers({ "content-type": "application/json" }),
            signal,
            body: JSON.stringify({
              ...azureBodyOptions(input),
              model: this.baseURL.endsWith("/openai/v1") ? this.modelId : undefined,
              messages: mapMessages(input.messages),
              tools: mapTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              ...chatTokenFields(resolvedModel, input),
              ...mapReasoning(input),
              stream: true,
              stream_options: { include_usage: true }
            })
          }),
        { ...input, abortSignal: signal },
        this.auth.maxRetries
      );

      return (async function* () {
        try {
          yield* streamChatCompletions(response, "azure-openai");
        } finally {
          cleanup();
        }
      })();
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}

class AzureOpenAIEmbeddingModel implements EmbeddingModel {
  readonly provider = "azure-openai";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly auth: AzureAuth,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly resolveURL: (modelId: string, path: AzurePath) => string
  ) {}

  async embed(input: EmbedInput & { abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<EmbedResult> {
    const values = input.values.map((value) => {
      if (typeof value !== "string") {
        throw new UnsupportedFeatureError('Provider "azure-openai" does not support multimodal embedding values.');
      }
      return value;
    });

    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await sendAzure(
        async () =>
          this.fetcher(this.resolveURL(this.modelId, "embeddings"), {
            method: "POST",
            headers: await this.auth.headers({ "content-type": "application/json" }),
            signal,
            body: JSON.stringify({
              model: this.baseURL.endsWith("/openai/v1") ? this.modelId : undefined,
              input: values
            })
          }),
        { ...input, abortSignal: signal },
        this.auth.maxRetries
      );

      const json = await parseJson(response);
      return {
        embeddings: json.data.map((entry: any) => entry.embedding),
        usage: {
          inputTokens: json.usage?.prompt_tokens,
          totalTokens: json.usage?.total_tokens
        },
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class AzureOpenAITranscriptionModel implements TranscriptionModel {
  readonly provider = "azure-openai";
  readonly capabilities = transcriptionCapabilities;

  constructor(
    readonly modelId: string,
    private readonly auth: AzureAuth,
    private readonly urlResolver: (modelId: string, path: AzurePath) => string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly responseLimits = resolveAudioResponseLimits()
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
    const { signal, cleanup, abort } = withTimeoutSignal(input);
    const form = new FormData();
    for (const [key, value] of Object.entries(input.providerOptions ?? {})) {
      if (["model", "file", "prompt", "language"].includes(key)) {
        continue;
      }
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    form.set("file", createAudioFile(input.audio));
    form.set("model", this.modelId);
    if (input.prompt) {
      form.set("prompt", input.prompt);
    }
    if (input.language) {
      form.set("language", input.language);
    }

    try {
      const response = await sendAzure(
        async () =>
          this.fetcher(this.urlResolver(this.modelId, "audio/transcriptions"), {
            method: "POST",
            redirect: "error",
            headers: await this.auth.headers(),
            signal,
            body: form
          }),
        input,
        this.auth.maxRetries
      );

      const json = await parseJson(response, {
        maxBytes: this.responseLimits.transcriptionBytes,
        errorBodyBytes: this.responseLimits.errorBodyBytes,
        endpoint: "audio/transcriptions",
        abort
      });
      return {
        text: json.text ?? "",
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class AzureOpenAISpeechModel implements SpeechModel {
  readonly provider = "azure-openai";
  readonly capabilities = speechCapabilities;

  constructor(
    readonly modelId: string,
    private readonly auth: AzureAuth,
    private readonly urlResolver: (modelId: string, path: AzurePath) => string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly responseLimits = resolveAudioResponseLimits()
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
    const { signal, cleanup, abort } = withTimeoutSignal(input);

    try {
      const response = await sendAzure(
        async () =>
          this.fetcher(this.urlResolver(this.modelId, "audio/speech"), {
            method: "POST",
            headers: await this.auth.headers({ "content-type": "application/json" }),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              model: this.modelId,
              input: input.input,
              voice: input.voice ?? "alloy"
            })
          }),
        input,
        this.auth.maxRetries
      );

      if (!response.ok) {
        const body = await readErrorBodyWithLimit(response, this.responseLimits.errorBodyBytes);
        throw classifyAzureError(new ProviderHTTPError(`Azure OpenAI request failed with status ${response.status}.`, response.status, {
          responseBody: body
        }));
      }

      return {
        audio: await readBodyWithLimit(response, {
          maxBytes: this.responseLimits.speechBytes,
          provider: "azure-openai",
          endpoint: "audio/speech",
          abort
        }),
        mediaType: response.headers.get("content-type") ?? "audio/mpeg",
        rawResponse: undefined
      };
    } finally {
      cleanup();
    }
  }
}

class AzureOpenAIGroundedLanguageModel implements GroundedLanguageModel {
  readonly provider = "azure-openai";
  readonly capabilities = groundedCapabilities;

  constructor(
    readonly modelId: string,
    private readonly auth: AzureAuth,
    private readonly urlResolver: (modelId: string, path: AzurePath) => string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generate(input: {
    messages: ModelMessage[];
    temperature?: number;
    maxTokens?: number;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<GroundedGenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await sendAzure(
        async () =>
          this.fetcher(this.urlResolver(this.modelId, "responses"), {
            method: "POST",
            headers: await this.auth.headers({ "content-type": "application/json" }),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              model: this.modelId,
              input: toResponsesInput(input.messages),
              tools: [{ type: "web_search_preview" }],
              temperature: input.temperature,
              max_output_tokens: input.maxTokens
            })
          }),
        input,
        this.auth.maxRetries
      );

      const json = await parseJson(response);
      return {
        text: json.output_text ?? "",
        sources: extractSources(json),
        usage: azureUsage(json.usage),
        finishReason: normalizeFinishReason(json.status),
        providerFinishReason: json.status,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class AzureOpenAIRealtimeModel implements RealtimeModel {
  readonly provider = "azure-openai";
  readonly capabilities = realtimeCapabilities;

  constructor(
    readonly modelId: string,
    private readonly auth: AzureAuth,
    private readonly endpoint: string,
    private readonly apiVersion: string | undefined,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly connectionFactory?: RealtimeConnectionFactory,
    private readonly realtimeURL?: string,
    private readonly browserTokenURL?: string,
    private readonly allowUnsafeEndpoints = false
  ) {}

  async connect(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions) {
    const providerOptions = (config.providerOptions ?? {}) as Record<string, unknown>;
    const url = assertTrustedEndpoint(
      azureOpenAIRealtimeURL(
        this.endpoint,
        this.modelId,
        this.apiVersion,
        this.realtimeURL ?? (typeof providerOptions.realtime_url === "string" ? providerOptions.realtime_url : undefined)
      ),
      {
        label: "Azure OpenAI realtime endpoint",
        protocols: ["wss"],
        allowedHosts: [new URL(this.realtimeURL ?? this.endpoint).hostname],
        allowUnsafe: this.allowUnsafeEndpoints
      }
    );
    const connection = await (this.connectionFactory ?? openWebSocketConnection)(
      url.toString(),
      await this.auth.headers(),
      options
    );

    const session = new CallbackRealtimeSession({
      provider: this.provider,
      modelId: this.modelId,
      capabilities: this.capabilities,
      config: {
        autoResponse: true,
        ...config
      },
      connection,
      callbacks: {
        parseEvent: parseAzureRealtimeEvent,
        buildAudioPayloads: (frame, sessionConfig) => {
          const payloads: Array<Record<string, unknown>> = [{ type: "input_audio_buffer.append", audio: encodeAudioFrame(frame) }];
          if (frame.isFinal) {
            payloads.push({ type: "input_audio_buffer.commit" });
            if (sessionConfig.autoResponse ?? true) {
              payloads.push({ type: "response.create" });
            }
          }
          return payloads;
        },
        buildMediaPayloads: (frame) => {
          if (!frame.mediaType.startsWith("image/")) {
            throw new UnsupportedFeatureError(
              `Provider "azure-openai" only supports realtime image media input, but received "${frame.mediaType}".`
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
        buildUpdatePayloads: (sessionConfig) => [{ type: "session.update", session: mapRealtimeSessionConfig(sessionConfig, this.modelId) }],
        buildInitialPayloads: (sessionConfig) => [{ type: "session.update", session: mapRealtimeSessionConfig(sessionConfig, this.modelId) }]
      }
    });
    await session.initialize();
    return session;
  }

  async createBrowserToken(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions): Promise<RealtimeTokenResult> {
    const providerOptions = { ...((config.providerOptions ?? {}) as Record<string, unknown>) };
    const expiresAfter = providerOptions.expires_after;
    delete providerOptions.expires_after;

    const url = this.browserTokenURL ?? `${this.endpoint}/openai/v1/realtime/client_secrets`;
    const { signal, cleanup } = withTimeoutSignal({
      abortSignal: options?.signal,
      timeoutMs: options?.timeoutMs
    });
    try {
      const response = await sendAzure(
        async () =>
          this.fetcher(url, {
            method: "POST",
            redirect: "error",
            headers: await this.auth.headers({ "content-type": "application/json" }),
            body: JSON.stringify({
              ...(expiresAfter ? { expires_after: expiresAfter } : {}),
              session: mapRealtimeSessionConfig(
                {
                  ...config,
                  providerOptions
                },
                this.modelId
              )
            }),
            signal
          }),
        { abortSignal: signal, timeoutMs: options?.timeoutMs },
        this.auth.maxRetries
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

const normalizeEndpoint = (endpoint: string) => endpoint.replace(/\/+$/, "");
type AzurePath = "chat/completions" | "embeddings" | "audio/transcriptions" | "audio/speech" | "responses";

const encodeAzureDeployment = (value: string) => {
  if (!value || value === "." || value === ".." || /[\\/?#\s]/.test(value)) {
    throw new ConfigurationError("Azure OpenAI deployment name must be a non-empty opaque identifier without path separators.");
  }
  return encodeURIComponent(value);
};

export const createAzureOpenAI = (
  options: AzureOpenAIProviderOptions = {}
): CallableProviderAdapter<LanguageModel<AzureOpenAILanguageModelOptions>> & {
  rawFetch: typeof globalThis.fetch;
} => {
  if (options.tokenProvider && options.apiKey) {
    throw new ConfigurationError("Azure OpenAI tokenProvider and apiKey are mutually exclusive.");
  }
  const apiKey = options.tokenProvider ? undefined : options.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
  if (!options.tokenProvider && !apiKey) {
    throw new ConfigurationError("Missing Azure OpenAI API key.");
  }
  if (options.maxRetries !== undefined && (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0)) {
    throw new ConfigurationError('Azure OpenAI "maxRetries" must be a non-negative safe integer.');
  }
  const auth: AzureAuth = {
    maxRetries: options.maxRetries ?? 2,
    headers: async (extra = {}) => {
      if (options.tokenProvider) {
        const token = await options.tokenProvider();
        if (!token) {
          throw new ConfigurationError("Azure OpenAI token provider returned an empty token.");
        }
        return { ...extra, authorization: `Bearer ${token}` };
      }
      return { ...extra, "api-key": apiKey! };
    }
  };

  const endpoint = options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) {
    throw new ConfigurationError("Missing Azure OpenAI endpoint.");
  }

  const normalizedTrustedEndpoint = assertTrustedEndpoint(endpoint, {
    label: "Azure OpenAI endpoint",
    protocols: ["https"],
    allowUnsafe: options.allowUnsafeEndpoints
  }).toString().replace(/\/+$/, "");
  const trustedHost = new URL(normalizedTrustedEndpoint).hostname;
  const realtimeURL = options.realtimeURL
    ? assertTrustedEndpoint(options.realtimeURL, {
        label: "Azure OpenAI realtimeURL",
        protocols: ["wss"],
        allowedHosts: [trustedHost],
        allowUnsafe: options.allowUnsafeEndpoints
      }).toString()
    : undefined;
  const browserTokenURL = options.browserTokenURL
    ? assertTrustedEndpoint(options.browserTokenURL, {
        label: "Azure OpenAI browserTokenURL",
        protocols: ["https"],
        allowedHosts: [trustedHost],
        allowUnsafe: options.allowUnsafeEndpoints
      }).toString()
    : undefined;
  const apiVersion = options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION;
  const baseURL = apiVersion
    ? `${normalizedTrustedEndpoint}/openai/deployments/{deployment}?api-version=${encodeURIComponent(apiVersion)}`
    : `${normalizedTrustedEndpoint}/openai/v1`;
  const rawFetch = options.fetch ?? globalThis.fetch;
  const fetcher = rejectCredentialedRedirects(rawFetch);
  const responseLimits = resolveAudioResponseLimits(options.responseLimits);

  const resolveURL = (modelId: string, path: AzurePath) => {
    if (path === "responses") {
      return `${normalizedTrustedEndpoint}/openai/v1/responses`;
    }
    return baseURL.includes("{deployment}")
      ? baseURL.replace("{deployment}", encodeAzureDeployment(modelId)).replace(/\?api-version=.*$/, `/${path}?api-version=${encodeURIComponent(apiVersion!)}`)
      : `${baseURL}/${path}`;
  };
  const baseModelFor = (modelId: string) => options.deployments?.[modelId]?.model ?? modelId;

  return createProviderAdapter({
    name: "azure-openai",
    languageModel: (modelId) =>
      new AzureOpenAILanguageModel(modelId, auth, baseURL, fetcher, resolveURL, baseModelFor(modelId)),
    embeddingModel: (modelId) =>
      new AzureOpenAIEmbeddingModel(modelId, auth, baseURL, fetcher, resolveURL),
    transcriptionModel: (modelId) => new AzureOpenAITranscriptionModel(modelId, auth, resolveURL, fetcher, responseLimits),
    speechModel: (modelId) => new AzureOpenAISpeechModel(modelId, auth, resolveURL, fetcher, responseLimits),
    realtimeModel: (modelId) =>
      new AzureOpenAIRealtimeModel(
        modelId,
        auth,
        normalizedTrustedEndpoint,
        apiVersion,
        fetcher,
        options.realtimeConnectionFactory,
        realtimeURL,
        browserTokenURL,
        options.allowUnsafeEndpoints
      ),
    groundedLanguageModel: (modelId) => new AzureOpenAIGroundedLanguageModel(modelId, auth, resolveURL, fetcher),
    rawFetch
  });
};

export const azureOpenAIWebSearchTool = (config: AzureOpenAIWebSearchToolConfig = {}) =>
  hostedTool({
    name: "web_search",
    provider: "azure-openai",
    type: config.type ?? "web_search_preview",
    toolClass: "web-search",
    config: normalizeWebSearchConfig(config) as unknown as JsonValue
  });

export const azureOpenAIFileSearchTool = (config: AzureOpenAIFileSearchToolConfig = {}) =>
  hostedTool({
    name: "file_search",
    provider: "azure-openai",
    type: "file_search",
    toolClass: "file-search",
    config: config as unknown as JsonValue
  });

export const azureOpenAICodeInterpreterTool = (config: AzureOpenAICodeInterpreterToolConfig) =>
  hostedTool({
    name: "code_interpreter",
    provider: "azure-openai",
    type: "code_interpreter",
    toolClass: "code-execution",
    config: config as unknown as JsonValue
  });

export const azureOpenAIToolSearchTool = (config: AzureOpenAIToolSearchToolConfig = {}) =>
  hostedTool({
    name: "tool_search",
    provider: "azure-openai",
    type: "tool_search",
    toolClass: "tool-search",
    config: config as unknown as JsonValue
  });

export const azureOpenAIRemoteMcpTool = (config: AzureOpenAIRemoteMcpToolConfig) =>
  hostedTool({
    name: config.server_label ?? "mcp",
    provider: "azure-openai",
    type: "mcp",
    toolClass: "remote-mcp",
    requiresApproval: config.require_approval !== "never",
    config: config as unknown as JsonValue
  });

export const azureOpenAIMcpApprovalResponse = (response: Omit<AzureOpenAIMcpApprovalResponse, "type">) =>
  providerDataPart("azure-openai", {
    type: "mcp_approval_response",
    ...response
  });

export const azureOpenAIComputerUseTool = (config: AzureOpenAIComputerUseToolConfig) =>
  hostedTool({
    name: "computer",
    provider: "azure-openai",
    type: "computer_use_preview",
    toolClass: "computer-use",
    config: config as unknown as JsonValue
  });

const runAzureOpenAIShellCommand = async (
  input: AzureOpenAIShellToolInput,
  config: AzureOpenAIShellToolConfig
): Promise<AzureOpenAIShellToolOutput> => {
  if (config.execute) {
    return config.execute(input);
  }

  const command = input.command ?? input.action?.command;
  if (!command) {
    throw new Error("Azure OpenAI shell tool did not provide a command.");
  }

  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  const maxBuffer = Math.max(1024, config.maxOutputLength ?? input.maxOutputLength ?? input.max_output_length ?? input.action?.maxOutputLength ?? input.action?.max_output_length ?? 20000);
  const cwd = config.rootDir
    ? await assertAzureOpenAIToolPathInsideRoot(config.rootDir, config.cwd ?? ".", "shell cwd")
    : config.cwd;

  try {
    const result = await execAsync(command, {
      cwd,
      timeout: config.timeoutMs,
      maxBuffer
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      outcome: {
        type: "exit",
        exitCode: 0
      },
      maxOutputLength: maxBuffer
    };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      signal?: string;
      killed?: boolean;
      message?: string;
    };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      outcome: {
        type: err.killed || err.signal === "SIGTERM" ? "timeout" : "exit",
        exitCode: typeof err.code === "number" ? err.code : 1
      },
      maxOutputLength: maxBuffer
    };
  }
};

export const azureOpenAIShellTool = (
  config: AzureOpenAIShellToolConfig = {}
): ToolDefinition<z.ZodType<AzureOpenAIShellToolInput>, JsonValue> => ({
  name: config.name ?? "shell",
  description: "Run a shell command requested by the Azure OpenAI Responses shell tool.",
  requiresApproval: true,
  metadata: {
    [azureOpenAIResponsesToolMetadataKey]: "shell",
    "azure-openai.responses_tool_config": {}
  },
  schema: z.object({
    command: z.string().optional(),
    action: z
      .object({
        command: z.string().optional(),
        max_output_length: z.number().optional(),
        maxOutputLength: z.number().optional()
      })
      .passthrough()
      .optional(),
    maxOutputLength: z.number().optional(),
    max_output_length: z.number().optional()
  }) as z.ZodType<AzureOpenAIShellToolInput>,
  execute: async (input) => runAzureOpenAIShellCommand(input, config) as unknown as JsonValue
});

const applyAzureOpenAIPatchOperation = async (
  operation: AzureOpenAIApplyPatchOperation,
  config: AzureOpenAIApplyPatchToolConfig
) => {
  if (config.rootDir) {
    await assertAzureOpenAIToolPathInsideRoot(config.rootDir, operation.path, "apply_patch");
  }

  return config.applyOperation(operation);
};

export const azureOpenAIApplyPatchTool = (
  config: AzureOpenAIApplyPatchToolConfig
): ToolDefinition<z.ZodType<AzureOpenAIApplyPatchToolInput>, JsonValue> => ({
  name: config.name ?? "apply_patch",
  description: "Apply a structured patch operation requested by the Azure OpenAI Responses apply_patch tool.",
  requiresApproval: true,
  metadata: {
    [azureOpenAIResponsesToolMetadataKey]: "apply_patch",
    "azure-openai.responses_tool_config": {}
  },
  schema: z.object({
    operation: z
      .object({
        type: z.enum(["create_file", "update_file", "delete_file"]),
        path: z.string(),
        diff: z.string().optional()
      })
      .passthrough()
  }) as z.ZodType<AzureOpenAIApplyPatchToolInput>,
  execute: async ({ operation }) => applyAzureOpenAIPatchOperation(operation, config) as unknown as JsonValue
});
