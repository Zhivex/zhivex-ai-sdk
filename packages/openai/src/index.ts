import { toJSONSchema, z } from "zod";

import {
  CallbackRealtimeSession,
  ConfigurationError,
  ProviderHTTPError,
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
}

export interface OpenAIShellToolConfig {
  name?: string;
  cwd?: string;
  rootDir?: string;
  timeoutMs?: number;
  maxOutputLength?: number;
  execute?: (input: OpenAIShellToolInput) => Promise<OpenAIShellToolOutput> | OpenAIShellToolOutput;
}

export interface OpenAIShellToolInput {
  command?: string;
  action?: {
    command?: string;
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

const openAIResponsesToolMetadataKey = "openai.responses_tool_type";

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

export type OpenAIProviderData = { responseId: string } | OpenAIMcpApprovalRequest | OpenAIMcpApprovalResponse | OpenAIMcpCall | OpenAIMcpListTools;

export interface OpenAILanguageModelOptions {
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
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

const supportsOpenAIToolSearch = (modelId: string) => {
  const normalized = normalizeModelId(modelId);
  return /^gpt-5\.4(?:$|-20|-pro)/.test(normalized);
};

const supportsOpenAIComputerUse = (modelId: string) => {
  const normalized = normalizeModelId(modelId);
  return /^(?:gpt-5\.5|gpt-5\.4)(?:$|-20|-pro|-mini)/.test(normalized);
};

const supportsOpenAIHostedHarnessTools = (modelId: string) => /^gpt-5\.4(?:$|-)/.test(normalizeModelId(modelId));

const supportsOpenAIChatAudio = (modelId: string) => {
  const normalized = normalizeModelId(modelId);
  return /^(?:gpt-audio(?:-|$)|gpt-4o(?:-mini)?-audio-preview(?:-|$))/.test(normalized);
};

const modelCapabilities = (modelId: string): ModelCapabilities => ({
  ...capabilities,
  audioInput: supportsOpenAIChatAudio(modelId),
  audioOutput: supportsOpenAIChatAudio(modelId),
  agentCapabilities: {
    ...capabilities.agentCapabilities!,
    computerUse: supportsOpenAIComputerUse(modelId),
    shell: supportsOpenAIHostedHarnessTools(modelId),
    applyPatch: supportsOpenAIHostedHarnessTools(modelId),
    skills: supportsOpenAIHostedHarnessTools(modelId),
    toolSearch: supportsOpenAIToolSearch(modelId)
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

const createAudioFile = (audio: AudioInput) =>
  new File([toUint8Array(audio.data).buffer as ArrayBuffer], audio.filename ?? "audio", {
    type: audio.mediaType
  });

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

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`OpenAI request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const mapContentParts = (message: ModelMessage) => {
  const textParts = message.parts.filter((part) => part.type === "text");
  const imageParts = message.parts.filter((part) => part.type === "image");
  const audioParts = message.parts.filter((part) => part.type === "audio");

  if (!imageParts.length && !audioParts.length) {
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
        url: part.image
      }
    })),
    ...audioParts.map((part) => ({
      type: "input_audio",
      input_audio: {
        data: toBase64(part.data),
        format: inferOpenAIAudioFormat(part.mediaType, part.format)
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
  Object.values(tools ?? {}).some((tool) => isHostedToolDefinition(tool) || (isCallableToolDefinition(tool) && openAILocalResponsesToolType(tool)));

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
    if ((type === "shell" || type === "apply_patch") && !supportsOpenAIHostedHarnessTools(modelId)) {
      throw new UnsupportedFeatureError(`Provider "openai" model "${modelId}" does not support the Responses ${type} tool.`);
    }
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
            parameters: toJSONSchema(tool.schema)
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

const mapReasoning = (input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return {};
  }

  if (input.reasoning.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "openai" does not support "reasoning.budgetTokens".');
  }

  return {
    reasoning_effort: input.reasoning.effort,
    max_completion_tokens: input.maxTokens
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
        part.provider === "openai" &&
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

    input.push(...serializeProviderDataInput(message));

    const content: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          content.push({ type: "input_text", text: part.text });
          break;
        case "image":
          content.push({ type: "input_image", image_url: part.image });
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
      parts.push(providerDataPart("openai", providerData));
    }
  }

  if (!parts.some((part) => part.type === "text") && typeof json.output_text === "string" && json.output_text) {
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

const normalizeResponsesFinishReason = (status: string | undefined, hasToolCalls: boolean) => {
  if (hasToolCalls) {
    return "tool-calls" as const;
  }

  if (status === "completed") {
    return "stop" as const;
  }

  if (status === "failed") {
    return "error" as const;
  }

  return normalizeFinishReason(status);
};

const streamResponses = async function* (
  response: Response
): AsyncGenerator<StreamEvent, void, undefined> {
  const toolBuffers = new Map<string, { callId: string; name: string; args: string; emitted: boolean }>();
  let sawToolCalls = false;

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
        input: JSON.parse(toolCall.args || "{}")
      }
    } satisfies StreamEvent;
  };

  for await (const event of streamSSE(response)) {
    if (event.data === "[DONE]") {
      return;
    }

    const json = JSON.parse(event.data);
    const type = json.type as string | undefined;

    if (type === "response.output_text.delta" && typeof json.delta === "string") {
      yield { type: "text-delta", textDelta: json.delta } satisfies StreamEvent;
      continue;
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = json.item;
      if (item?.type === "function_call") {
        const key = item.id ?? json.item_id ?? `${json.output_index ?? toolBuffers.size}`;
        const existing = toolBuffers.get(key) ?? {
          callId: item.call_id ?? key,
          name: item.name ?? "",
          args: "",
          emitted: false
        };
        existing.callId = item.call_id ?? existing.callId;
        existing.name ||= item.name ?? "";
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

      if (item?.type === "shell_call" && type === "response.output_item.done") {
        yield {
          type: "tool-call",
          toolCall: {
            id: item.call_id ?? item.id ?? `${json.output_index ?? "shell"}`,
            name: "shell",
            input: parseShellCallInput(item) as JsonValue
          }
        } satisfies StreamEvent;
        sawToolCalls = true;
      }

      if (item?.type === "apply_patch_call" && type === "response.output_item.done") {
        yield {
          type: "tool-call",
          toolCall: {
            id: item.call_id ?? item.id ?? `${json.output_index ?? "apply_patch"}`,
            name: "apply_patch",
            input: parseApplyPatchCallInput(item) as JsonValue
          }
        } satisfies StreamEvent;
        sawToolCalls = true;
      }

      const providerData = parseResponsesProviderData(item);
      if (providerData && type === "response.output_item.done") {
        yield {
          type: "provider-data",
          provider: "openai",
          data: providerData
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
      yield {
        type: "finish",
        finishReason: normalizeResponsesFinishReason(responseData.status, sawToolCalls),
        providerFinishReason: responseData.status,
        usage: responseData.usage
          ? {
              inputTokens: responseData.usage.input_tokens,
              outputTokens: responseData.usage.output_tokens,
              totalTokens: responseData.usage.total_tokens
            }
          : undefined
      } satisfies StreamEvent;
    }
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

  private usesResponsesAPI(input: ModelGenerateInput) {
    return hasResponsesOnlyTools(input.tools);
  }

  private async generateViaResponses(input: ModelGenerateInput, signal: AbortSignal | undefined): Promise<GenerateResult> {
    assertResponsesToolsSupported(this.modelId, input.tools);
    const previousResponse = getProviderResponseId(input.messages);
    const messages =
      previousResponse && previousResponse.index < input.messages.length - 1
        ? input.messages.slice(previousResponse.index + 1)
        : input.messages;
    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/responses`, {
          method: "POST",
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify({
            ...input.providerOptions,
            model: this.modelId,
            ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
            ...(messages.length ? { input: toResponsesInput(messages) } : {}),
            tools: mapResponsesTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            text: mapResponsesStructuredOutput(input),
            temperature: input.temperature,
            max_output_tokens: input.maxTokens,
            ...mapReasoning(input)
          })
        }),
      input
    );

    const json = await parseJson(response);
    const assistantMessage = parseResponsesAssistantMessage(json);
    const hasToolCalls = assistantMessage.parts.some((part) => part.type === "tool-call");

    return {
      messages: [assistantMessage],
      text: extractMessageText(assistantMessage),
      audio: extractAudioOutputs(assistantMessage),
      finishReason: normalizeResponsesFinishReason(json.status, hasToolCalls),
      providerFinishReason: json.status,
      usage: {
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
        totalTokens: json.usage?.total_tokens
      },
      rawResponse: json
    };
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { signal, cleanup } = getRequestOptions(input);

    try {
      if (this.usesResponsesAPI(input)) {
        return await this.generateViaResponses(input, signal);
      }

      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              model: this.modelId,
              messages: mapMessages(input.messages),
              tools: mapTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
              ...mapReasoning(input),
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
        usage: {
          inputTokens: json.usage?.prompt_tokens,
          outputTokens: json.usage?.completion_tokens,
          totalTokens: json.usage?.total_tokens
        },
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
    if (this.usesResponsesAPI(input)) {
      assertResponsesToolsSupported(this.modelId, input.tools);
      const { signal, cleanup } = getRequestOptions(input);
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              model: this.modelId,
              input: toResponsesInput(input.messages),
              tools: mapResponsesTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              text: mapResponsesStructuredOutput(input),
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              ...mapReasoning(input),
              stream: true
            })
          }),
        input
      );

      return (async function* () {
        try {
          yield* streamResponses(response);
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
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify({
            ...input.providerOptions,
            model: this.modelId,
            messages: mapMessages(input.messages),
            tools: mapTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            response_format: mapStructuredOutput(input),
            temperature: input.temperature,
            ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
            ...mapReasoning(input),
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
              usage: json.usage
                ? {
                    inputTokens: json.usage.prompt_tokens,
                    outputTokens: json.usage.completion_tokens,
                    totalTokens: json.usage.total_tokens
                  }
                : undefined
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
    const form = new FormData();
    form.set("model", this.modelId);
    form.set("file", createAudioFile(input.audio));
    if (input.prompt) {
      form.set("prompt", input.prompt);
    }
    if (input.language) {
      form.set("language", input.language);
    }

    for (const [key, value] of Object.entries(input.providerOptions ?? {})) {
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
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

      const json = await parseJson(response);
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
        const body = await response.text();
        throw new ProviderHTTPError(`OpenAI request failed with status ${response.status}.`, response.status, {
          responseBody: body
        });
      }

      return {
        audio: new Uint8Array(await response.arrayBuffer()),
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

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
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
        input
      );

      const json = await parseJson(response);
      return {
        text: json.output_text ?? "",
        sources: extractSources(json),
        usage: {
          inputTokens: json.usage?.input_tokens,
          outputTokens: json.usage?.output_tokens,
          totalTokens: json.usage?.total_tokens
        },
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

  return createProviderAdapter({
    name: "openai",
    languageModel: (modelId) => new OpenAILanguageModel(modelId, apiKey, baseURL, fetcher),
    embeddingModel: (modelId) => new OpenAIEmbeddingModel(modelId, apiKey, baseURL, fetcher),
    transcriptionModel: (modelId) => new OpenAITranscriptionModel(modelId, apiKey, baseURL, fetcher),
    speechModel: (modelId) => new OpenAISpeechModel(modelId, apiKey, baseURL, fetcher),
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
): Promise<OpenAIShellToolOutput> => {
  if (config.execute) {
    return config.execute(input);
  }

  const command = input.command ?? input.action?.command;
  if (!command) {
    throw new Error("OpenAI shell tool did not provide a command.");
  }

  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);
  const maxBuffer = Math.max(1024, config.maxOutputLength ?? input.maxOutputLength ?? input.max_output_length ?? input.action?.maxOutputLength ?? input.action?.max_output_length ?? 20000);
  const cwd = config.rootDir
    ? await assertOpenAIToolPathInsideRoot(config.rootDir, config.cwd ?? ".", "shell cwd")
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

export const openAIShellTool = (config: OpenAIShellToolConfig = {}): ToolDefinition<z.ZodType<OpenAIShellToolInput>, JsonValue> => ({
  name: config.name ?? "shell",
  description: "Run a shell command requested by the OpenAI Responses shell tool.",
  requiresApproval: true,
  metadata: {
    [openAIResponsesToolMetadataKey]: "shell",
    "openai.responses_tool_config": {}
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
    "openai.responses_tool_config": {}
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
