import { toJSONSchema, z } from "zod";

import {
  CallbackRealtimeSession,
  ConfigurationError,
  ProviderHTTPError,
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
  toToolSet,
  toolResultPayload,
  unsupportedBrowserToken,
  withRetry,
  withTimeoutSignal,
  type AudioFrame,
  type AudioInput,
  type AudioResponseLimits,
  type CallableProviderAdapter,
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  type GeneratedMedia,
  type GenerateResult,
  type GroundedGenerateResult,
  type GroundedLanguageModel,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type RealtimeConnectOptions,
  type RealtimeConnectionFactory,
  type RealtimeModel,
  type RealtimeSessionConfig,
  type RealtimeTokenResult,
  type SpeechModel,
  type SpeechResult,
  type StreamEvent,
  type ToolDefinition,
  type TranscriptionModel,
  type TranscriptionResult
} from "@zhivex-ai/core";

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  realtimeURL?: string;
  browserTokenURL?: string;
  realtimeConnectionFactory?: RealtimeConnectionFactory;
  responseLimits?: AudioResponseLimits;
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

export interface OpenAIComputerCallInput {
  actions: JsonValue[];
}

export interface OpenAIComputerScreenshotOutput {
  type: "computer_screenshot";
  image_url: string;
  detail?: "original";
}

export interface OpenAIComputerToolConfig {
  name?: string;
  requiresApproval?: boolean;
  execute: (
    input: OpenAIComputerCallInput
  ) => Promise<OpenAIComputerScreenshotOutput> | OpenAIComputerScreenshotOutput;
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
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  [key: string]: unknown;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: true,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: true,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-a",
    toolChoiceNone: true,
    approvalRequests: true,
    hostedWebSearch: true,
    hostedFileSearch: true,
    remoteMcp: true,
    computerUse: true,
    codeExecution: true,
    shell: true,
    applyPatch: true,
    toolSearch: true,
    skills: true,
    toolsets: false
  }
};

const normalizeModelId = (modelId: string) => modelId.trim().toLowerCase();

const isOpenAIGpt56Model = (modelId: string) => /^gpt-5\.6(?:$|-(?:sol|terra|luna)(?:-|$)|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt55BaseModel = (modelId: string) => /^gpt-5\.5(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt55ProModel = (modelId: string) => /^gpt-5\.5-pro(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt54BaseModel = (modelId: string) => /^gpt-5\.4(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt54MiniModel = (modelId: string) => /^gpt-5\.4-mini(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt54NanoModel = (modelId: string) => /^gpt-5\.4-nano(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));
const isOpenAIGpt54ProModel = (modelId: string) => /^gpt-5\.4-pro(?:$|-\d{4}-\d{2}-\d{2})/.test(normalizeModelId(modelId));

const supportsOpenAIToolSearch = (modelId: string) =>
  isOpenAIGpt56Model(modelId) || isOpenAIGpt55BaseModel(modelId) || isOpenAIGpt54BaseModel(modelId) || isOpenAIGpt54MiniModel(modelId);

const supportsOpenAIComputerUse = (modelId: string) =>
  isOpenAIGpt56Model(modelId) || isOpenAIGpt55BaseModel(modelId) || isOpenAIGpt54BaseModel(modelId) || isOpenAIGpt54MiniModel(modelId);

const supportsOpenAIShell = (modelId: string) =>
  isOpenAIGpt56Model(modelId) ||
  isOpenAIGpt55BaseModel(modelId) ||
  isOpenAIGpt55ProModel(modelId) ||
  isOpenAIGpt54BaseModel(modelId) ||
  isOpenAIGpt54MiniModel(modelId) ||
  isOpenAIGpt54NanoModel(modelId) ||
  isOpenAIGpt54ProModel(modelId);

const supportsOpenAIApplyPatchAndSkills = (modelId: string) =>
  isOpenAIGpt56Model(modelId) ||
  isOpenAIGpt55BaseModel(modelId) ||
  isOpenAIGpt54BaseModel(modelId) ||
  isOpenAIGpt54MiniModel(modelId) ||
  isOpenAIGpt54NanoModel(modelId);

const supportsOpenAIChatAudio = (modelId: string) => {
  const normalized = normalizeModelId(modelId);
  return /^(?:gpt-audio(?:-|$)|gpt-4o(?:-mini)?-audio-preview(?:-|$))/.test(normalized);
};

const modelCapabilities = (modelId: string): ModelCapabilities => ({
  ...capabilities,
  explicitPromptCaching: isOpenAIGpt56Model(modelId),
  files: isOpenAIGpt56Model(modelId),
  reasoningEfforts: isOpenAIGpt56Model(modelId)
    ? ["none", "low", "medium", "high", "xhigh", "max"]
    : undefined,
  reasoningModes: isOpenAIGpt56Model(modelId) ? ["standard", "pro"] : undefined,
  reasoningContexts: isOpenAIGpt56Model(modelId) ? ["auto", "current_turn", "all_turns"] : undefined,
  audioInput: supportsOpenAIChatAudio(modelId),
  audioOutput: supportsOpenAIChatAudio(modelId),
  agentCapabilities: {
    ...capabilities.agentCapabilities!,
    computerUse: supportsOpenAIComputerUse(modelId),
    shell: supportsOpenAIShell(modelId),
    applyPatch: supportsOpenAIApplyPatchAndSkills(modelId),
    skills: supportsOpenAIApplyPatchAndSkills(modelId),
    toolSearch: supportsOpenAIToolSearch(modelId),
    programmaticToolCalling: isOpenAIGpt56Model(modelId),
    multiAgent: isOpenAIGpt56Model(modelId)
  }
});

const transcriptionCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
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

const isOpenAIRealtimeTranslationModel = (modelId: string) => /^gpt-realtime-translate(?:[-@]|$)/.test(modelId);
const isOpenAIRealtimeTranscriptionModel = (modelId: string) => /^gpt-realtime-whisper(?:[-@]|$)/.test(modelId);
const inferOpenAIRealtimeMode = (modelId: string, mode?: RealtimeSessionConfig["mode"]): NonNullable<RealtimeSessionConfig["mode"]> => {
  if (mode) {
    return mode;
  }
  if (isOpenAIRealtimeTranslationModel(modelId)) {
    return "translation";
  }
  if (isOpenAIRealtimeTranscriptionModel(modelId)) {
    return "transcription";
  }
  return "conversation";
};

const openAIRealtimeSupportsImageInput = (modelId: string) =>
  /^(?:gpt-realtime|gpt-realtime-mini|gpt-realtime-1\.5|gpt-realtime-2)(?:-\d{4}-\d{2}-\d{2}|@.*)?$/.test(modelId);

const realtimeCapabilities = (modelId: string): ModelCapabilities => ({
  ...capabilities,
  streaming: false,
  audioInput: true,
  audioOutput: !isOpenAIRealtimeTranscriptionModel(modelId),
  tools: !isOpenAIRealtimeTranslationModel(modelId) && !isOpenAIRealtimeTranscriptionModel(modelId),
  toolChoice: !isOpenAIRealtimeTranslationModel(modelId) && !isOpenAIRealtimeTranscriptionModel(modelId),
  parallelToolCalls: !isOpenAIRealtimeTranslationModel(modelId) && !isOpenAIRealtimeTranscriptionModel(modelId),
  vision: openAIRealtimeSupportsImageInput(modelId),
  reasoning: /^gpt-realtime-2(?:[-@]|$)/.test(modelId),
  realtime: {
    sessions: true,
    audioInput: true,
    audioOutput: !isOpenAIRealtimeTranscriptionModel(modelId),
    imageInput: openAIRealtimeSupportsImageInput(modelId),
    tools: !isOpenAIRealtimeTranslationModel(modelId) && !isOpenAIRealtimeTranscriptionModel(modelId),
    browserTokens: true
  }
});

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

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
  options.store === false && isOpenAIGpt56Model(modelId)
    ? {
        ...options,
        include: [...new Set([...(options.include ?? []), "reasoning.encrypted_content"])]
      }
    : options;

const getRequestOptions = (input: Pick<ModelGenerateInput, "abortSignal" | "timeoutMs">) => withTimeoutSignal(input);

const toUint8Array = (data: AudioInput["data"]) => {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return Uint8Array.from(Buffer.from(data, "base64"));
};

const toBase64 = (data: string | Uint8Array | ArrayBuffer) =>
  typeof data === "string" ? data : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)).toString("base64");

const createAudioFile = (audio: AudioInput) => {
  const bytes = toUint8Array(audio.data);
  return new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], audio.filename ?? "audio", {
    type: audio.mediaType
  });
};

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

const parseJson = async (
  response: Response,
  options: {
    maxBytes?: number;
    errorBodyBytes?: number;
    provider?: string;
    endpoint?: string;
    abort?: (reason?: unknown) => void;
  } = {}
) => {
  if (!response.ok) {
    const body = await readErrorBodyWithLimit(response, options.errorBodyBytes);
    throw new ProviderHTTPError(`OpenAI request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return options.maxBytes
    ? readJsonWithLimit<any>(response, {
        maxBytes: options.maxBytes,
        provider: options.provider ?? "openai",
        endpoint: options.endpoint,
        abort: options.abort
      })
    : response.json();
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
        image_url: { url: part.image, ...(detail ? { detail } : {}) },
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

const assertResponsesToolsSupported = (modelId: string, tools: ModelGenerateInput["tools"]) => {
  const currentCapabilities = modelCapabilities(modelId).agentCapabilities;
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
    if (type === "shell" && !supportsOpenAIShell(modelId)) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses ${type} tool.`);
    }
    if (type === "apply_patch" && !supportsOpenAIApplyPatchAndSkills(modelId)) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses ${type} tool.`);
    }
    if (type === "skill" && !currentCapabilities?.skills) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses skills tool.`);
    }
    if (type === "programmatic_tool_calling" && !isOpenAIGpt56Model(modelId)) {
      throw new UnsupportedFeatureError(
        `Provider "openai" model "${modelId}" does not support Programmatic Tool Calling.`
      );
    }
  }
};

const assertOpenAIResponsesOptionsSupported = (modelId: string, options: OpenAILanguageModelOptions) => {
  if (options.multi_agent?.enabled && !isOpenAIGpt56Model(modelId)) {
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

const mapRealtimeSessionConfig = (config: RealtimeSessionConfig, modelId?: string) => {
  const mode = inferOpenAIRealtimeMode(modelId ?? "", config.mode);
  const tools = mapTools(toToolSet(config.tools));
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
    tool_choice: mode === "conversation" && config.toolChoice ? mapToolChoice(config.toolChoice) : undefined,
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

const parseOpenAIRealtimeEvent = (payload: Record<string, unknown>) => {
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
        providerMetadata: parseRealtimeProviderMetadata(payload)
      }
    ];
  }
  if (type === "response.audio.delta" || type === "response.output_audio.delta") {
    return [
      {
        type: "realtime-audio-output" as const,
        audio: Buffer.from(String(payload.delta ?? ""), "base64"),
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

const serializeToolOutput = (message: ModelMessage) =>
  message.parts
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "tool-result" }> => part.type === "tool-result")
    .map((part) => {
      const responsesToolType = part.toolResult.providerMetadata?.responsesToolType;
      if (part.toolResult.toolName === "shell" || responsesToolType === "shell") {
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

      if (part.toolResult.toolName === "apply_patch" || responsesToolType === "apply_patch") {
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

      if (part.toolResult.toolName === "computer" || responsesToolType === "computer") {
        if (part.toolResult.isError) {
          throw new Error(
            `OpenAI computer action execution failed: ${part.toolResult.error?.message ?? "unknown error"}`
          );
        }
        return {
          type: "computer_call_output",
          call_id: part.toolResult.toolCallId,
          output: part.toolResult.output
        };
      }

      return {
        type: "function_call_output",
        call_id: part.toolResult.toolCallId,
        output: JSON.stringify(part.toolResult.isError ? part.toolResult.error : part.toolResult.output ?? null),
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
    ["message", "function_call"].includes(typedItem.type)
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

const toResponsesInput = (messages: ModelMessage[]) => {
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push(...serializeToolOutput(message));
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
          content.push({ type: "input_text", text: part.text, ...promptCacheBreakpointForContentPart(part) });
          break;
        case "image":
          const detail = imageDetailForPart(part);
          content.push({
            type: "input_image",
            image_url: part.image,
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
  localTools: Map<string, string> = new Map()
): ModelMessage => {
  const parts: ModelMessage["parts"] = [];

  for (const [index, item] of (json.output ?? []).entries()) {
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
      const callId = item.call_id ?? item.id ?? `${item.name}-${index}`;
      parts.push({
        type: "tool-call",
        toolCall: {
          id: callId,
          name: item.name,
          input: JSON.parse(item.arguments ?? "{}"),
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

    if (item?.type === "computer_call" && localTools.has("computer")) {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: item.call_id ?? item.id ?? `computer-${index}`,
          name: localTools.get("computer")!,
          input: {
            actions: Array.isArray(item.actions) ? item.actions : []
          } as JsonValue,
          providerMetadata: { responsesToolType: "computer" }
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

const normalizeResponsesFinishReason = (
  status: string | undefined,
  hasToolCalls: boolean,
  hasRefusal = false
) => {
  if (hasToolCalls) {
    return "tool-calls" as const;
  }

  if (hasRefusal) {
    return "refusal" as const;
  }

  if (status === "completed") {
    return "stop" as const;
  }

  if (status === "failed") {
    return "error" as const;
  }

  return normalizeFinishReason(status);
};

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
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
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
  localTools: Map<string, string> = new Map()
): AsyncGenerator<StreamEvent, void, undefined> {
  const toolBuffers = new Map<string, { callId: string; name: string; args: string; caller?: JsonValue; emitted: boolean }>();
  const outputAgents = new Map<number, { agentName?: string }>();
  let sawToolCalls = false;
  let sawRefusal = false;

  const emitToolCall = (key: string) => {
    const toolCall = toolBuffers.get(key);
    if (!toolCall || toolCall.emitted || !toolCall.name) {
      return undefined;
    }

    toolCall.emitted = true;
    sawToolCalls = true;

    return {
      type: "tool-call",
      toolCall: {
        id: toolCall.callId,
        name: toolCall.name,
        input: JSON.parse(toolCall.args || "{}"),
        ...(toolCall.caller !== undefined ? { providerMetadata: { caller: toolCall.caller } } : {})
      }
    } satisfies StreamEvent;
  };

  for await (const event of streamSSE(response)) {
    if (event.data === "[DONE]") {
      return;
    }

    const json = JSON.parse(event.data);
    const type = json.type as string | undefined;

    if (type === "error") {
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
      if (typeof json.output_index === "number" && item?.type === "message") {
        outputAgents.set(json.output_index, {
          agentName: item.agent?.agent_name
        });
      }
      if (item?.type === "function_call") {
        const key = item.id ?? json.item_id ?? `${json.output_index ?? toolBuffers.size}`;
        const existing: {
          callId: string;
          name: string;
          args: string;
          caller?: JsonValue;
          emitted: boolean;
        } = toolBuffers.get(key) ?? {
          callId: item.call_id ?? key,
          name: item.name ?? "",
          args: "",
          emitted: false
        };
        existing.callId = item.call_id ?? existing.callId;
        existing.name ||= item.name ?? "";
        if (item.caller && typeof item.caller === "object") {
          existing.caller = item.caller as JsonValue;
        }
        if (typeof item.arguments === "string") {
          existing.args = item.arguments;
        }
        toolBuffers.set(key, existing);

        if (type === "response.output_item.done") {
          const emitted = emitToolCall(key);
          if (emitted) {
            yield emitted;
          }
        }
      }

      if (item?.type === "shell_call" && type === "response.output_item.done" && localTools.has("shell")) {
        yield {
          type: "tool-call",
          toolCall: {
            id: item.call_id ?? item.id ?? `${json.output_index ?? "shell"}`,
            name: localTools.get("shell")!,
            input: parseShellCallInput(item) as JsonValue,
            providerMetadata: { responsesToolType: "shell" }
          }
        } satisfies StreamEvent;
        sawToolCalls = true;
        handledLocalToolCall = true;
      }

      if (item?.type === "apply_patch_call" && type === "response.output_item.done" && localTools.has("apply_patch")) {
        yield {
          type: "tool-call",
          toolCall: {
            id: item.call_id ?? item.id ?? `${json.output_index ?? "apply_patch"}`,
            name: localTools.get("apply_patch")!,
            input: parseApplyPatchCallInput(item) as JsonValue,
            providerMetadata: { responsesToolType: "apply_patch" }
          }
        } satisfies StreamEvent;
        sawToolCalls = true;
        handledLocalToolCall = true;
      }

      if (item?.type === "computer_call" && type === "response.output_item.done" && localTools.has("computer")) {
        yield {
          type: "tool-call",
          toolCall: {
            id: item.call_id ?? item.id ?? `${json.output_index ?? "computer"}`,
            name: localTools.get("computer")!,
            input: {
              actions: Array.isArray(item.actions) ? item.actions : []
            } as JsonValue,
            providerMetadata: { responsesToolType: "computer" }
          }
        } satisfies StreamEvent;
        sawToolCalls = true;
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
        yield {
          type: "provider-data",
          provider: "openai",
          data: {
            type: "responses_output",
            items: [item]
          } as JsonValue
        } satisfies StreamEvent;
      }
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      const key = json.item_id ?? `${json.output_index ?? toolBuffers.size}`;
      const existing = toolBuffers.get(key) ?? {
        callId: key,
        name: "",
        args: "",
        emitted: false
      };
      existing.args += typeof json.delta === "string" ? json.delta : "";
      toolBuffers.set(key, existing);
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const key = json.item_id ?? `${json.output_index ?? toolBuffers.size}`;
      const existing = toolBuffers.get(key) ?? {
        callId: key,
        name: "",
        args: "",
        emitted: false
      };
      if (typeof json.arguments === "string") {
        existing.args = json.arguments;
      }
      toolBuffers.set(key, existing);
      const emitted = emitToolCall(key);
      if (emitted) {
        yield emitted;
      }
      continue;
    }

    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      const responseData = json.response ?? {};
      if (typeof responseData.id === "string") {
        yield {
          type: "provider-data",
          provider: "openai",
          data: { responseId: responseData.id }
        } satisfies StreamEvent;
      }
      yield {
        type: "finish",
        finishReason: normalizeResponsesFinishReason(responseData.status, sawToolCalls, sawRefusal),
        providerFinishReason: responseData.status,
        usage: mapResponsesUsage(responseData.usage)
      } satisfies StreamEvent;
    }
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
  yield {
    type: "finish",
    finishReason: result.finishReason,
    providerFinishReason: result.providerFinishReason,
    usage: result.usage
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
    private readonly fetcher: typeof globalThis.fetch
  ) {
    this.capabilities = modelCapabilities(modelId);
  }

  private usesResponsesAPI(input: ModelGenerateInput, options: ReturnType<typeof resolveOpenAILanguageRequestOptions>) {
    const requiresResponses = hasResponsesOnlyTools(input.tools) || options.multiAgentEnabled;
    if (options.apiMode === "chat") {
      if (requiresResponses) {
        throw new UnsupportedFeatureError(
          'Provider "openai" cannot use apiMode "chat" with Responses-only tools or Multi-agent.'
        );
      }
      return false;
    }
    return options.apiMode === "responses" || requiresResponses || isOpenAIGpt56Model(this.modelId);
  }

  private async generateViaResponses(
    input: ModelGenerateInput,
    signal: AbortSignal | undefined,
    options: ReturnType<typeof resolveOpenAILanguageRequestOptions>
  ): Promise<GenerateResult> {
    const responseBodyOptions = openAIResponsesBodyOptions(options.bodyOptions, this.modelId);
    assertResponsesToolsSupported(this.modelId, input.tools);
    assertOpenAIResponsesOptionsSupported(this.modelId, responseBodyOptions);
    const previousResponse = responseBodyOptions.store === false ? undefined : getProviderResponseId(input.messages);
    const messages =
      previousResponse && previousResponse.index < input.messages.length - 1
        ? input.messages.slice(previousResponse.index + 1)
        : input.messages;
    let nextPreviousResponseId = previousResponse?.responseId;
    let nextInput = messages.length ? toResponsesInput(messages) : [];
    let accumulatedUsage: ReturnType<typeof mapResponsesUsage>;
    let statelessInternalOutputs: Array<Record<string, unknown>> = [];

    for (let continuation = 0; continuation < 8; continuation += 1) {
      const response = await withRetry(
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
              text: mapResponsesStructuredOutput(input),
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              ...mapResponsesReasoning(input, responseBodyOptions.reasoning)
            })
          }),
        input
      );

      const json = await parseJson(response);
      accumulatedUsage = addTokenUsage(accumulatedUsage, mapResponsesUsage(json.usage));
      const assistantMessage = parseResponsesAssistantMessage(
        json,
        options.multiAgentEnabled,
        localResponsesTools(input.tools)
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
          finishReason: normalizeResponsesFinishReason(json.status, hasToolCalls, hasRefusal),
          providerFinishReason: json.status,
          usage: accumulatedUsage,
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

    throw new ProviderHTTPError("OpenAI Programmatic Tool Calling exceeded 8 internal continuations.", 500);
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { signal, cleanup } = getRequestOptions(input);
    const options = resolveOpenAILanguageRequestOptions(input.providerOptions, this.apiKey);

    try {
      if (this.usesResponsesAPI(input, options)) {
        return await this.generateViaResponses(input, signal, options);
      }

      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: options.headers,
            signal,
            body: JSON.stringify({
              ...options.bodyOptions,
              model: this.modelId,
              messages: mapMessages(input.messages),
              tools: mapTools(input.tools),
              ...(input.toolChoice ? { tool_choice: mapToolChoice(input.toolChoice) } : {}),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
              ...mapChatReasoning(input),
              stream: false
            })
          }),
        input
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
      assertResponsesToolsSupported(this.modelId, input.tools);
      assertOpenAIResponsesOptionsSupported(this.modelId, responseBodyOptions);
      const { signal, cleanup } = getRequestOptions(input);
      if (hasProgrammaticToolCalling(input.tools)) {
        const result = await this.generateViaResponses(input, signal, options);
        return (async function* () {
          try {
            yield* streamGenerateResult(result);
          } finally {
            cleanup();
          }
        })();
      }
      const previousResponse = responseBodyOptions.store === false ? undefined : getProviderResponseId(input.messages);
      const messages =
        previousResponse && previousResponse.index < input.messages.length - 1
          ? input.messages.slice(previousResponse.index + 1)
          : input.messages;
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: options.headers,
            signal,
            body: JSON.stringify({
              ...responseBodyOptions,
              model: this.modelId,
              ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
              ...(messages.length ? { input: toResponsesInput(messages) } : {}),
              tools: mapResponsesTools(input.tools),
              ...(input.toolChoice ? { tool_choice: mapResponsesToolChoice(input.toolChoice) } : {}),
              text: mapResponsesStructuredOutput(input),
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              ...mapResponsesReasoning(input, responseBodyOptions.reasoning),
              stream: true
            })
          }),
        input
      );

      return (async function* () {
        try {
          yield* streamResponses(response, options.multiAgentEnabled, localResponsesTools(input.tools));
        } finally {
          cleanup();
        }
      })();
    }

    const { signal, cleanup } = getRequestOptions(input);
    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: options.headers,
          signal,
          body: JSON.stringify({
            ...options.bodyOptions,
            model: this.modelId,
            messages: mapMessages(input.messages),
            tools: mapTools(input.tools),
            ...(input.toolChoice ? { tool_choice: mapToolChoice(input.toolChoice) } : {}),
            response_format: mapStructuredOutput(input),
            temperature: input.temperature,
            ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
            ...mapChatReasoning(input),
            stream: true,
            stream_options: { include_usage: true }
          })
        }),
      input
    );

    return (async function* () {
      try {
        const toolBuffers = new Map<string, { name: string; args: string }>();

        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            return;
          }

          const json = JSON.parse(event.data);
          const choice = json.choices?.[0];
          const delta = choice?.delta;

          if (delta?.content) {
            yield { type: "text-delta", textDelta: delta.content } satisfies StreamEvent;
          }

          for (const toolCall of delta?.tool_calls ?? []) {
            const id = toolCall.id ?? `${toolCall.index}`;
            const existing = toolBuffers.get(id) ?? {
              name: toolCall.function?.name ?? "",
              args: ""
            };
            existing.name ||= toolCall.function?.name ?? "";
            existing.args += toolCall.function?.arguments ?? "";
            toolBuffers.set(id, existing);

            if (choice?.finish_reason === "tool_calls") {
              yield {
                type: "tool-call",
                toolCall: {
                  id,
                  name: existing.name,
                  input: JSON.parse(existing.args || "{}")
                }
              } satisfies StreamEvent;
            }
          }

          if (choice?.finish_reason) {
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(choice.finish_reason),
              providerFinishReason: choice.finish_reason,
              usage: mapChatUsage(json.usage)
            } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
  }
}

class OpenAIEmbeddingModel implements EmbeddingModel {
  readonly provider = "openai";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async embed(input: EmbedInput & { abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<EmbedResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const values = input.values.map((value) => {
      if (typeof value !== "string") {
        throw new UnsupportedFeatureError('Provider "openai" does not support multimodal embedding values.');
      }
      return value;
    });

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/embeddings`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: values
            })
          }),
        input
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

class OpenAITranscriptionModel implements TranscriptionModel {
  readonly provider = "openai";
  readonly capabilities = transcriptionCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
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
    form.set("model", this.modelId);
    form.set("file", createAudioFile(input.audio));
    if (input.prompt) {
      form.set("prompt", input.prompt);
    }
    if (input.language) {
      form.set("language", input.language);
    }

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/audio/transcriptions`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}` },
            signal,
            body: form
          }),
        input
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

class OpenAISpeechModel implements SpeechModel {
  readonly provider = "openai";
  readonly capabilities = speechCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
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
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/audio/speech`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              model: this.modelId,
              input: input.input,
              voice: input.voice ?? "alloy"
            })
          }),
        input
      );

      if (!response.ok) {
        const body = await readErrorBodyWithLimit(response, this.responseLimits.errorBodyBytes);
        throw new ProviderHTTPError(`OpenAI request failed with status ${response.status}.`, response.status, {
          responseBody: body
        });
      }

      return {
        audio: await readBodyWithLimit(response, {
          maxBytes: this.responseLimits.speechBytes,
          provider: "openai",
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

class OpenAIRealtimeModel implements RealtimeModel {
  readonly provider = "openai";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly connectionFactory?: RealtimeConnectionFactory,
    private readonly realtimeURL?: string,
    private readonly browserTokenURL?: string
  ) {
    this.capabilities = realtimeCapabilities(modelId);
  }

  private resolveConfig(config: RealtimeSessionConfig): RealtimeSessionConfig {
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
    const headers = {
      authorization: `Bearer ${this.apiKey}`
    };
    const connection = await (this.connectionFactory ?? openWebSocketConnection)(
      this.realtimeURL ??
        openAIRealtimeURL(
          this.baseURL,
          this.modelId,
          inferOpenAIRealtimeMode(this.modelId, initialConfig.mode),
          initialConfig.providerOptions as Record<string, unknown> | undefined
        ),
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

    const response = await withRetry(
      () =>
        this.fetcher(this.browserTokenURL ?? `${this.baseURL}/realtime/client_secrets`, {
          method: "POST",
          headers: jsonHeaders(this.apiKey),
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
          signal: options?.signal
        }),
      {
        timeoutMs: options?.timeoutMs
      }
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
  }
}

export const createOpenAI = (
  options: OpenAIProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing OpenAI API key.");
  }

  const baseURL = options.baseURL ?? "https://api.openai.com/v1";
  const fetcher = options.fetch ?? globalThis.fetch;
  const responseLimits = resolveAudioResponseLimits(options.responseLimits);

  return createProviderAdapter({
    name: "openai",
    languageModel: (modelId) => new OpenAILanguageModel(modelId, apiKey, baseURL, fetcher),
    embeddingModel: (modelId) => new OpenAIEmbeddingModel(modelId, apiKey, baseURL, fetcher),
    transcriptionModel: (modelId) => new OpenAITranscriptionModel(modelId, apiKey, baseURL, fetcher, responseLimits),
    speechModel: (modelId) => new OpenAISpeechModel(modelId, apiKey, baseURL, fetcher, responseLimits),
    realtimeModel: (modelId) =>
      new OpenAIRealtimeModel(
        modelId,
        apiKey,
        baseURL,
        fetcher,
        options.realtimeConnectionFactory,
        options.realtimeURL,
        options.browserTokenURL
      ),
    groundedLanguageModel: (modelId) => new OpenAIGroundedLanguageModel(modelId, apiKey, baseURL, fetcher),
    rawFetch: fetcher
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

export const openAIComputerTool = (
  config: OpenAIComputerToolConfig
): ToolDefinition<z.ZodType<OpenAIComputerCallInput>, JsonValue> => ({
  name: config.name ?? "computer",
  description: "Execute batched actions requested by the OpenAI Responses computer tool and return a screenshot.",
  requiresApproval: config.requiresApproval ?? true,
  metadata: {
    [openAIResponsesToolMetadataKey]: "computer",
    "openai.responses_tool_config": {}
  },
  schema: z.object({
    actions: z.array(z.record(z.string(), z.unknown()))
  }) as z.ZodType<OpenAIComputerCallInput>,
  execute: async (input) => {
    const output = await config.execute(input);
    return {
      ...output,
      detail: "original"
    } as unknown as JsonValue;
  }
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
