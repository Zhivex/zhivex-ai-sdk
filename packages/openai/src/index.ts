import { computerInputSchema, computerScreenshotSchema } from "./computer.js";
export { openAIComputerTool, OpenAIComputerExecutionError } from "./computer.js";
export type { OpenAIComputerExecutionContext, OpenAIComputerAction, OpenAIComputerSafetyCheck, OpenAIComputerCallInput, OpenAIComputerScreenshotOutput, OpenAIComputerToolConfig } from "./computer.js";
import { jsonHeaders, parseJson, RESERVED_REQUEST_HEADERS } from "./http.js";
import { OpenAIRealtimeModel, openAIRealtimeMcpMetadataKey, resolveOpenAIRealtimeHeaders } from "./realtime.js";
export { openAIRealtimeMcpMetadataKey } from "./realtime.js";
import { OpenAIEmbeddingModel, OpenAITranscriptionModel, OpenAISpeechModel, toUint8Array } from "./resource-models.js";
import { OpenAIAgentsClient } from "./agents.js";
export { OpenAIAgentsClient } from "./agents.js";
export type { OpenAIAgentSessionInput, OpenAIAgentSession, OpenAIAgentEvent, OpenAIAgentsPage, OpenAIAgentsRequestOptions } from "./agents.js";
import { toJSONSchema, z } from "zod";
import { OpenAILiveModel, isOpenAILiveModel } from "./live.js";

import {
  createOpenAIImageGenerationModel,
  normalizeOpenAIImageGenerationCall,
  normalizeOpenAIImageGenerationPartialImage,
  type OpenAIImageOutputFormat
} from "./image-generation.js";
import {
  capabilities,
  groundedCapabilities,
  supportsOpenAIModernResponses,
  assertOpenAIModelRequestSupported,
  resolveOpenAIModelProfile,
  modelCapabilities
} from "./capabilities.js";

import {
  imageInputToDataUrl,
  ConfigurationError,
  ProviderHTTPError,
  ProviderResponseTooLargeError,
  ProviderToolCallError,
  assertTrustedEndpoint,
  resolveAudioResponseLimits,
  openWebSocketConnection,
  hostedTool,
  providerDataPart,
  UnsupportedFeatureError,
  createProviderAdapter,
  isCallableToolDefinition,
  isHostedToolDefinition,
  normalizeFinishReason,
  streamSSE,
  streamChatCompletions,
  toolResultPayload,
  withRetry,
  withResponseRetry,
  withTimeoutSignal,
  type AudioResponseLimits,
  type CallableProviderAdapter,
  type GeneratedMedia,
  type GenerateResult,
  type GroundedGenerateResult,
  type GroundedLanguageModel,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type RealtimeConnectionFactory,
  type StreamEvent,
  type ToolCall,
  type ToolDefinition,
  type ToolExecutionResult
} from "@zhivex-ai/core/provider";

const MIB = 1024 * 1024;
const DEFAULT_HOSTED_IMAGE_EVENT_BYTES = 32 * MIB;
const DEFAULT_HOSTED_IMAGE_TOTAL_BYTES = 128 * MIB;
const DEFAULT_TOOL_CALL_ARGUMENT_CHARS = MIB;
const HOSTED_IMAGE_EVENT_JSON_OVERHEAD_CHARS = MIB;

export const OPENAI_RESPONSES_TOOL_CALL_ERROR_CODE = "OPENAI_RESPONSES_TOOL_CALL_INVALID" as const;

export interface OpenAIResponseLimits extends AudioResponseLimits {
  /** Maximum decoded bytes in one hosted image partial or final SSE event. Defaults to 32 MiB. */
  hostedImageEventBytes?: number;
  /** Maximum decoded hosted image bytes across one Responses SSE stream. Defaults to 128 MiB. */
  hostedImageTotalBytes?: number;
  /** Maximum assembled characters for one Responses function call. Defaults to 1 MiB. */
  toolCallArgumentChars?: number;
}

type ResolvedOpenAIResponseLimits = ReturnType<typeof resolveAudioResponseLimits> & {
  hostedImageEventBytes: number;
  hostedImageTotalBytes: number;
  toolCallArgumentChars: number;
};

const normalizeOpenAIResponseLimit = (value: number | undefined, fallback: number, name: string) => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ConfigurationError(`The "${name}" response limit must be a positive safe integer.`);
  }
  return resolved;
};

const resolveOpenAIResponseLimits = (limits: OpenAIResponseLimits = {}): ResolvedOpenAIResponseLimits => ({
  ...resolveAudioResponseLimits(limits),
  hostedImageEventBytes: normalizeOpenAIResponseLimit(
    limits.hostedImageEventBytes,
    DEFAULT_HOSTED_IMAGE_EVENT_BYTES,
    "hostedImageEventBytes"
  ),
  hostedImageTotalBytes: normalizeOpenAIResponseLimit(
    limits.hostedImageTotalBytes,
    DEFAULT_HOSTED_IMAGE_TOTAL_BYTES,
    "hostedImageTotalBytes"
  ),
  toolCallArgumentChars: normalizeOpenAIResponseLimit(
    limits.toolCallArgumentChars,
    DEFAULT_TOOL_CALL_ARGUMENT_CHARS,
    "toolCallArgumentChars"
  )
});

const openAIResponsesToolCallError = (
  reason: ConstructorParameters<typeof ProviderToolCallError>[0]["reason"],
  effectsPossible = false
) => new ProviderToolCallError({
  provider: "openai",
  transport: "responses",
  diagnosticCode: OPENAI_RESPONSES_TOOL_CALL_ERROR_CODE,
  reason,
  retryable: !effectsPossible,
  effectsPossible
});

export interface OpenAIProviderOptions {
  apiKey?: string;
  /** Conservative defaults for unrecognized IDs; legacy restores historical capability assumptions. */
  unknownModelCapabilities?: "conservative" | "legacy";
  /** Explicit capability declarations keyed by model ID, for private deployments or new models. */
  modelCapabilities?: Record<string, Omit<Partial<ModelCapabilities>, "agentCapabilities"> & {
    agentCapabilities?: Partial<NonNullable<ModelCapabilities["agentCapabilities"]>>;
  }>;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  realtimeURL?: string;
  browserTokenURL?: string;
  realtimeConnectionFactory?: RealtimeConnectionFactory;
  responseLimits?: OpenAIResponseLimits;
  /** Allow non-HTTPS/private or cross-origin credentialed endpoint overrides. Server-side only. */
  allowUnsafeEndpoints?: boolean;
}

export interface OpenAIRealtimeProviderOptions {
  /** Additional headers for the Realtime connection or client-secret request. */
  headers?: Record<string, string>;
  /** Stable, privacy-preserving end-user identifier sent as OpenAI-Safety-Identifier. */
  safety_identifier?: string;
  /** Override the WebSocket URL for this session. */
  realtime_url?: string;
  /** Additional query parameters for the Realtime WebSocket URL. */
  realtime_query?: Record<string, string | number | boolean>;
  /** Client-secret expiration settings passed at the request top level. */
  expires_after?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenAIWebSearchToolConfig {
  type?: "web_search" | "web_search_2025_08_26";
  search_context_size?: "small" | "medium" | "large" | "low" | "high";
  user_location?: {
    type: "approximate";
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
  filters?: {
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
  external_web_access?: boolean;
}

export interface OpenAIFileSearchToolConfig {
  vector_store_ids?: string[];
  max_num_results?: number;
  ranking_options?: Record<string, unknown>;
  filters?: Record<string, unknown>;
}

export interface OpenAIMcpToolFilter {
  read_only?: boolean;
  tool_names?: string[];
}

export type OpenAIMcpAllowedTools = string[] | OpenAIMcpToolFilter;
export type OpenAIMcpRequireApproval =
  | "never"
  | "always"
  | {
      always?: OpenAIMcpToolFilter;
      never?: OpenAIMcpToolFilter;
    };

export type OpenAIConnectorId =
  | "connector_dropbox"
  | "connector_gmail"
  | "connector_googlecalendar"
  | "connector_googledrive"
  | "connector_microsoftteams"
  | "connector_outlookcalendar"
  | "connector_outlookemail"
  | "connector_sharepoint";

type OpenAIRemoteMcpToolSharedConfig = {
  server_label?: string;
  server_description?: string;
  headers?: Record<string, string>;
  authorization?: string;
  require_approval?: OpenAIMcpRequireApproval;
  allowed_tools?: OpenAIMcpAllowedTools;
  allowed_callers?: OpenAIProgrammaticToolCaller[];
};

export type OpenAIRemoteMcpToolConfig =
  | (OpenAIRemoteMcpToolSharedConfig & {
      server_url: string;
      connector_id?: never;
    })
  | (OpenAIRemoteMcpToolSharedConfig & {
      server_url?: never;
      connector_id: OpenAIConnectorId;
    });

export interface OpenAIComputerUseToolConfig {
  environment: "browser" | "mac" | "windows" | "linux" | "ubuntu";
  display_width?: number;
  display_height?: number;
}

export interface OpenAICodeInterpreterToolConfig {
  container:
    | string
    | {
        type: "auto";
        memory_limit?: "1g" | "4g" | "16g" | "64g";
        file_ids?: string[];
      };
  allowed_callers?: OpenAIProgrammaticToolCaller[];
}

export interface OpenAIShellToolConfig {
  name?: string;
  cwd?: string;
  rootDir?: string;
  timeoutMs?: number;
  maxOutputLength?: number;
  allowedCallers?: OpenAIProgrammaticToolCaller[];
  environment?: OpenAILocalShellEnvironment;
  execute?: (
    input: OpenAIShellToolInput
  ) => Promise<OpenAIShellToolOutput | OpenAIShellToolOutput[]> | OpenAIShellToolOutput | OpenAIShellToolOutput[];
}

export type OpenAIHostedShellEnvironment =
  | {
      type: "container_auto";
      skills?: Array<{ type: "skill_reference"; skill_id: string; version?: number | "latest" }>;
      network_policy?: OpenAIHostedShellNetworkPolicy;
    }
  | {
      type: "container_reference";
      container_id: string;
      skills?: Array<{ type: "skill_reference"; skill_id: string; version?: number | "latest" }>;
      network_policy?: OpenAIHostedShellNetworkPolicy;
    };

export interface OpenAIHostedShellNetworkPolicy {
  type: "allowlist";
  allowed_domains: string[];
  domain_secrets?: Array<{ domain: string; name: string; value: string }>;
}

export interface OpenAILocalShellEnvironment {
  type: "local";
  skills?: Array<{ name: string; description?: string; path: string }>;
}

export type OpenAIShellEnvironment = OpenAIHostedShellEnvironment | OpenAILocalShellEnvironment;

export interface OpenAIHostedShellToolConfig {
  environment: OpenAIHostedShellEnvironment;
  allowedCallers?: OpenAIProgrammaticToolCaller[];
}

export interface OpenAIShellToolInput {
  command?: string;
  action?: {
    command?: string;
    commands?: string[];
    timeout_ms?: number;
    max_output_length?: number;
    maxOutputLength?: number;
  };
  maxOutputLength?: number;
  max_output_length?: number;
}

export interface OpenAIShellToolOutput {
  stdout: string;
  stderr: string;
  outcome: {
    type: "exit" | "timeout";
    exitCode?: number;
    exit_code?: number;
  };
  maxOutputLength?: number;
}

export interface OpenAIApplyPatchOperation {
  type: "create_file" | "update_file" | "delete_file";
  path: string;
  diff?: string;
}

export interface OpenAIApplyPatchToolConfig {
  name?: string;
  rootDir?: string;
  allowedCallers?: OpenAIProgrammaticToolCaller[];
  applyOperation: (operation: OpenAIApplyPatchOperation) => Promise<OpenAIApplyPatchToolOutput> | OpenAIApplyPatchToolOutput;
}

export interface OpenAIApplyPatchToolInput {
  operation: OpenAIApplyPatchOperation;
}

export interface OpenAIApplyPatchToolOutput {
  status: "completed" | "failed";
  output?: string;
}

export interface OpenAIToolSearchToolConfig {
  [key: string]: unknown;
}

export type OpenAIProgrammaticToolCaller = "direct" | "programmatic";

export interface OpenAIProgrammaticToolOptions {
  allowedCallers?: OpenAIProgrammaticToolCaller[];
  outputSchema?: z.ZodTypeAny;
}

export interface OpenAIPromptCacheOptions {
  mode?: "implicit" | "explicit";
  ttl?: "30m";
}

export interface OpenAIMultiAgentOptions {
  enabled: boolean;
  max_concurrent_subagents?: number;
}

const openAIResponsesToolMetadataKey = "openai.responses_tool_type";
const openAIResponsesFunctionConfigMetadataKey = "openai.responses_function_config";

const openAIResponsesFunctionConfig = (tool: ToolDefinition) => {
  const config = tool.metadata?.[openAIResponsesFunctionConfigMetadataKey];
  return config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : undefined;
};

const openAILocalResponsesToolType = (tool: ToolDefinition) => {
  const type = tool.metadata?.[openAIResponsesToolMetadataKey];
  return typeof type === "string" ? type : undefined;
};

const openAILocalResponsesToolConfig = (tool: ToolDefinition) => {
  const config = tool.metadata?.["openai.responses_tool_config"];
  return config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : undefined;
};

const assertOpenAIToolPathInsideRoot = async (rootDir: string | undefined, targetPath: string, label: string) => {
  if (!rootDir) {
    return targetPath;
  }

  const path = await import("node:path");
  const root = path.resolve(rootDir);
  const target = path.resolve(root, targetPath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`OpenAI ${label} path escapes rootDir.`);
  }

  return target;
};

export interface OpenAIMcpApprovalRequest {
  type: "mcp_approval_request";
  id: string;
  arguments: string;
  name: string;
  server_label: string;
}

export interface OpenAIMcpApprovalResponse {
  type: "mcp_approval_response";
  approval_request_id: string;
  approve: boolean;
  id?: string;
  reason?: string;
}

export interface OpenAIMcpCall {
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

export interface OpenAIMcpListTools {
  type: "mcp_list_tools";
  id?: string;
  server_label?: string;
  tools?: JsonValue;
}

export interface OpenAIRealtimeMcpMetadata {
  type: "mcp_list_tools" | "mcp_approval_request" | "mcp_approval_response" | "mcp_call";
  status:
    | "in_progress"
    | "completed"
    | "failed"
    | "approval_required"
    | "approved"
    | "rejected"
    | "arguments_delta"
    | "arguments_done";
  item_id?: string;
  approval_request_id?: string;
  server_label?: string;
  name?: string;
  approve?: boolean;
  reason?: string;
  arguments?: JsonValue;
  delta?: JsonValue;
  tools?: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  raw_event?: JsonValue;
}

export interface OpenAIRealtimeMcpApprovalResultOptions {
  approvalRequestId: string;
  name: string;
  approve: boolean;
  reason?: string;
  itemId?: string;
}

export interface OpenAIPromptCacheBreakpointData {
  type: "prompt_cache_breakpoint";
  mode: "explicit";
}

export interface OpenAIResponsesOutputData {
  type: "responses_output";
  items: JsonValue[];
}

export type OpenAIProviderData =
  | { responseId: string }
  | OpenAIMcpApprovalRequest
  | OpenAIMcpApprovalResponse
  | OpenAIMcpCall
  | OpenAIMcpListTools
  | OpenAIPromptCacheBreakpointData
  | OpenAIResponsesOutputData;

export interface OpenAILanguageModelOptions {
  apiMode?: "auto" | "chat" | "responses";
  headers?: Record<string, string>;
  betas?: string[];
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  safety_identifier?: string;
  prompt_cache_key?: string;
  prompt_cache_options?: OpenAIPromptCacheOptions;
  prompt_cache_retention?: "in_memory" | "24h";
  multi_agent?: OpenAIMultiAgentOptions;
  include?: string[];
  store?: boolean;
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | { type: "function"; name: string }
    | { type: "image_generation" };
  [key: string]: unknown;
}

const resolveOpenAILanguageRequestOptions = (providerOptions: Record<string, unknown> | undefined, apiKey: string) => {
  const bodyOptions = { ...(providerOptions ?? {}) } as OpenAILanguageModelOptions;
  const apiMode = bodyOptions.apiMode ?? "auto";
  const customHeaders = { ...(bodyOptions.headers ?? {}) };
  const betaValues = new Set(bodyOptions.betas ?? []);
  const multiAgentEnabled = bodyOptions.multi_agent?.enabled === true;
  if (multiAgentEnabled) {
    betaValues.add("responses_multi_agent=v1");
  }

  const existingBetaHeaderKey = Object.keys(customHeaders).find((key) => key.toLowerCase() === "openai-beta");
  if (existingBetaHeaderKey) {
    for (const value of customHeaders[existingBetaHeaderKey]?.split(",") ?? []) {
      if (value.trim()) {
        betaValues.add(value.trim());
      }
    }
    delete customHeaders[existingBetaHeaderKey];
  }
  for (const key of Object.keys(customHeaders)) {
    if (RESERVED_REQUEST_HEADERS.has(key.toLowerCase())) {
      delete customHeaders[key];
    }
  }

  delete bodyOptions.apiMode;
  delete bodyOptions.headers;
  delete bodyOptions.betas;

  return {
    apiMode,
    bodyOptions,
    multiAgentEnabled,
    headers: {
      ...jsonHeaders(apiKey),
      ...customHeaders,
      ...(betaValues.size ? { "OpenAI-Beta": [...betaValues].join(",") } : {})
    }
  };
};

const openAIResponsesBodyOptions = (
  options: OpenAILanguageModelOptions,
  modelId: string
): OpenAILanguageModelOptions =>
  options.store === false && supportsOpenAIModernResponses(modelId)
    ? {
        ...options,
        include: [...new Set([...(options.include ?? []), "reasoning.encrypted_content"])]
      }
    : options;

const getRequestOptions = (input: Pick<ModelGenerateInput, "abortSignal" | "timeoutMs">) => withTimeoutSignal(input);

const toBase64 = (data: string | Uint8Array | ArrayBuffer) =>
  typeof data === "string" ? data : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)).toString("base64");

const inferOpenAIAudioFormat = (mediaType: string, explicitFormat?: string) => {
  if (explicitFormat) {
    return explicitFormat;
  }

  const normalized = mediaType.toLowerCase().split(";")[0]?.trim();
  if (normalized === "audio/wav" || normalized === "audio/x-wav" || normalized === "audio/wave") {
    return "wav";
  }
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") {
    return "mp3";
  }
  if (normalized === "audio/mp4" || normalized === "audio/m4a") {
    return "mp4";
  }
  if (normalized === "audio/ogg") {
    return "ogg";
  }
  if (normalized === "audio/webm") {
    return "webm";
  }
  if (normalized === "audio/pcm" || normalized === "audio/pcm16") {
    return "pcm16";
  }
  return normalized?.replace(/^audio\//, "") || mediaType;
};

const isOpenAIPromptCacheBreakpointPart = (
  part: ModelMessage["parts"][number]
): part is Extract<ModelMessage["parts"][number], { type: "provider-data" }> =>
  part.type === "provider-data" &&
  part.provider === "openai" &&
  part.data !== null &&
  typeof part.data === "object" &&
  (part.data as Record<string, unknown>).type === "prompt_cache_breakpoint";

const promptCacheBreakpointForContentPart = (part: ModelMessage["parts"][number]) => {
  const metadata = (part as ModelMessage["parts"][number] & { providerMetadata?: Record<string, unknown> })
    .providerMetadata;
  const openAIMetadata =
    metadata?.openai && typeof metadata.openai === "object" && !Array.isArray(metadata.openai)
      ? (metadata.openai as Record<string, unknown>)
      : metadata;
  const breakpoint = openAIMetadata?.prompt_cache_breakpoint;
  return breakpoint && typeof breakpoint === "object" && !Array.isArray(breakpoint)
    ? { prompt_cache_breakpoint: { mode: "explicit" } }
    : {};
};

const imageDetailForPart = (part: Extract<ModelMessage["parts"][number], { type: "image" }>) => {
  const metadata = (part as typeof part & { providerMetadata?: Record<string, unknown> }).providerMetadata;
  const detail = metadata?.openaiDetail ??
    (metadata?.openai && typeof metadata.openai === "object" && !Array.isArray(metadata.openai)
      ? (metadata.openai as Record<string, unknown>).detail
      : undefined);
  return detail === "auto" || detail === "low" || detail === "high" || detail === "original" ? detail : undefined;
};

const markLastContentBlockForPromptCaching = (content: Array<Record<string, unknown>>) => {
  const last = content.at(-1);
  if (!last) {
    throw new ConfigurationError("OpenAI prompt cache breakpoints must follow a cacheable content part.");
  }
  last.prompt_cache_breakpoint = { mode: "explicit" };
};

const mapContentParts = (message: ModelMessage) => {
  const hasRichContent = message.parts.some(
    (part) =>
      part.type === "image" ||
      part.type === "audio" ||
      part.type === "file" ||
      Object.keys(promptCacheBreakpointForContentPart(part)).length > 0 ||
      isOpenAIPromptCacheBreakpointPart(part)
  );
  if (!hasRichContent) {
    return message.parts
      .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  const content: Array<Record<string, unknown>> = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text, ...promptCacheBreakpointForContentPart(part) });
    } else if (part.type === "image") {
      const detail = imageDetailForPart(part);
      content.push({
        type: "image_url",
        image_url: { url: imageInputToDataUrl(part), ...(detail ? { detail } : {}) },
        ...promptCacheBreakpointForContentPart(part)
      });
    } else if (part.type === "file") {
      content.push({
        type: "file",
        file: { file_id: part.data },
        ...promptCacheBreakpointForContentPart(part)
      });
    } else if (part.type === "audio") {
      content.push({
        type: "input_audio",
        input_audio: {
          data: toBase64(part.data),
          format: inferOpenAIAudioFormat(part.mediaType, part.format)
        },
        ...promptCacheBreakpointForContentPart(part)
      });
    } else if (isOpenAIPromptCacheBreakpointPart(part)) {
      markLastContentBlockForPromptCaching(content);
    }
  }

  return content;
};

const mapMessages = (messages: ModelMessage[], format?: ModelGenerateInput["toolResultFormat"]) =>
  messages.flatMap<Record<string, unknown>>((message) => {
    if (message.role === "tool") {
      return message.parts
        .filter((part) => part.type === "tool-result")
        .map((part) => ({
          role: "tool",
          tool_call_id: part.toolResult.toolCallId,
          content: JSON.stringify(format === "envelope"
            ? toolResultPayload(part.toolResult)
            : part.toolResult.isError ? part.toolResult.error : part.toolResult.output)
        }));
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

    return [payload];
  });

const hasResponsesOnlyTools = (tools: ModelGenerateInput["tools"]) =>
  Object.values(tools ?? {}).some((tool) => isHostedToolDefinition(tool) || (isCallableToolDefinition(tool) && openAILocalResponsesToolType(tool)));

const hasProgrammaticToolCalling = (tools: ModelGenerateInput["tools"]) =>
  Object.values(tools ?? {}).some((tool) =>
    isHostedToolDefinition(tool)
      ? tool.type === "programmatic_tool_calling"
      : openAILocalResponsesToolType(tool) === "programmatic_tool_calling"
  );

const localResponsesTools = (tools: ModelGenerateInput["tools"]) =>
  new Map(
    Object.values(tools ?? {})
      .filter(isCallableToolDefinition)
      .map((tool) => [openAILocalResponsesToolType(tool), tool.name] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0]))
  );

const responsesImageGenerationConfig = (
  tools: ModelGenerateInput["tools"],
  limits?: Pick<ResolvedOpenAIResponseLimits, "hostedImageEventBytes" | "hostedImageTotalBytes">
) => {
  const definition = Object.values(tools ?? {}).find(
    (tool) => isHostedToolDefinition(tool) && tool.provider === "openai" && tool.type === "image_generation"
  );
  if (!definition || !isHostedToolDefinition(definition)) {
    return undefined;
  }
  const outputFormat =
    definition.config && typeof definition.config === "object" &&
    ["png", "jpeg", "webp"].includes(String((definition.config as Record<string, unknown>).output_format))
      ? ((definition.config as Record<string, unknown>).output_format as OpenAIImageOutputFormat)
      : "png";
  return {
    outputFormat,
    ...(limits
      ? {
          eventMaxBytes: limits.hostedImageEventBytes,
          totalMaxBytes: limits.hostedImageTotalBytes
        }
      : {})
  };
};

const assertResponsesToolsSupported = (modelId: string, tools: ModelGenerateInput["tools"], currentCapabilities: ModelCapabilities["agentCapabilities"]) => {
  for (const definition of Object.values(tools ?? {})) {
    const type = isCallableToolDefinition(definition) ? openAILocalResponsesToolType(definition) : definition.type;
    if (type === "tool_search" && !currentCapabilities?.toolSearch) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses tool_search tool.`);
    }
    if (type === "computer_use_preview" && !currentCapabilities?.computerUse) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses computer_use tool.`);
    }
    if (type === "computer" && !currentCapabilities?.computerUse) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses computer tool.`);
    }
    if (type === "shell" && !currentCapabilities?.shell) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses ${type} tool.`);
    }
    if (type === "apply_patch" && !currentCapabilities?.applyPatch) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses ${type} tool.`);
    }
    if (type === "skill" && !currentCapabilities?.skills) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses skills tool.`);
    }
    if (type === "programmatic_tool_calling" && !currentCapabilities?.programmaticToolCalling) {
      throw new UnsupportedFeatureError(
        `Provider "openai" model "${modelId}" does not support Programmatic Tool Calling.`
      );
    }
  }
};

const assertOpenAIResponsesOptionsSupported = (modelId: string, options: OpenAILanguageModelOptions, currentCapabilities: ModelCapabilities["agentCapabilities"]) => {
  if (options.multi_agent?.enabled && !currentCapabilities?.multiAgent) {
    throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support Multi-agent.`);
  }
};

const normalizeWebSearchConfig = (config: OpenAIWebSearchToolConfig = {}) => ({
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

        if (tool.provider && tool.provider !== "openai") {
          throw new UnsupportedFeatureError(
            `Provider "openai" does not support hosted tools declared for provider "${tool.provider}".`
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
          const responsesToolType = openAILocalResponsesToolType(tool);
          if (responsesToolType) {
            return {
              type: responsesToolType,
              ...openAILocalResponsesToolConfig(tool)
            };
          }

          return {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema),
            ...openAIResponsesFunctionConfig(tool)
          };
        }

        if (tool.provider && tool.provider !== "openai") {
          throw new UnsupportedFeatureError(
            `Provider "openai" does not support hosted tools declared for provider "${tool.provider}".`
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

const mapResponsesToolChoice = (toolChoice: ModelGenerateInput["toolChoice"]) => {
  if (!toolChoice || typeof toolChoice === "string") {
    return toolChoice;
  }
  return {
    type: "function",
    name: toolChoice.toolName
  };
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

const getOpenAIReasoning = (input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  if (input.reasoning.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "openai" does not support "reasoning.budgetTokens".');
  }

  return input.reasoning as typeof input.reasoning & {
    mode?: "standard" | "pro";
    context?: "auto" | "current_turn" | "all_turns";
  };
};

const mapChatReasoning = (input: ModelGenerateInput) => {
  const reasoning = getOpenAIReasoning(input);
  if (!reasoning) {
    return {};
  }
  if (reasoning.mode !== undefined || reasoning.context !== undefined) {
    throw new UnsupportedFeatureError(
      'Provider "openai" only supports "reasoning.mode" and "reasoning.context" through the Responses API.'
    );
  }

  return {
    ...(reasoning.effort !== undefined ? { reasoning_effort: reasoning.effort } : {}),
    max_completion_tokens: input.maxTokens
  };
};

const mapResponsesReasoning = (input: ModelGenerateInput, providerReasoning?: unknown) => {
  const reasoning = getOpenAIReasoning(input);
  if (!reasoning) {
    return {};
  }

  return {
    reasoning: {
      ...(providerReasoning && typeof providerReasoning === "object" && !Array.isArray(providerReasoning)
        ? providerReasoning
        : {}),
      ...(reasoning.effort !== undefined ? { effort: reasoning.effort } : {}),
      ...(reasoning.mode !== undefined ? { mode: reasoning.mode } : {}),
      ...(reasoning.context !== undefined ? { context: reasoning.context } : {}),
      ...(reasoning.includeThoughts ? { summary: "auto" } : {})
    }
  };
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
        part.provider === "openai" &&
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

const parseComputerCallInput = (item: Record<string, unknown>) => computerInputSchema.parse({
  call_id: item.call_id,
  actions: item.actions ?? (item.action ? [item.action] : undefined),
  ...(item.pending_safety_checks !== undefined ? { pending_safety_checks: item.pending_safety_checks } : {})
});

const serializeToolOutput = (
  message: ModelMessage,
  format: ModelGenerateInput["toolResultFormat"],
  calls: Map<string, ToolCall>
) =>
  message.parts
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "tool-result" }> => part.type === "tool-result")
    .map((part) => {
      const resultType = part.toolResult.providerMetadata?.responsesToolType;
      const call = calls.get(part.toolResult.toolCallId);
      const callType = call?.providerMetadata?.responsesToolType;
      const responsesToolType = resultType ?? callType;
      if (
        (responsesToolType !== undefined &&
          (typeof responsesToolType !== "string" || !["shell", "apply_patch", "computer"].includes(responsesToolType))) ||
        (call && resultType !== undefined && resultType !== callType) ||
        (call && part.toolResult.toolName !== undefined && part.toolResult.toolName !== call.name)
      ) {
        throw new ConfigurationError("OpenAI Responses tool result has inconsistent call metadata.");
      }
      if (responsesToolType === "shell") {
        const rawOutput = part.toolResult.output;
        const rawOutputs = Array.isArray(rawOutput)
          ? rawOutput
          : rawOutput && typeof rawOutput === "object" && Array.isArray((rawOutput as Record<string, unknown>).output)
            ? ((rawOutput as Record<string, unknown>).output as unknown[])
            : rawOutput
              ? [rawOutput]
              : [];
        const firstRawOutput =
          rawOutputs[0] && typeof rawOutputs[0] === "object"
            ? (rawOutputs[0] as Record<string, unknown>)
            : undefined;
        const output = rawOutputs.map((entry) => {
          const result = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
          const outcome =
            result.outcome && typeof result.outcome === "object"
              ? (result.outcome as Record<string, unknown>)
              : { type: "exit", exit_code: 0 };
          return {
            stdout: typeof result.stdout === "string" ? result.stdout : "",
            stderr: typeof result.stderr === "string" ? result.stderr : "",
            outcome: {
              type: outcome.type ?? "exit",
              exit_code: outcome.exit_code ?? outcome.exitCode
            }
          };
        });
        return {
          type: "shell_call_output",
          call_id: part.toolResult.toolCallId,
          max_output_length:
            rawOutput && typeof rawOutput === "object"
              ? ((rawOutput as Record<string, unknown>).max_output_length ??
                (rawOutput as Record<string, unknown>).maxOutputLength ??
                firstRawOutput?.max_output_length ??
                firstRawOutput?.maxOutputLength)
              : undefined,
          output: part.toolResult.isError
            ? [{
                stdout: "",
                stderr: part.toolResult.error?.message ?? "Shell execution failed.",
                outcome: { type: "exit", exit_code: 1 }
              }]
            : output
        };
      }

      if (responsesToolType === "apply_patch") {
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

      if (responsesToolType === "computer") {
        if (part.toolResult.isError) {
          throw new Error(
            `OpenAI computer action execution failed: ${part.toolResult.error?.message ?? "unknown error"}`
          );
        }
        const raw = part.toolResult.output as Record<string, unknown> | undefined;
        const input = call ? computerInputSchema.parse(call.input) : undefined;
        if ((input && input.call_id !== part.toolResult.toolCallId) || (raw?.call_id !== undefined && raw.call_id !== part.toolResult.toolCallId) || (!input && (raw?.call_id !== undefined || raw?.acknowledged_safety_checks !== undefined))) {
          throw new ConfigurationError("OpenAI computer result is missing its correlated call identity.");
        }
        const pending = input?.pending_safety_checks ?? [];
        const acknowledged = raw?.acknowledged_safety_checks ?? [];
        if (JSON.stringify(pending) !== JSON.stringify(acknowledged)) {
          throw new ConfigurationError("OpenAI computer safety acknowledgements do not match the pending checks.");
        }
        return {
          type: "computer_call_output",
          call_id: part.toolResult.toolCallId,
          output: computerScreenshotSchema.parse(raw),
          ...(pending.length ? { acknowledged_safety_checks: pending } : {})
        };
      }

      return {
        type: "function_call_output",
        call_id: part.toolResult.toolCallId,
        output: JSON.stringify(format === "envelope" ? toolResultPayload(part.toolResult) : part.toolResult.isError ? part.toolResult.error : part.toolResult.output ?? null),
        ...(part.toolResult.providerMetadata?.caller !== undefined
          ? { caller: part.toolResult.providerMetadata.caller }
          : {})
      };
    });

const serializeProviderDataInput = (message: ModelMessage) =>
  message.parts
    .filter(
      (part): part is Extract<ModelMessage["parts"][number], { type: "provider-data" }> =>
        part.type === "provider-data" &&
        part.provider === "openai" &&
        part.data !== null &&
        typeof part.data === "object" &&
        typeof (part.data as Record<string, unknown>).type === "string" &&
        !["prompt_cache_breakpoint", "responses_output"].includes(
          (part.data as Record<string, unknown>).type as string
        )
    )
    .map((part) => part.data as Record<string, unknown>);

const serializedResponsesOutput = (message: ModelMessage) =>
  message.parts.flatMap((part) => {
    if (
      part.type !== "provider-data" ||
      part.provider !== "openai" ||
      !part.data ||
      typeof part.data !== "object" ||
      (part.data as Record<string, unknown>).type !== "responses_output" ||
      !Array.isArray((part.data as Record<string, unknown>).items)
    ) {
      return [];
    }
    return (part.data as unknown as OpenAIResponsesOutputData).items as Array<Record<string, unknown>>;
  });

const parseResponsesProviderData = (item: unknown) => {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const typedItem = item as Record<string, unknown>;
  if (
    typeof typedItem.type !== "string" ||
    ["message", "function_call", "image_generation_call"].includes(typedItem.type)
  ) {
    return undefined;
  }

  return item as JsonValue;
};

const parseShellCallInput = (item: Record<string, unknown>) => {
  const action = item.action && typeof item.action === "object" ? (item.action as Record<string, unknown>) : undefined;
  return {
    command:
      typeof action?.command === "string"
        ? action.command
        : Array.isArray(action?.commands) && typeof action.commands[0] === "string"
          ? action.commands[0]
          : typeof item.command === "string"
            ? item.command
            : undefined,
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

const parseOpenAIMessageAudio = (message: any): ModelMessage["parts"] => {
  const audio = message.audio;
  if (!audio || typeof audio !== "object" || typeof audio.data !== "string") {
    return [];
  }

  const format = typeof audio.format === "string" ? audio.format : undefined;
  const transcript = typeof audio.transcript === "string" ? audio.transcript : undefined;
  return [
    {
      type: "audio",
      data: audio.data,
      mediaType: format ? `audio/${format}` : "audio/wav",
      format,
      transcript,
      providerMetadata: audio as Record<string, JsonValue>
    }
  ];
};

const parseAssistantMessage = (message: any): ModelMessage => ({
  role: "assistant",
  parts: [
    ...(typeof message.content === "string" && message.content
      ? [{ type: "text", text: message.content } as const]
      : typeof message.audio?.transcript === "string" && message.audio.transcript
        ? [{ type: "text", text: message.audio.transcript } as const]
      : []),
    ...parseOpenAIMessageAudio(message),
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

const parseOpenAIResponsesToolArguments = (
  rawArguments: unknown,
  maxChars: number,
  effectsPossible = false
): JsonValue => {
  if (typeof rawArguments !== "string") {
    throw openAIResponsesToolCallError("incomplete_arguments", effectsPossible);
  }
  if (rawArguments.trim().length === 0) {
    throw openAIResponsesToolCallError("empty_arguments", effectsPossible);
  }
  if (rawArguments.length > maxChars) {
    throw openAIResponsesToolCallError("arguments_too_large", effectsPossible);
  }

  try {
    return JSON.parse(rawArguments) as JsonValue;
  } catch {
    throw openAIResponsesToolCallError("invalid_json", effectsPossible);
  }
};

const extractAudioOutputs = (message: ModelMessage): GeneratedMedia[] =>
  message.parts
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "audio" }> => part.type === "audio")
    .map((part) => ({
      data: toUint8Array(part.data),
      mediaType: part.mediaType,
      text: part.transcript,
      providerMetadata: part.providerMetadata as Record<string, unknown> | undefined
    }));

const extractMessageText = (message: ModelMessage) =>
  message.parts
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }
      return [];
    })
    .join("");

const toResponsesInput = (
  messages: ModelMessage[],
  format?: ModelGenerateInput["toolResultFormat"],
  history: ModelMessage[] = messages
) => {
  // Keep the original call available even when previous_response_id trims the wire history.
  const calls = new Map<string, ToolCall>();
  for (const message of history) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "tool-call") calls.set(part.toolCall.id, part.toolCall);
    }
  }
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push(...serializeToolOutput(message, format, calls));
      continue;
    }

    const rawResponsesOutput = serializedResponsesOutput(message);
    if (message.role === "assistant" && rawResponsesOutput.length) {
      input.push(...rawResponsesOutput);
      continue;
    }

    input.push(...serializeProviderDataInput(message));

    const content: Array<Record<string, unknown>> = [];
    const assistantOutputItems: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          content.push({
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: part.text,
            ...(message.role === "assistant" ? { annotations: [] } : {}),
            ...promptCacheBreakpointForContentPart(part)
          });
          break;
        case "image":
          const detail = imageDetailForPart(part);
          content.push({
            type: "input_image",
            image_url: imageInputToDataUrl(part),
            ...(detail ? { detail } : {}),
            ...promptCacheBreakpointForContentPart(part)
          });
          break;
        case "file":
          content.push({
            type: "input_file",
            file_id: part.data,
            ...promptCacheBreakpointForContentPart(part)
          });
          break;
        case "tool-call":
          if (message.role === "assistant") {
            const caller = part.toolCall.providerMetadata?.caller;
            assistantOutputItems.push({
              type: "function_call",
              call_id: part.toolCall.id,
              name: part.toolCall.name,
              arguments: JSON.stringify(part.toolCall.input),
              ...(caller !== undefined ? { caller } : {})
            });
          }
          break;
        case "provider-data":
          if (isOpenAIPromptCacheBreakpointPart(part)) {
            markLastContentBlockForPromptCaching(content);
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
    input.push(...assistantOutputItems);
  }

  return input;
};

const parseResponsesAssistantMessage = (
  json: any,
  multiAgentEnabled = false,
  localTools: Map<string, string> = new Map(),
  toolCallArgumentChars = DEFAULT_TOOL_CALL_ARGUMENT_CHARS
): ModelMessage => {
  const parts: ModelMessage["parts"] = [];
  const output = Array.isArray(json.output) ? json.output : [];
  const responseStatus = typeof json.status === "string" ? json.status : undefined;
  const isExecutableToolOutput = (item: any) =>
    item?.type === "function_call" ||
    (item?.type === "shell_call" && localTools.has("shell")) ||
    (item?.type === "apply_patch_call" && localTools.has("apply_patch")) ||
    (item?.type === "computer_call");
  const hasExecutableToolOutput = output.some(isExecutableToolOutput);

  if (hasExecutableToolOutput && responseStatus !== "completed") {
    throw openAIResponsesToolCallError(
      responseStatus === "failed"
        ? "response_failed"
        : responseStatus === "incomplete"
          ? "response_incomplete"
          : "inconsistent_metadata"
    );
  }
  const nonCompletedToolOutput = output.find(
    (item: any) =>
      isExecutableToolOutput(item) &&
      typeof item.status === "string" &&
      item.status !== "completed"
  );
  if (nonCompletedToolOutput) {
    throw openAIResponsesToolCallError(
      nonCompletedToolOutput.status === "failed" ? "response_failed" : "incomplete_arguments"
    );
  }

  for (const [index, item] of output.entries()) {
    if (item?.type === "message") {
      if (multiAgentEnabled && (item.agent?.agent_name !== "/root" || item.phase !== "final_answer")) {
        continue;
      }
      for (const content of item.content ?? []) {
        if (typeof content?.text === "string" && content.text) {
          parts.push({ type: "text", text: content.text });
        } else if (typeof content?.refusal === "string" && content.refusal) {
          parts.push({ type: "text", text: content.refusal });
        }
      }
      continue;
    }

    if (item?.type === "function_call") {
      if (
        typeof item.call_id !== "string" ||
        item.call_id.length === 0 ||
        typeof item.name !== "string" ||
        item.name.length === 0
      ) {
        throw openAIResponsesToolCallError("inconsistent_metadata");
      }
      if (item.status === "incomplete" || item.status === "failed") {
        throw openAIResponsesToolCallError(
          item.status === "failed" ? "response_failed" : "incomplete_arguments"
        );
      }
      parts.push({
        type: "tool-call",
        toolCall: {
          id: item.call_id,
          name: item.name,
          input: parseOpenAIResponsesToolArguments(item.arguments, toolCallArgumentChars),
          ...(item.caller && typeof item.caller === "object"
            ? { providerMetadata: { caller: item.caller as JsonValue } }
            : {})
        }
      });
      continue;
    }

    if (item?.type === "shell_call" && localTools.has("shell")) {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: item.call_id ?? item.id ?? `shell-${index}`,
          name: localTools.get("shell")!,
          input: parseShellCallInput(item) as JsonValue,
          providerMetadata: { responsesToolType: "shell" }
        }
      });
      continue;
    }

    if (item?.type === "apply_patch_call" && localTools.has("apply_patch")) {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: item.call_id ?? item.id ?? `apply_patch-${index}`,
          name: localTools.get("apply_patch")!,
          input: parseApplyPatchCallInput(item) as JsonValue,
          providerMetadata: { responsesToolType: "apply_patch" }
        }
      });
      continue;
    }

    if (item?.type === "computer_call") {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: item.call_id ?? item.id ?? `computer-${index}`,
          name: localTools.get("computer") ?? "computer",
          input: parseComputerCallInput(item) as JsonValue,
          providerMetadata: { responsesToolType: "computer", computerCallInput: JSON.stringify(parseComputerCallInput(item)) }
        }
      });
      continue;
    }

    const providerData = parseResponsesProviderData(item);
    if (providerData) {
      parts.push(providerDataPart("openai", providerData));
    }
  }

  if (Array.isArray(json.output) && json.output.length) {
    parts.push(
      providerDataPart("openai", {
        type: "responses_output",
        items: json.output
      } as JsonValue)
    );
  }

  if (!multiAgentEnabled && !parts.some((part) => part.type === "text") && typeof json.output_text === "string" && json.output_text) {
    parts.push({ type: "text", text: json.output_text });
  }

  if (typeof json.id === "string") {
    parts.push({
      type: "provider-data",
      provider: "openai",
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

const extractResponsesImageOutputs = (
  response: Record<string, unknown>,
  outputFormat: OpenAIImageOutputFormat = "png"
): GeneratedMedia[] =>
  (Array.isArray(response.output) ? response.output : []).flatMap((item) => {
    const normalized = normalizeOpenAIImageGenerationCall(item, outputFormat);
    return normalized?.image ? [normalized.image] : [];
  });

const normalizeResponsesFinishReason = (
  status: string | undefined,
  hasToolCalls: boolean,
  hasRefusal = false
) => {
  if (status === "failed") {
    return "error" as const;
  }

  if (hasToolCalls) {
    return "tool-calls" as const;
  }

  if (hasRefusal) {
    return "refusal" as const;
  }

  if (status === "completed") {
    return "stop" as const;
  }

  return normalizeFinishReason(status);
};

const attachTerminalUsage = (error: ProviderToolCallError, raw: unknown) => new ProviderToolCallError({
  provider: error.provider,
  transport: error.transport,
  diagnosticCode: error.diagnosticCode,
  reason: error.reason,
  retryable: error.retryable,
  effectsPossible: error.effectsPossible,
  cause: error.cause,
  usage: mapResponsesUsage(raw)
});

const mapResponsesUsage = (usage: any) =>
  usage
    ? {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.input_tokens_details?.cached_tokens,
        cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens,
        outputTokens: usage.output_tokens,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
        totalTokens: usage.total_tokens
      }
    : undefined;

const mapChatUsage = (usage: any) =>
  usage
    ? {
        inputTokens: usage.prompt_tokens,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
        cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens,
        outputTokens: usage.completion_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        totalTokens: usage.total_tokens
      }
    : undefined;

const addTokenUsage = (
  left: ReturnType<typeof mapResponsesUsage>,
  right: ReturnType<typeof mapResponsesUsage>
): ReturnType<typeof mapResponsesUsage> => {
  if (!left) return right;
  if (!right) return left;
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined ? undefined : a + b;
  return {
    inputTokens: sum(left.inputTokens, right.inputTokens),
    cachedInputTokens: sum(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteTokens: sum(left.cacheWriteTokens, right.cacheWriteTokens),
    outputTokens: sum(left.outputTokens, right.outputTokens),
    reasoningTokens: sum(left.reasoningTokens, right.reasoningTokens),
    totalTokens: sum(left.totalTokens, right.totalTokens)
  };
};

const streamResponses = async function* (
  response: Response,
  multiAgentEnabled = false,
  localTools: Map<string, string> = new Map(),
  imageGeneration?: {
    outputFormat: OpenAIImageOutputFormat;
    eventMaxBytes?: number;
    totalMaxBytes?: number;
  },
  toolCallArgumentChars = DEFAULT_TOOL_CALL_ARGUMENT_CHARS
): AsyncGenerator<StreamEvent, void, undefined> {
  type ToolBuffer = {
    itemId?: string;
    callId?: string;
    name?: string;
    deltaArguments: string;
    finalArguments?: string;
    argumentsDone: boolean;
    outputItemDone: boolean;
    itemStatus?: string;
    outputIndex?: number;
    caller?: JsonValue;
    emitted: boolean;
    order: number;
  };

  const toolBuffers = new Map<string, ToolBuffer>();
  const toolBuffersByOutputIndex = new Map<number, ToolBuffer>();
  const pendingExecutableEvents: StreamEvent[] = [];
  const pendingExecutableProviderEvents: StreamEvent[] = [];
  const outputAgents = new Map<number, { agentName?: string }>();
  const hostedImageEventMaxBytes = imageGeneration?.eventMaxBytes ?? DEFAULT_HOSTED_IMAGE_EVENT_BYTES;
  const hostedImageTotalMaxBytes = imageGeneration?.totalMaxBytes ?? DEFAULT_HOSTED_IMAGE_TOTAL_BYTES;
  let hostedImageBytes = 0;
  let sawToolCalls = false;
  let sawRefusal = false;
  let sawTerminalResponse = false;
  let deferredToolError: ProviderToolCallError | undefined;
  let nextToolOrder = 0;

  const recordHostedImageBytes = (image: GeneratedMedia) => {
    const receivedBytes = hostedImageBytes + (image.data?.byteLength ?? 0);
    if (receivedBytes > hostedImageTotalMaxBytes) {
      throw new ProviderResponseTooLargeError({
        maxBytes: hostedImageTotalMaxBytes,
        receivedBytes,
        provider: "openai",
        endpoint: "hosted image generation stream"
      });
    }
    hostedImageBytes = receivedBytes;
  };

  const toolBufferKey = (itemId: unknown, outputIndex: unknown) => {
    if (typeof itemId === "string" && itemId.length > 0) {
      return `item:${itemId}`;
    }
    if (typeof outputIndex === "number" && Number.isSafeInteger(outputIndex) && outputIndex >= 0) {
      return `output:${outputIndex}`;
    }
    throw openAIResponsesToolCallError("inconsistent_metadata", sawToolCalls);
  };

  const getToolBuffer = (key: string, itemId: unknown, outputIndex: unknown): ToolBuffer => {
    const canonicalItemId = typeof itemId === "string" && itemId.length > 0 ? itemId : undefined;
    const canonicalOutputIndex =
      typeof outputIndex === "number" && Number.isSafeInteger(outputIndex) && outputIndex >= 0
        ? outputIndex
        : undefined;
    const bindItemId = (toolCall: ToolBuffer) => {
      if (
        canonicalItemId !== undefined &&
        toolCall.itemId !== undefined &&
        toolCall.itemId !== canonicalItemId
      ) {
        throw openAIResponsesToolCallError("inconsistent_metadata", sawToolCalls);
      }
      if (canonicalItemId !== undefined) {
        toolCall.itemId = canonicalItemId;
      }
    };
    const bindOutputIndex = (toolCall: ToolBuffer) => {
      if (canonicalOutputIndex === undefined) {
        return;
      }
      if (toolCall.outputIndex !== undefined && toolCall.outputIndex !== canonicalOutputIndex) {
        throw openAIResponsesToolCallError("inconsistent_metadata", sawToolCalls);
      }
      const indexed = toolBuffersByOutputIndex.get(canonicalOutputIndex);
      if (indexed && indexed !== toolCall) {
        throw openAIResponsesToolCallError("inconsistent_metadata", sawToolCalls);
      }
      toolCall.outputIndex = canonicalOutputIndex;
      toolBuffersByOutputIndex.set(canonicalOutputIndex, toolCall);
    };

    const existing = toolBuffers.get(key);
    if (existing) {
      bindItemId(existing);
      bindOutputIndex(existing);
      return existing;
    }

    if (canonicalOutputIndex !== undefined) {
      const indexed = toolBuffersByOutputIndex.get(canonicalOutputIndex);
      if (indexed) {
        bindItemId(indexed);
        toolBuffers.set(key, indexed);
        return indexed;
      }
    }

    const created: ToolBuffer = {
      ...(canonicalItemId !== undefined ? { itemId: canonicalItemId } : {}),
      deltaArguments: "",
      argumentsDone: false,
      outputItemDone: false,
      emitted: false,
      order: nextToolOrder++,
      ...(canonicalOutputIndex !== undefined ? { outputIndex: canonicalOutputIndex } : {})
    };
    toolBuffers.set(key, created);
    if (created.outputIndex !== undefined) {
      toolBuffersByOutputIndex.set(created.outputIndex, created);
    }
    return created;
  };

  const mergeToolString = (toolCall: ToolBuffer, field: "callId" | "name", value: unknown) => {
    if (typeof value !== "string" || value.length === 0) {
      return;
    }
    if (toolCall[field] !== undefined && toolCall[field] !== value) {
      throw openAIResponsesToolCallError("inconsistent_metadata", sawToolCalls);
    }
    toolCall[field] = value;
  };

  const ensureArgumentLimit = (argumentsValue: string) => {
    if (argumentsValue.length > toolCallArgumentChars) {
      throw openAIResponsesToolCallError("arguments_too_large", sawToolCalls);
    }
  };

  const setFinalArguments = (toolCall: ToolBuffer, argumentsValue: unknown) => {
    if (typeof argumentsValue !== "string") {
      return;
    }
    ensureArgumentLimit(argumentsValue);
    if (toolCall.finalArguments !== undefined && toolCall.finalArguments !== argumentsValue) {
      throw openAIResponsesToolCallError("inconsistent_metadata", sawToolCalls);
    }
    if (toolCall.deltaArguments.length > 0 && toolCall.deltaArguments !== argumentsValue) {
      throw openAIResponsesToolCallError("inconsistent_metadata", sawToolCalls);
    }
    toolCall.finalArguments = argumentsValue;
  };

  const materializeToolCalls = (): StreamEvent[] => {
    const pending = [...new Set(toolBuffers.values())]
      .filter((toolCall) => !toolCall.emitted)
      .sort((left, right) =>
        (left.outputIndex ?? Number.MAX_SAFE_INTEGER) - (right.outputIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.order - right.order
      );

    const events = pending.map((toolCall) => {
      if (
        !toolCall.callId ||
        !toolCall.name ||
        (!toolCall.argumentsDone && !toolCall.outputItemDone)
      ) {
        throw openAIResponsesToolCallError("incomplete_arguments", sawToolCalls);
      }
      if (toolCall.itemStatus === "failed" || toolCall.itemStatus === "incomplete") {
        throw openAIResponsesToolCallError(
          toolCall.itemStatus === "failed" ? "response_failed" : "incomplete_arguments",
          sawToolCalls
        );
      }

      const rawArguments = toolCall.finalArguments ?? toolCall.deltaArguments;
      const input = parseOpenAIResponsesToolArguments(rawArguments, toolCallArgumentChars, sawToolCalls);
      return {
        type: "tool-call",
        toolCall: {
          id: toolCall.callId,
          name: toolCall.name,
          input,
          ...(toolCall.caller !== undefined ? { providerMetadata: { caller: toolCall.caller } } : {})
        }
      } satisfies StreamEvent;
    });

    for (const toolCall of pending) {
      toolCall.emitted = true;
    }
    if (events.length > 0) {
      sawToolCalls = true;
    }
    return events;
  };

  const maxHostedImageEventChars = Math.min(
    Number.MAX_SAFE_INTEGER,
    4 * Math.ceil(hostedImageEventMaxBytes / 3) + HOSTED_IMAGE_EVENT_JSON_OVERHEAD_CHARS
  );
  for await (const event of streamSSE(response, imageGeneration
    ? { maxEventChars: maxHostedImageEventChars, maxBufferChars: maxHostedImageEventChars }
    : undefined)) {
    if (event.data === "[DONE]") {
      break;
    }

    let json: any;
    try {
      json = JSON.parse(event.data);
    } catch (error) {
      if (toolBuffers.size > 0 || sawToolCalls) {
        throw openAIResponsesToolCallError("stream_truncated", sawToolCalls);
      }
      throw error;
    }
    const type = json.type as string | undefined;
    if (deferredToolError) {
      if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
        throw attachTerminalUsage(deferredToolError, json.response?.usage);
      }
      continue;
    }

    if (sawTerminalResponse) {
      continue;
    }

    if (type === "response.image_generation_call.partial_image") {
      const normalized = normalizeOpenAIImageGenerationPartialImage(
        json,
        imageGeneration?.outputFormat ?? "png",
        hostedImageEventMaxBytes
      );
      if (normalized) {
        recordHostedImageBytes(normalized.image);
        yield {
          type: "image-generation",
          provider: "openai",
          image: normalized.image,
          partial: true,
          id: normalized.callId,
          index: normalized.partialImageIndex,
          providerMetadata: normalized.providerMetadata as Record<string, JsonValue>
        } satisfies StreamEvent;
      }
      continue;
    }

    if (type === "error") {
      if (toolBuffers.size > 0 || pendingExecutableEvents.length > 0 || sawToolCalls) {
        throw openAIResponsesToolCallError("response_failed", sawToolCalls);
      }
      throw new ProviderHTTPError(
        `OpenAI Responses stream failed: ${json.error?.message ?? json.message ?? "unknown error"}`,
        500,
        { responseBody: JSON.stringify(json) }
      );
    }

    if (
      type === "response.output_text.delta" &&
      typeof json.delta === "string" &&
      (!multiAgentEnabled ||
        (outputAgents.get(json.output_index)?.agentName ?? "/root") === "/root")
    ) {
      yield { type: "text-delta", textDelta: json.delta } satisfies StreamEvent;
      continue;
    }

    if (
      type === "response.refusal.delta" &&
      typeof json.delta === "string" &&
      (!multiAgentEnabled ||
        (outputAgents.get(json.output_index)?.agentName ?? "/root") === "/root")
    ) {
      sawRefusal = true;
      yield { type: "text-delta", textDelta: json.delta } satisfies StreamEvent;
      continue;
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = json.item;
      let handledLocalToolCall = false;
      const isLocalExecutableItem =
        item?.type === "function_call" ||
        (item?.type === "shell_call" && localTools.has("shell")) ||
        (item?.type === "apply_patch_call" && localTools.has("apply_patch")) ||
        (item?.type === "computer_call");

      if (
        type === "response.output_item.done" &&
        isLocalExecutableItem &&
        typeof item.status === "string" &&
        item.status !== "completed"
      ) {
        deferredToolError = openAIResponsesToolCallError(
          item.status === "failed" ? "response_failed" : "incomplete_arguments",
          sawToolCalls
        );
        continue;
      }

      if (item?.type === "image_generation_call" && type === "response.output_item.done") {
        const normalized = normalizeOpenAIImageGenerationCall(
          item,
          imageGeneration?.outputFormat ?? "png",
          hostedImageEventMaxBytes
        );
        if (normalized?.image) {
          recordHostedImageBytes(normalized.image);
          yield {
            type: "image-generation",
            provider: "openai",
            image: normalized.image,
            partial: false,
            id: normalized.id,
            providerMetadata: normalized.providerMetadata as Record<string, JsonValue>
          } satisfies StreamEvent;
        }
      }
      if (typeof json.output_index === "number" && item?.type === "message") {
        outputAgents.set(json.output_index, {
          agentName: item.agent?.agent_name
        });
      }
      if (item?.type === "function_call") {
        const itemId = item.id ?? json.item_id;
        const key = toolBufferKey(itemId, json.output_index);
        const existing = getToolBuffer(key, itemId, json.output_index);
        mergeToolString(existing, "callId", item.call_id);
        mergeToolString(existing, "name", item.name);
        if (item.caller && typeof item.caller === "object") {
          existing.caller = item.caller as JsonValue;
        }
        if (type === "response.output_item.done") {
          existing.outputItemDone = true;
          existing.itemStatus = typeof item.status === "string" ? item.status : existing.itemStatus;
          setFinalArguments(existing, item.arguments);
        } else if (typeof item.arguments === "string" && item.arguments.length > 0) {
          ensureArgumentLimit(item.arguments);
          existing.deltaArguments = item.arguments;
        }
      }

      if (item?.type === "shell_call" && type === "response.output_item.done" && localTools.has("shell")) {
        pendingExecutableEvents.push({
          type: "tool-call",
          toolCall: {
            id: item.call_id ?? item.id ?? `${json.output_index ?? "shell"}`,
            name: localTools.get("shell")!,
            input: parseShellCallInput(item) as JsonValue,
            providerMetadata: { responsesToolType: "shell" }
          }
        } satisfies StreamEvent);
        handledLocalToolCall = true;
      }

      if (item?.type === "apply_patch_call" && type === "response.output_item.done" && localTools.has("apply_patch")) {
        pendingExecutableEvents.push({
          type: "tool-call",
          toolCall: {
            id: item.call_id ?? item.id ?? `${json.output_index ?? "apply_patch"}`,
            name: localTools.get("apply_patch")!,
            input: parseApplyPatchCallInput(item) as JsonValue,
            providerMetadata: { responsesToolType: "apply_patch" }
          }
        } satisfies StreamEvent);
        handledLocalToolCall = true;
      }

      if (item?.type === "computer_call" && type === "response.output_item.done") {
        pendingExecutableEvents.push({
          type: "tool-call",
          toolCall: {
            id: item.call_id ?? item.id ?? `${json.output_index ?? "computer"}`,
            name: localTools.get("computer") ?? "computer",
            input: parseComputerCallInput(item) as JsonValue,
            providerMetadata: { responsesToolType: "computer", computerCallInput: JSON.stringify(parseComputerCallInput(item)) }
          }
        } satisfies StreamEvent);
        handledLocalToolCall = true;
      }

      const providerData = parseResponsesProviderData(item);
      if (providerData && type === "response.output_item.done" && !handledLocalToolCall) {
        yield {
          type: "provider-data",
          provider: "openai",
          data: providerData
        } satisfies StreamEvent;
      }
      if (item && type === "response.output_item.done") {
        const outputEvent = {
          type: "provider-data",
          provider: "openai",
          data: {
            type: "responses_output",
            items: [item]
          } as JsonValue
        } satisfies StreamEvent;
        if (item.type === "function_call" || handledLocalToolCall) {
          pendingExecutableProviderEvents.push(outputEvent);
        } else {
          yield outputEvent;
        }
      }
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      const key = toolBufferKey(json.item_id, json.output_index);
      const existing = getToolBuffer(key, json.item_id, json.output_index);
      mergeToolString(existing, "callId", json.call_id);
      mergeToolString(existing, "name", json.name);
      if (typeof json.delta === "string") {
        const nextArguments = existing.deltaArguments + json.delta;
        ensureArgumentLimit(nextArguments);
        existing.deltaArguments = nextArguments;
      }
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const key = toolBufferKey(json.item_id, json.output_index);
      const existing = getToolBuffer(key, json.item_id, json.output_index);
      mergeToolString(existing, "callId", json.call_id);
      mergeToolString(existing, "name", json.name);
      existing.argumentsDone = true;
      setFinalArguments(existing, json.arguments);
      continue;
    }

    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      const responseData = json.response ?? {};
      const responseStatus = typeof responseData.status === "string"
        ? responseData.status
        : type.slice("response.".length);
      sawTerminalResponse = true;

      if (responseStatus === "completed") {
        let materialized: StreamEvent[];
        try { materialized = materializeToolCalls(); }
        catch (error) {
          if (error instanceof ProviderToolCallError) throw attachTerminalUsage(error, responseData.usage);
          throw error;
        }
        for (const toolCallEvent of materialized) yield toolCallEvent;
        if (pendingExecutableEvents.length > 0) {
          sawToolCalls = true;
          for (const toolCallEvent of pendingExecutableEvents) {
            yield toolCallEvent;
          }
        }
        for (const providerEvent of pendingExecutableProviderEvents) {
          yield providerEvent;
        }
      } else if (
        (responseStatus === "failed" || responseStatus === "incomplete") &&
        (toolBuffers.size > 0 || pendingExecutableEvents.length > 0 || sawToolCalls)
      ) {
        throw attachTerminalUsage(openAIResponsesToolCallError(
          responseStatus === "failed" ? "response_failed" : "response_incomplete",
          sawToolCalls
        ), responseData.usage);
      }

      if (typeof responseData.id === "string") {
        yield {
          type: "provider-data",
          provider: "openai",
          data: { responseId: responseData.id }
        } satisfies StreamEvent;
      }
      yield {
        type: "finish",
        finishReason: normalizeResponsesFinishReason(responseStatus, sawToolCalls, sawRefusal),
        providerFinishReason: responseStatus,
        usage: mapResponsesUsage(responseData.usage)
      } satisfies StreamEvent;
      continue;
    }
  }

  if (
    !sawTerminalResponse &&
    (deferredToolError || toolBuffers.size > 0 || pendingExecutableEvents.length > 0 || sawToolCalls)
  ) {
    throw openAIResponsesToolCallError("stream_truncated", sawToolCalls);
  }
};

const streamGenerateResult = async function* (result: GenerateResult): AsyncGenerator<StreamEvent, void, undefined> {
  for (const message of result.messages ?? (result.message ? [result.message] : [])) {
    for (const part of message.parts) {
      if (part.type === "text" && part.text) {
        yield { type: "text-delta", textDelta: part.text } satisfies StreamEvent;
      } else if (part.type === "tool-call") {
        yield { type: "tool-call", toolCall: part.toolCall } satisfies StreamEvent;
      } else if (part.type === "provider-data") {
        yield {
          type: "provider-data",
          provider: part.provider,
          data: part.data
        } satisfies StreamEvent;
      }
    }
  }
  for (const image of result.images ?? []) {
    yield {
      type: "image-generation",
      provider: "openai",
      image,
      partial: false
    } satisfies StreamEvent;
  }
  yield {
    type: "finish",
    finishReason: result.finishReason,
    providerFinishReason: result.providerFinishReason,
    usage: result.usage,
    providerRequestCount: result.providerRequestCount
  } satisfies StreamEvent;
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

class OpenAILanguageModel implements LanguageModel<OpenAILanguageModelOptions> {
  readonly provider = "openai";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly responseLimits: ResolvedOpenAIResponseLimits,
    capabilityOptions: Pick<OpenAIProviderOptions, "unknownModelCapabilities" | "modelCapabilities">
  ) {
    const base = modelCapabilities(modelId, capabilityOptions.unknownModelCapabilities);
    const override = (capabilityOptions.modelCapabilities && Object.hasOwn(capabilityOptions.modelCapabilities, modelId) ? capabilityOptions.modelCapabilities[modelId] : undefined);
    this.capabilities = { ...base, ...override,
      agentCapabilities: { ...base.agentCapabilities!, ...override?.agentCapabilities }, toolHistory: "json" };
  }

  private usesResponsesAPI(input: ModelGenerateInput, options: ReturnType<typeof resolveOpenAILanguageRequestOptions>) {
    if (!this.capabilities.tools && (Object.keys(input.tools ?? {}).length || input.messages.some(message => message.parts.some(part => part.type === "tool-call" || part.type === "tool-result")))) {
      throw new UnsupportedFeatureError(`OpenAI model "${this.modelId}" has no declared tool support.`);
    }
    if (!this.capabilities.vision && input.messages.some(message => message.parts.some(part => part.type === "image"))) {
      throw new UnsupportedFeatureError(`OpenAI model "${this.modelId}" has no declared vision support.`);
    }
    const rawFormat = options.bodyOptions.response_format as { type?: unknown } | undefined;
    const rawText = options.bodyOptions.text as { format?: { type?: unknown } } | undefined;
    const formatTypes = [rawFormat?.type, rawText?.format?.type];
    if (!this.capabilities.structuredOutput && (input.structuredOutput?.mode === "native" || formatTypes.includes("json_schema"))) {
      throw new UnsupportedFeatureError(`OpenAI model "${this.modelId}" has no declared native structured output support.`);
    }
    if (!this.capabilities.jsonMode && formatTypes.includes("json_object")) {
      throw new UnsupportedFeatureError(`OpenAI model "${this.modelId}" has no declared JSON mode support.`);
    }
    if (!this.capabilities.parallelToolCalls && options.bodyOptions.parallel_tool_calls === true) {
      throw new UnsupportedFeatureError(`OpenAI model "${this.modelId}" has no declared parallel tool calling support.`);
    }
    if (!this.capabilities.reasoning && (input.reasoning || options.bodyOptions.reasoning || options.bodyOptions.reasoning_effort)) {
      throw new UnsupportedFeatureError(`OpenAI model "${this.modelId}" has no declared reasoning support.`);
    }
    if (!this.capabilities.toolChoice && (input.toolChoice !== undefined || options.bodyOptions.tool_choice !== undefined)) {
      throw new UnsupportedFeatureError(`OpenAI model "${this.modelId}" has no declared tool choice support.`);
    }
    assertOpenAIModelRequestSupported(this.modelId, input, options);
    const requiresResponses = hasResponsesOnlyTools(input.tools) || options.multiAgentEnabled;
    if (options.apiMode === "chat") {
      if (requiresResponses) {
        throw new UnsupportedFeatureError(
          'Provider "openai" cannot use apiMode "chat" with Responses-only tools or Multi-agent.'
        );
      }
      return false;
    }
    return options.apiMode === "responses" || requiresResponses || resolveOpenAIModelProfile(this.modelId).defaultApi === "responses";
  }

  private async generateViaResponses(
    input: ModelGenerateInput,
    signal: AbortSignal | undefined,
    options: ReturnType<typeof resolveOpenAILanguageRequestOptions>
  ): Promise<GenerateResult> {
    const responseBodyOptions = openAIResponsesBodyOptions(options.bodyOptions, this.modelId);
    assertResponsesToolsSupported(this.modelId, input.tools, this.capabilities.agentCapabilities);
    assertOpenAIResponsesOptionsSupported(this.modelId, responseBodyOptions, this.capabilities.agentCapabilities);
    const previousResponse = responseBodyOptions.store === false ? undefined : getProviderResponseId(input.messages);
    const messages =
      previousResponse && previousResponse.index < input.messages.length - 1
        ? input.messages.slice(previousResponse.index + 1)
        : input.messages;
    let nextPreviousResponseId = previousResponse?.responseId;
    let nextInput = messages.length ? toResponsesInput(messages, input.toolResultFormat, input.messages) : [];
    let accumulatedUsage: ReturnType<typeof mapResponsesUsage>;
    const ptc = hasProgrammaticToolCalling(input.tools);
    const requestLimit = Math.min(input.maxProviderRequests ?? 8, 8);
    if (!Number.isSafeInteger(requestLimit) || requestLimit < 1) throw new ConfigurationError("maxProviderRequests must be a positive integer.");
    let providerRequestCount = 0;
    let usageComplete = true;
    const failure = (diagnosticCode: string, cause?: unknown) => new ProviderToolCallError({
      provider: "openai", transport: "responses", diagnosticCode,
      reason: cause instanceof ProviderToolCallError ? cause.reason : "response_failed",
      retryable: false, effectsPossible: providerRequestCount > 0,
      confirmedUsage: accumulatedUsage, usageComplete, providerRequestCount
    });
    let statelessInternalOutputs: Array<Record<string, unknown>> = [];

    try {
      for (let continuation = 0; continuation < requestLimit; continuation += 1) {
        const remainingOutputTokens = input.maxTokens === undefined ? undefined
          : input.maxTokens - (accumulatedUsage?.outputTokens ?? 0);
        if (ptc && remainingOutputTokens !== undefined && remainingOutputTokens < 1) throw failure("OPENAI_PTC_OUTPUT_LIMIT");
        if (ptc) { signal?.throwIfAborted(); providerRequestCount++; usageComplete = false; }
        const response = await withResponseRetry(
          () =>
            this.fetcher(`${this.baseURL}/responses`, {
              method: "POST",
              headers: options.headers,
              signal,
              body: JSON.stringify({
                ...responseBodyOptions,
                model: this.modelId,
                ...(nextPreviousResponseId ? { previous_response_id: nextPreviousResponseId } : {}),
                ...(nextInput.length ? { input: nextInput } : {}),
                tools: mapResponsesTools(input.tools),
                ...(input.toolChoice ? { tool_choice: mapResponsesToolChoice(input.toolChoice) } : {}),
                text: mapResponsesStructuredOutput(input) ?? responseBodyOptions.text,
                temperature: input.temperature,
                max_output_tokens: ptc ? remainingOutputTokens : input.maxTokens,
                ...mapResponsesReasoning(input, responseBodyOptions.reasoning)
              })
            }),
          { ...input, abortSignal: signal, ...(ptc ? { maxRetries: 0 } : {}) },
          "OpenAI"
        );

        const json = await parseJson(response);
        const reportedUsage = mapResponsesUsage(json.usage);
        if (ptc && (!reportedUsage || ![reportedUsage.inputTokens, reportedUsage.outputTokens, reportedUsage.totalTokens].every(
          value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ) || reportedUsage.totalTokens! < reportedUsage.inputTokens! + reportedUsage.outputTokens! || Object.values(reportedUsage).some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0)))) {
          throw failure("OPENAI_PTC_USAGE_UNKNOWN");
        }
        const nextUsage = addTokenUsage(accumulatedUsage, reportedUsage);
        if (ptc && Object.values(nextUsage ?? {}).some(value => value !== undefined && !Number.isSafeInteger(value))) throw failure("OPENAI_PTC_USAGE_UNKNOWN");
        accumulatedUsage = nextUsage;
        if (ptc) usageComplete = true;
        if (ptc && input.maxTokens !== undefined && accumulatedUsage!.outputTokens! > input.maxTokens) throw failure("OPENAI_PTC_OUTPUT_LIMIT");
        const assistantMessage = parseResponsesAssistantMessage(
          json,
          options.multiAgentEnabled,
          localResponsesTools(input.tools),
          this.responseLimits.toolCallArgumentChars
        );
        const currentOutput = Array.isArray(json.output)
          ? (json.output as Array<Record<string, unknown>>)
          : [];
        const completeStatelessOutput = [...statelessInternalOutputs, ...currentOutput];
        if (responseBodyOptions.store === false && completeStatelessOutput.length) {
          assistantMessage.parts = assistantMessage.parts.filter(
            (part) =>
              part.type !== "provider-data" ||
              part.provider !== "openai" ||
              !part.data ||
              typeof part.data !== "object" ||
              (part.data as Record<string, unknown>).type !== "responses_output"
          );
          assistantMessage.parts.push(
            providerDataPart("openai", {
              type: "responses_output",
              items: completeStatelessOutput
            } as unknown as JsonValue)
          );
        }
        const hasToolCalls = assistantMessage.parts.some((part) => part.type === "tool-call");
        const hasRefusal = (json.output ?? []).some((item: any) =>
          item?.type === "message" &&
          (item.content ?? []).some((content: any) => content?.type === "refusal")
        );
        const hasFinalMessage = (json.output ?? []).some(
          (item: any) =>
            item?.type === "message" &&
            (!options.multiAgentEnabled || (item.agent?.agent_name === "/root" && item.phase === "final_answer"))
        );
        const shouldContinueProgram =
          hasProgrammaticToolCalling(input.tools) &&
          json.status === "completed" &&
          !hasToolCalls &&
          !hasFinalMessage &&
          (json.output ?? []).some((item: any) => item?.type === "program" || item?.type === "program_output");

        if (!shouldContinueProgram) {
          return {
            messages: [assistantMessage],
            text: extractMessageText(assistantMessage),
            audio: extractAudioOutputs(assistantMessage),
            images: extractResponsesImageOutputs(
              json,
              responsesImageGenerationConfig(input.tools)?.outputFormat
            ),
            finishReason: normalizeResponsesFinishReason(json.status, hasToolCalls, hasRefusal),
            providerFinishReason: json.status,
            usage: accumulatedUsage,
            ...(ptc ? { providerRequestCount } : {}),
            rawResponse: json
          };
        }

        if (responseBodyOptions.store === false) {
          statelessInternalOutputs = completeStatelessOutput;
          nextInput = [...nextInput, ...currentOutput];
        } else {
          nextPreviousResponseId = json.id;
          nextInput = [];
        }
      }

      throw failure("OPENAI_PTC_REQUEST_LIMIT");
    } catch (error) {
      if (!ptc) throw error;
      if (error instanceof ProviderToolCallError && error.providerRequestCount !== undefined) throw error;
      // Never replay a dispatched program; the receipt distinguishes a confirmed
      // prefix from a failed/uncertain request and intentionally omits raw payloads.
      throw failure(error instanceof ProviderToolCallError ? error.diagnosticCode : "OPENAI_PTC_REQUEST_FAILED", error);
    }
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { signal, cleanup } = getRequestOptions(input);
    const options = resolveOpenAILanguageRequestOptions(input.providerOptions, this.apiKey);

    try {
      if (this.usesResponsesAPI(input, options)) {
        return await this.generateViaResponses(input, signal, options);
      }

      const response = await withResponseRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: options.headers,
            signal,
            body: JSON.stringify({
              ...options.bodyOptions,
              model: this.modelId,
              messages: mapMessages(input.messages, input.toolResultFormat),
              tools: mapTools(input.tools),
              ...(input.toolChoice ? { tool_choice: mapToolChoice(input.toolChoice) } : {}),
              response_format: mapStructuredOutput(input) ?? options.bodyOptions.response_format,
              temperature: input.temperature,
              ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
              ...mapChatReasoning(input),
              stream: false
            })
          }),
        { ...input, abortSignal: signal },
        "OpenAI"
      );

      const json = await parseJson(response);
      const choice = json.choices?.[0];
      const message = choice?.message ?? {};
      const assistantMessage = parseAssistantMessage(message);

      return {
        messages: [assistantMessage],
        text: extractMessageText(assistantMessage),
        audio: extractAudioOutputs(assistantMessage),
        finishReason: normalizeFinishReason(choice?.finish_reason),
        providerFinishReason: choice?.finish_reason,
        usage: mapChatUsage(json.usage),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
    const options = resolveOpenAILanguageRequestOptions(input.providerOptions, this.apiKey);
    if (this.usesResponsesAPI(input, options)) {
      const responseBodyOptions = openAIResponsesBodyOptions(options.bodyOptions, this.modelId);
      assertResponsesToolsSupported(this.modelId, input.tools, this.capabilities.agentCapabilities);
      assertOpenAIResponsesOptionsSupported(this.modelId, responseBodyOptions, this.capabilities.agentCapabilities);
      const { signal, cleanup } = getRequestOptions(input);
      if (hasProgrammaticToolCalling(input.tools)) {
        try {
          const result = await this.generateViaResponses(input, signal, options);
          return streamGenerateResult(result);
        } finally {
          // PTC is fully materialized before an iterator is returned.
          cleanup();
        }
      }
      const previousResponse = responseBodyOptions.store === false ? undefined : getProviderResponseId(input.messages);
      const messages =
        previousResponse && previousResponse.index < input.messages.length - 1
          ? input.messages.slice(previousResponse.index + 1)
          : input.messages;
      const response = await withResponseRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: options.headers,
            signal,
            body: JSON.stringify({
              ...responseBodyOptions,
              model: this.modelId,
              ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
              ...(messages.length ? { input: toResponsesInput(messages, input.toolResultFormat, input.messages) } : {}),
              tools: mapResponsesTools(input.tools),
              ...(input.toolChoice ? { tool_choice: mapResponsesToolChoice(input.toolChoice) } : {}),
              text: mapResponsesStructuredOutput(input) ?? responseBodyOptions.text,
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              ...mapResponsesReasoning(input, responseBodyOptions.reasoning),
              stream: true
            })
          }),
        { ...input, abortSignal: signal },
        "OpenAI"
      ).catch((error) => { cleanup(); throw error; });
      const imageGeneration = responsesImageGenerationConfig(input.tools, this.responseLimits);
      const toolCallArgumentChars = this.responseLimits.toolCallArgumentChars;

      return (async function* () {
        try {
          yield* streamResponses(
            response,
            options.multiAgentEnabled,
            localResponsesTools(input.tools),
            imageGeneration,
            toolCallArgumentChars
          );
        } finally {
          cleanup();
        }
      })();
    }

    const { signal, cleanup } = getRequestOptions(input);
    const response = await withResponseRetry(
      () =>
        this.fetcher(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: options.headers,
          signal,
          body: JSON.stringify({
            ...options.bodyOptions,
            model: this.modelId,
            messages: mapMessages(input.messages, input.toolResultFormat),
            tools: mapTools(input.tools),
            ...(input.toolChoice ? { tool_choice: mapToolChoice(input.toolChoice) } : {}),
            response_format: mapStructuredOutput(input) ?? options.bodyOptions.response_format,
            temperature: input.temperature,
            ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
            ...mapChatReasoning(input),
            stream: true,
            stream_options: { include_usage: true }
          })
        }),
      { ...input, abortSignal: signal },
      "OpenAI"
    ).catch((error) => { cleanup(); throw error; });

    return (async function* () {
      try {
        yield* streamChatCompletions(response, "openai");
      } finally {
        cleanup();
      }
    })();
  }
}

class OpenAIGroundedLanguageModel implements GroundedLanguageModel {
  readonly provider = "openai";
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
    const options = resolveOpenAILanguageRequestOptions(input.providerOptions, this.apiKey);
    const responseBodyOptions = openAIResponsesBodyOptions(options.bodyOptions, this.modelId);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: options.headers,
            signal,
            body: JSON.stringify({
              ...responseBodyOptions,
              model: this.modelId,
              input: toResponsesInput(input.messages),
              tools: [{ type: "web_search_preview" }],
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              ...mapResponsesReasoning(input as ModelGenerateInput, responseBodyOptions.reasoning)
            })
          }),
        input
      );

      const json = await parseJson(response);
      return {
        text: json.output_text ?? "",
        sources: extractSources(json),
        usage: mapResponsesUsage(json.usage),
        finishReason: normalizeFinishReason(json.status),
        providerFinishReason: json.status,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

export const createOpenAI = (
  options: OpenAIProviderOptions = {}
): CallableProviderAdapter<LanguageModel<OpenAILanguageModelOptions>> & {
  rawFetch: typeof globalThis.fetch;
  agents: OpenAIAgentsClient;
} => {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing OpenAI API key.");
  }

  const baseURL = assertTrustedEndpoint(options.baseURL ?? "https://api.openai.com/v1", {
    label: "OpenAI baseURL",
    protocols: ["https"],
    allowUnsafe: options.allowUnsafeEndpoints
  }).toString().replace(/\/+$/, "");
  const trustedHost = new URL(baseURL).hostname;
  const realtimeURL = options.realtimeURL
    ? assertTrustedEndpoint(options.realtimeURL, {
        label: "OpenAI realtimeURL",
        protocols: ["wss"],
        allowedHosts: [trustedHost],
        allowUnsafe: options.allowUnsafeEndpoints
      }).toString()
    : undefined;
  const browserTokenURL = options.browserTokenURL
    ? assertTrustedEndpoint(options.browserTokenURL, {
        label: "OpenAI browserTokenURL",
        protocols: ["https"],
        allowedHosts: [trustedHost],
        allowUnsafe: options.allowUnsafeEndpoints
      }).toString()
    : undefined;
  const fetcher = options.fetch ?? globalThis.fetch;
  const responseLimits = resolveOpenAIResponseLimits(options.responseLimits);

  return createProviderAdapter({
    name: "openai",
    languageModel: (modelId) => {
      if (modelId.startsWith("gpt-live-")) throw new UnsupportedFeatureError("GPT-Live is a voice model; use openai.realtimeModel(modelId).");
      return new OpenAILanguageModel(modelId, apiKey, baseURL, fetcher, responseLimits, options);
    },
    embeddingModel: (modelId) => new OpenAIEmbeddingModel(modelId, apiKey, baseURL, fetcher),
    transcriptionModel: (modelId) => new OpenAITranscriptionModel(modelId, apiKey, baseURL, fetcher, responseLimits),
    speechModel: (modelId) => new OpenAISpeechModel(modelId, apiKey, baseURL, fetcher, responseLimits),
    imageGenerationModel: (modelId) =>
      createOpenAIImageGenerationModel({
        modelId,
        apiKey,
        baseURL,
        fetch: fetcher,
        allowUnsafeEndpoints: options.allowUnsafeEndpoints
      }),
    realtimeModel: (modelId) => {
      if (modelId.startsWith("gpt-live-") && !isOpenAILiveModel(modelId)) {
        throw new UnsupportedFeatureError(`Unsupported GPT-Live model "${modelId}". Use gpt-live-1 or its dated snapshot.`);
      }
      return isOpenAILiveModel(modelId) ? new OpenAILiveModel(
        modelId, baseURL, (providerOptions) => resolveOpenAIRealtimeHeaders(apiKey, providerOptions),
        options.realtimeConnectionFactory ?? openWebSocketConnection, realtimeURL, options.allowUnsafeEndpoints
      ) : new OpenAIRealtimeModel(
        modelId,
        apiKey,
        baseURL,
        fetcher,
        options.realtimeConnectionFactory,
        realtimeURL,
        browserTokenURL,
        options.allowUnsafeEndpoints
      );
    },
    groundedLanguageModel: (modelId) => new OpenAIGroundedLanguageModel(modelId, apiKey, baseURL, fetcher),
    rawFetch: fetcher,
    agents: new OpenAIAgentsClient(baseURL, apiKey, fetcher, options.allowUnsafeEndpoints)
  });
};

export const openAIWebSearchTool = (config: OpenAIWebSearchToolConfig = {}) =>
  hostedTool({
    name: "web_search",
    provider: "openai",
    type: config.type ?? "web_search",
    toolClass: "web-search",
    config: normalizeWebSearchConfig(config) as unknown as JsonValue
  });

export const openAIFileSearchTool = (config: OpenAIFileSearchToolConfig = {}) =>
  hostedTool({
    name: "file_search",
    provider: "openai",
    type: "file_search",
    toolClass: "file-search",
    config: config as unknown as JsonValue
  });

export const openAICodeInterpreterTool = (config: OpenAICodeInterpreterToolConfig) =>
  hostedTool({
    name: "code_interpreter",
    provider: "openai",
    type: "code_interpreter",
    toolClass: "code-execution",
    config: config as unknown as JsonValue
  });

export const openAIToolSearchTool = (config: OpenAIToolSearchToolConfig = {}) =>
  hostedTool({
    name: "tool_search",
    provider: "openai",
    type: "tool_search",
    toolClass: "tool-search",
    config: config as unknown as JsonValue
  });

export const openAIProgrammaticToolCallingTool = () =>
  hostedTool({
    name: "programmatic_tool_calling",
    provider: "openai",
    type: "programmatic_tool_calling",
    toolClass: "code-execution"
  });

export const openAIProgrammaticTool = <TSchema extends z.ZodTypeAny, TResult>(
  definition: ToolDefinition<TSchema, TResult>,
  options: OpenAIProgrammaticToolOptions = {}
): ToolDefinition<TSchema, TResult> => ({
  ...definition,
  metadata: {
    ...definition.metadata,
    [openAIResponsesFunctionConfigMetadataKey]: {
      allowed_callers: options.allowedCallers ?? ["programmatic"],
      ...(options.outputSchema ? { output_schema: toJSONSchema(options.outputSchema) } : {})
    } as unknown as JsonValue
  }
});

export const openAIRemoteMcpTool = (config: OpenAIRemoteMcpToolConfig) =>
  hostedTool({
    name: config.server_label ?? "mcp",
    provider: "openai",
    type: "mcp",
    toolClass: "remote-mcp",
    requiresApproval: config.require_approval !== "never",
    config: config as unknown as JsonValue
  });

export const openAIMcpApprovalResponse = (response: Omit<OpenAIMcpApprovalResponse, "type">) =>
  providerDataPart("openai", {
    type: "mcp_approval_response",
    ...response
  });

export const openAIRealtimeMcpApprovalResult = (
  response: OpenAIRealtimeMcpApprovalResultOptions
): ToolExecutionResult => ({
  toolCallId: response.approvalRequestId,
  toolName: response.name,
  output: {
    type: "mcp_approval_response",
    approve: response.approve,
    ...(response.reason ? { reason: response.reason } : {})
  },
  isError: false,
  providerMetadata: {
    [openAIRealtimeMcpMetadataKey]: {
      type: "mcp_approval_response",
      status: response.approve ? "approved" : "rejected",
      approval_request_id: response.approvalRequestId,
      approve: response.approve,
      ...(response.itemId ? { id: response.itemId } : {}),
      ...(response.reason ? { reason: response.reason } : {})
    }
  }
});

export const openAIPromptCacheBreakpoint = () =>
  providerDataPart("openai", {
    type: "prompt_cache_breakpoint",
    mode: "explicit"
  });

export const openAIComputerUseTool = (config: OpenAIComputerUseToolConfig) =>
  hostedTool({
    name: "computer",
    provider: "openai",
    type: "computer_use_preview",
    toolClass: "computer-use",
    config: config as unknown as JsonValue
  });

const runOpenAIShellCommand = async (
  input: OpenAIShellToolInput,
  config: OpenAIShellToolConfig
): Promise<OpenAIShellToolOutput[]> => {
  if (config.execute) {
    const result = await config.execute(input);
    return Array.isArray(result) ? result : [result];
  }

  const commands =
    input.action?.commands?.length
      ? input.action.commands
      : [input.command ?? input.action?.command].filter((command): command is string => Boolean(command));
  if (!commands.length) {
    throw new Error("OpenAI shell tool did not provide a command.");
  }

  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  const maxBuffer = Math.max(
    1024,
    config.maxOutputLength ??
      input.maxOutputLength ??
      input.max_output_length ??
      input.action?.maxOutputLength ??
      input.action?.max_output_length ??
      20000
  );
  const cwd = config.rootDir
    ? await assertOpenAIToolPathInsideRoot(config.rootDir, config.cwd ?? ".", "shell cwd")
    : config.cwd;

  const output: OpenAIShellToolOutput[] = [];
  for (const command of commands) {
    try {
      const result = await execAsync(command, {
        cwd,
        timeout: config.timeoutMs ?? input.action?.timeout_ms,
        maxBuffer
      });
      output.push({
        stdout: result.stdout,
        stderr: result.stderr,
        outcome: { type: "exit", exit_code: 0 },
        maxOutputLength: maxBuffer
      });
    } catch (error) {
      const err = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
        signal?: string;
        killed?: boolean;
        message?: string;
      };
      output.push({
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "",
        outcome: {
          type: err.killed || err.signal === "SIGTERM" ? "timeout" : "exit",
          exit_code: typeof err.code === "number" ? err.code : 1
        },
        maxOutputLength: maxBuffer
      });
    }
  }
  return output;
};

export const openAIHostedShellTool = (config: OpenAIHostedShellToolConfig) =>
  hostedTool({
    name: "shell",
    provider: "openai",
    type: "shell",
    toolClass: "shell",
    config: {
      environment: config.environment,
      ...(config.allowedCallers ? { allowed_callers: config.allowedCallers } : {})
    } as unknown as JsonValue
  });

export const openAIShellTool = (config: OpenAIShellToolConfig = {}): ToolDefinition<z.ZodType<OpenAIShellToolInput>, JsonValue> => ({
  name: config.name ?? "shell",
  description: "Run a shell command requested by the OpenAI Responses shell tool.",
  requiresApproval: true,
  metadata: {
    [openAIResponsesToolMetadataKey]: "shell",
    "openai.responses_tool_config": {
      environment: config.environment ?? { type: "local" },
      ...(config.allowedCallers ? { allowed_callers: config.allowedCallers } : {})
    } as unknown as JsonValue
  },
  schema: z.object({
    command: z.string().optional(),
    action: z
      .object({
        command: z.string().optional(),
        commands: z.array(z.string()).optional(),
        timeout_ms: z.number().optional(),
        max_output_length: z.number().optional(),
        maxOutputLength: z.number().optional()
      })
      .passthrough()
      .optional(),
    maxOutputLength: z.number().optional(),
    max_output_length: z.number().optional()
  }) as z.ZodType<OpenAIShellToolInput>,
  execute: async (input) => runOpenAIShellCommand(input, config) as unknown as JsonValue
});

const applyOpenAIPatchOperation = async (
  operation: OpenAIApplyPatchOperation,
  config: OpenAIApplyPatchToolConfig
) => {
  if (config.rootDir) {
    await assertOpenAIToolPathInsideRoot(config.rootDir, operation.path, "apply_patch");
  }

  return config.applyOperation(operation);
};

export const openAIApplyPatchTool = (
  config: OpenAIApplyPatchToolConfig
): ToolDefinition<z.ZodType<OpenAIApplyPatchToolInput>, JsonValue> => ({
  name: config.name ?? "apply_patch",
  description: "Apply a structured patch operation requested by the OpenAI Responses apply_patch tool.",
  requiresApproval: true,
  metadata: {
    [openAIResponsesToolMetadataKey]: "apply_patch",
    "openai.responses_tool_config": {
      ...(config.allowedCallers ? { allowed_callers: config.allowedCallers } : {})
    }
  },
  schema: z.object({
    operation: z
      .object({
        type: z.enum(["create_file", "update_file", "delete_file"]),
        path: z.string(),
        diff: z.string().optional()
      })
      .passthrough()
  }) as z.ZodType<OpenAIApplyPatchToolInput>,
  execute: async ({ operation }) => applyOpenAIPatchOperation(operation, config) as unknown as JsonValue
});

export * from "./image-generation.js";
