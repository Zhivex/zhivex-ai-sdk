import { toJSONSchema } from "zod";

import {
  CallbackRealtimeSession,
  ConfigurationError,
  decodeBase64WithLimit,
  ProviderHTTPError,
  readBodyWithLimit,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  resolveAudioResponseLimits,
  UnsupportedFeatureError,
  createProviderAdapter,
  hostedTool,
  openWebSocketConnection,
  isCallableToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  streamSSE,
  toToolSet,
  withRetry,
  withTimeoutSignal,
  type AudioFrame,
  type AudioInput,
  type AudioResponseLimits,
  type BatchCancelInput,
  type BatchCreateInput,
  type BatchDeleteInput,
  type BatchGetInput,
  type BatchJob,
  type BatchListInput,
  type BatchesClient,
  type CallableProviderAdapter,
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  type FileDeleteInput,
  type FileGetInput,
  type FileListInput,
  type FileUploadInput,
  type FilesClient,
  type GenerateResult,
  type GeneratedMedia,
  type ImageGenerationModel,
  type ImageGenerationResult,
  type JsonValue,
  type LanguageModel,
  type MediaFrame,
  type MediaInput,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type PredictionOperation,
  type ProviderAdapter,
  type RealtimeConnectOptions,
  type RealtimeConnectionFactory,
  type RealtimeEvent,
  type RealtimeModel,
  type RealtimeSessionConfig,
  type SpeechModel,
  type SpeechResult,
  type StreamEvent,
  type ToolExecutionResult,
  type TranscriptionModel,
  type TranscriptionResult,
  type UploadedFile,
  type VideoGenerationModel,
  type VideoGenerationResult
} from "@zhivex-ai/core";

export interface QwenProviderOptions {
  apiKey?: string;
  workspaceId?: string;
  region?: QwenRegion;
  baseURL?: string;
  taskBaseURL?: string;
  realtimeURL?: string;
  realtimeConnectionFactory?: RealtimeConnectionFactory;
  fetch?: typeof globalThis.fetch;
  responseLimits?: AudioResponseLimits;
  speechAudioURLValidator?: QwenSpeechAudioURLValidator;
  speechAudioMaxRedirects?: number;
}

export type QwenSpeechAudioURLValidator = (url: URL) => boolean | Promise<boolean>;

export interface QwenLanguageModelOptions {
  apiMode?: "auto" | "responses" | "chat";
  conversation?: string;
  instructions?: string;
  "x-dashscope-session-cache"?: "enable" | "disable";
  enable_thinking?: boolean;
  thinking_budget?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  [key: string]: unknown;
}

export type QwenRegion = "singapore" | "beijing" | "hong-kong" | "tokyo" | "frankfurt" | "virginia";

export type QwenRerankValue = string | MediaInput;

export interface QwenRerankInput {
  query: QwenRerankValue;
  documents: QwenRerankValue[];
  topN?: number;
  providerOptions?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
}

export interface QwenRerankResult {
  results: Array<{ index: number; document: QwenRerankValue; relevanceScore: number; providerMetadata?: Record<string, unknown> }>;
  rawResponse?: unknown;
}

export interface QwenRerankModel {
  readonly provider: "qwen";
  readonly modelId: string;
  rerank(input: QwenRerankInput): Promise<QwenRerankResult>;
}

export interface QwenMultimodalEmbeddingModel extends EmbeddingModel {
  embed(
    input: EmbedInput & {
      providerOptions?: Record<string, unknown>;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
    }
  ): Promise<EmbedResult>;
}

export interface QwenTasksClient {
  get(input: { name: string; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<PredictionOperation>;
  cancel(input: { name: string; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<PredictionOperation>;
}

export type QwenProvider = CallableProviderAdapter &
  ProviderAdapter & {
    rawFetch: typeof globalThis.fetch;
    rerankModel(modelId: string): QwenRerankModel;
    multimodalEmbeddingModel(modelId: string): QwenMultimodalEmbeddingModel;
    tasks: QwenTasksClient;
  };

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: true,
  reasoning: false,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: true,
    remoteMcp: true,
    computerUse: false,
    codeExecution: true,
    webExtraction: true,
    toolsets: false
  }
};

const embeddingCapabilities: ModelCapabilities = {
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: true,
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

const qwenTaskBaseURLFrom = (baseURL: string) => {
  const url = new URL(baseURL);
  return `${url.protocol}//${url.host}/api/v1`;
};

const QWEN_REGION_HOSTS: Record<QwenRegion, string> = {
  singapore: "ap-southeast-1.maas.aliyuncs.com",
  beijing: "cn-beijing.maas.aliyuncs.com",
  "hong-kong": "cn-hongkong.maas.aliyuncs.com",
  tokyo: "ap-northeast-1.maas.aliyuncs.com",
  frankfurt: "eu-central-1.maas.aliyuncs.com",
  virginia: "dashscope-us.aliyuncs.com"
};

const qwenWorkspaceURLs = (workspaceId: string, region: QwenRegion) => {
  const origin =
    region === "virginia"
      ? `https://${QWEN_REGION_HOSTS[region]}`
      : `https://${workspaceId}.${QWEN_REGION_HOSTS[region]}`;
  return {
    baseURL: `${origin}/compatible-mode/v1`,
    taskBaseURL: `${origin}/api/v1`,
    realtimeURL: `${origin.replace(/^https:/, "wss:")}/api-ws/v1/realtime`
  };
};

const toUint8Array = async (data: string | Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> => {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return Uint8Array.from(Buffer.from(String(data), "base64"));
};

const toBase64 = async (data: string | Uint8Array | ArrayBuffer | Blob) =>
  typeof data === "string" ? data : Buffer.from(await toUint8Array(data)).toString("base64");

const toDataURL = (data: string | Uint8Array | ArrayBuffer, mediaType: string) => {
  if (typeof data === "string" && (/^data:/i.test(data) || /^https?:\/\//i.test(data))) {
    return data;
  }

  const encoded =
    typeof data === "string"
      ? data
      : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)).toString("base64");
  return `data:${mediaType};base64,${encoded}`;
};

const mediaValue = (input: MediaInput) => {
  if (input.uri) {
    return input.uri;
  }
  if (input.data === undefined) {
    throw new ConfigurationError("Qwen media input requires either uri or data.");
  }
  return toDataURL(input.data, input.mediaType);
};

const createFile = async (data: string | Uint8Array | ArrayBuffer | Blob, mediaType: string, filename: string) => {
  const bytes = await toUint8Array(data);
  return new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], filename, { type: mediaType });
};

const appendQuery = (url: string, query: Record<string, string | number | undefined>) => {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
};

const encodeQwenResourceId = (value: string, resource: string) => {
  if (!value || value === "." || value === ".." || /[\\/?#\s]/.test(value)) {
    throw new ConfigurationError(`Qwen ${resource} ID must be a non-empty opaque identifier without path separators.`);
  }

  return encodeURIComponent(value);
};

const isQwenOmniLanguageModel = (modelId: string) =>
  /^qwen3(?:\.5)?-omni-(?:plus|flash)(?:$|-)/i.test(modelId);

const isOfficialQwenSpeechAudioURL = (url: URL) =>
  !url.username &&
  !url.password &&
  /(?:^|\.)oss(?:-[a-z0-9-]+)?\.aliyuncs\.com$/i.test(url.hostname);

const parseQwenSpeechAudioURL = async (
  value: string,
  validator: QwenSpeechAudioURLValidator | undefined
) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderHTTPError("Qwen speech response contained an invalid audio download URL.", 502);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderHTTPError("Qwen speech audio downloads require an HTTP(S) URL.", 502);
  }

  const allowed = validator ? await validator(url) : isOfficialQwenSpeechAudioURL(url);
  if (!allowed) {
    throw new ProviderHTTPError("Qwen speech response contained an audio download URL rejected by the configured safety policy.", 502);
  }

  return url;
};

const downloadQwenSpeechAudio = async (
  initialURL: string,
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal,
  validator: QwenSpeechAudioURLValidator | undefined,
  maxRedirects: number
) => {
  let url = await parseQwenSpeechAudioURL(initialURL, validator);

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetcher(url, { method: "GET", redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    if (redirects >= maxRedirects) {
      throw new ProviderHTTPError(`Qwen speech audio download exceeded ${maxRedirects} redirects.`, 502);
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new ProviderHTTPError("Qwen speech audio redirect did not include a Location header.", 502);
    }
    url = await parseQwenSpeechAudioURL(new URL(location, url).toString(), validator);
  }
};

const providerHeaders = (apiKey: string, providerOptions?: Record<string, unknown>) => {
  const headers: Record<string, string> = jsonHeaders(apiKey);
  const sessionCache = providerOptions?.["x-dashscope-session-cache"];
  if (sessionCache === "enable" || sessionCache === "disable") {
    headers["x-dashscope-session-cache"] = sessionCache;
  }
  return headers;
};

const stripHeaderOptions = (providerOptions: Record<string, unknown> | undefined) => {
  const next = { ...(providerOptions ?? {}) };
  delete next["x-dashscope-session-cache"];
  return next;
};

const stripResponsesRequestOptions = (providerOptions: Record<string, unknown> | undefined) => {
  const next = stripHeaderOptions(providerOptions);
  for (const key of [
    "model",
    "input",
    "stream",
    "tools",
    "tool_choice",
    "temperature",
    "reasoning",
    "previous_response_id",
    "max_output_tokens",
    "response_format"
  ]) {
    delete next[key];
  }
  return next;
};

const modelFamily = (modelId: string) => modelId.toLowerCase();
const supportsQwenReasoning = (modelId: string) =>
  !isQwenOmniLanguageModel(modelId) &&
  supportsQwenTools(modelId) &&
  /^(qwen-(plus|turbo|max|flash)|qwq|qwen3|qwen3\.)/i.test(modelId);
const supportsQwenVision = (modelId: string) => {
  const model = modelFamily(modelId);
  return (
    model.includes("vl") ||
    model.includes("omni") ||
    model.includes("ocr") ||
    model.includes("vision") ||
    /^qwen3\.7-plus(?:$|-)/.test(model) ||
    /^qwen3\.6-flash(?:$|-)/.test(model)
  );
};
const supportsQwenTools = (modelId: string) =>
  !/(embedding|rerank|asr|tts|image|realtime|ocr|translation|character|long-context)/.test(modelFamily(modelId));
const supportsQwenFiles = (modelId: string) => /^qwen3\.5-ocr(?:$|-)/.test(modelFamily(modelId));
const supportsQwenAudioInput = (modelId: string) => /(omni|audio|asr)/.test(modelFamily(modelId));
const qwenLanguageCapabilities = (modelId: string): ModelCapabilities => {
  const tools = supportsQwenTools(modelId);
  const omni = isQwenOmniLanguageModel(modelId);
  const reasoning = supportsQwenReasoning(modelId);

  return {
    ...capabilities,
    vision: supportsQwenVision(modelId),
    tools,
    structuredOutput: tools && !omni,
    jsonMode: tools && !omni,
    toolChoice: tools,
    parallelToolCalls: false,
    webSearch: tools && !omni,
    files: supportsQwenFiles(modelId),
    audioInput: supportsQwenAudioInput(modelId),
    reasoning,
    reasoningEfforts: reasoning ? ["none", "minimal", "low", "medium", "high"] : undefined,
    agentCapabilities: {
      ...capabilities.agentCapabilities!,
      supportTier: tools && !omni ? "tier-b" : "tier-c",
      toolChoiceNone: tools,
      hostedWebSearch: tools && !omni,
      hostedFileSearch: tools && !omni,
      remoteMcp: tools && !omni,
      codeExecution: tools && !omni,
      webExtraction: tools && !omni
    }
  };
};

const transcriptionCapabilities: ModelCapabilities = {
  ...embeddingCapabilities,
  audioInput: true
};

const speechCapabilities: ModelCapabilities = {
  ...embeddingCapabilities,
  audioOutput: true
};

const imageGenerationCapabilities: ModelCapabilities = {
  ...embeddingCapabilities,
  imageGeneration: true
};

const videoGenerationCapabilities: ModelCapabilities = {
  ...embeddingCapabilities,
  videoGeneration: true
};

const realtimeCapabilities: ModelCapabilities = {
  ...capabilities,
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

const reasoningContentFromMessage = (message: ModelMessage) =>
  message.parts
    .filter((part) => {
      if (part.type !== "provider-data" || part.provider !== "qwen") {
        return false;
      }

      const data = part.data as Record<string, unknown>;
      return data.type === "reasoning_content" && typeof data.reasoningContent === "string";
    })
    .map((part) => (part.type === "provider-data" ? String((part.data as Record<string, unknown>).reasoningContent) : ""))
    .join("");

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

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
    throw new ProviderHTTPError(`Qwen request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  return options.maxBytes
    ? readJsonWithLimit<any>(response, {
        maxBytes: options.maxBytes,
        provider: "qwen",
        endpoint: options.endpoint,
        abort: options.abort
      })
    : response.json();
};

type QwenMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string } };

const mapContentParts = (message: ModelMessage) => {
  const hasMedia = message.parts.some((part) => part.type === "image" || part.type === "audio");

  if (!hasMedia) {
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  return message.parts.flatMap<QwenMessageContentPart>((part) => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "image") {
      return [{ type: "image_url", image_url: { url: part.image } }];
    }
    if (part.type === "audio") {
      return [{ type: "input_audio", input_audio: { data: toDataURL(part.data, part.mediaType) } }];
    }
    return [];
  });
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

    const reasoningContent = reasoningContentFromMessage(message);
    if (reasoningContent) {
      payload.reasoning_content = reasoningContent;
    }

    if (toolCalls.length) {
      payload.tool_calls = toolCalls;
    }

    return payload;
  });

const mapChatTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? (() => {
        const toolDefinitions = Object.values(tools);
        const callableTools = toolDefinitions.filter(isCallableToolDefinition);
        if (callableTools.length !== toolDefinitions.length) {
          throw new UnsupportedFeatureError('Provider "qwen" does not support hosted tools.');
        }

        return callableTools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema)
          }
        }));
      })()
    : undefined;

const mapResponsesTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? Object.values(tools).map((tool) => {
        if (isCallableToolDefinition(tool)) {
          return {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema)
          };
        }

        if (tool.provider && tool.provider !== "qwen") {
          throw new UnsupportedFeatureError(
            `Provider "qwen" does not support hosted tools declared for provider "${tool.provider}".`
          );
        }

        return {
          type: tool.type,
          ...(tool.config && typeof tool.config === "object" ? tool.config : {})
        };
      })
    : undefined;

const mapChatToolChoice = (toolChoice: ModelGenerateInput["toolChoice"]) => {
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

const mapResponsesToolChoice = (
  toolChoice: ModelGenerateInput["toolChoice"],
  tools: ModelGenerateInput["tools"]
) => {
  if (!toolChoice) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    if (toolChoice === "required" && Object.keys(tools ?? {}).length !== 1) {
      throw new UnsupportedFeatureError(
        'Qwen Responses supports toolChoice "required" only when exactly one tool is provided.'
      );
    }
    return toolChoice;
  }

  return {
    type: "allowed_tools",
    mode: "required",
    tools: [{ type: "function", name: toolChoice.toolName }]
  };
};

const mapStructuredOutput = (input: ModelGenerateInput) => {
  if (!input.structuredOutput || input.structuredOutput.mode !== "native") {
    return undefined;
  }

  return { type: "json_object" };
};

const withStructuredOutputMessages = (input: ModelGenerateInput) => {
  if (!input.structuredOutput || input.structuredOutput.mode !== "native") {
    return input.messages;
  }

  const schema = JSON.stringify(toJSONSchema(input.structuredOutput.schema));
  return [
    {
      role: "system" as const,
      parts: [
        {
          type: "text" as const,
          text: `Return only valid JSON matching this JSON Schema: ${schema}`
        }
      ]
    },
    ...input.messages
  ];
};

const hasPreservedReasoning = (messages: ModelMessage[]) =>
  messages.some((message) => message.role === "assistant" && reasoningContentFromMessage(message));

const mapChatReasoning = (input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  return {
    enable_thinking: input.reasoning.effort === "none" ? false : true,
    ...(input.reasoning.effort !== "none" && input.reasoning.budgetTokens !== undefined
      ? { thinking_budget: input.reasoning.budgetTokens }
      : {}),
    ...(hasPreservedReasoning(input.messages) ? { preserve_thinking: true } : {})
  };
};

const mapResponsesReasoning = (input: ModelGenerateInput) => {
  const effort = input.reasoning?.effort;
  if (!effort) {
    return undefined;
  }

  return {
    reasoning: {
      effort: effort === "low" ? "minimal" : effort
    }
  };
};

const mapResponsesUsage = (usage: any) =>
  usage
    ? {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.input_tokens_details?.cached_tokens,
        outputTokens: usage.output_tokens,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
        totalTokens: usage.total_tokens
      }
    : undefined;

const mapChatUsage = (usage: any) =>
  usage
    ? {
        inputTokens: usage.prompt_tokens,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens,
        outputTokens: usage.completion_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens,
        totalTokens: usage.total_tokens
      }
    : undefined;

const hasHostedTools = (tools: ModelGenerateInput["tools"]) =>
  Object.values(tools ?? {}).some((tool) => !isCallableToolDefinition(tool));

const hasMessagePart = (messages: ModelMessage[], type: "audio" | "file") =>
  messages.some((message) => message.parts.some((part) => part.type === type));

const resolveApiMode = (
  modelId: string,
  requestedMode: QwenLanguageModelOptions["apiMode"],
  input: ModelGenerateInput
): "responses" | "chat" => {
  const needsChat =
    input.maxTokens !== undefined ||
    input.reasoning?.budgetTokens !== undefined ||
    input.structuredOutput?.mode === "native" ||
    hasMessagePart(input.messages, "audio");
  const needsResponses = hasHostedTools(input.tools) || hasMessagePart(input.messages, "file");

  if (needsChat && needsResponses) {
    throw new UnsupportedFeatureError(
      "Qwen cannot combine Responses-only hosted/file inputs with Chat-only maxTokens, audio, reasoning budgets, or structured output."
    );
  }

  if (isQwenOmniLanguageModel(modelId)) {
    if (requestedMode === "responses" || needsResponses) {
      throw new UnsupportedFeatureError(
        "Qwen Omni uses streaming Chat Completions and does not support Responses hosted tools or file inputs."
      );
    }
    return "chat";
  }

  if (requestedMode === "responses" && needsChat) {
    throw new UnsupportedFeatureError(
      'Qwen Responses does not process maxTokens, audio input, reasoning budgets, or native structured output; use apiMode "chat" or "auto".'
    );
  }
  if (requestedMode === "chat" && needsResponses) {
    throw new UnsupportedFeatureError('Qwen Chat Completions does not support Responses hosted tools or OCR file inputs.');
  }

  if (requestedMode === "responses" || requestedMode === "chat") {
    return requestedMode;
  }
  return needsChat ? "chat" : "responses";
};

const parseAssistantMessage = (message: any): ModelMessage => ({
  role: "assistant",
  parts: [
    ...(typeof message.reasoning_content === "string" && message.reasoning_content
      ? [providerDataPart("qwen", { type: "reasoning_content", reasoningContent: message.reasoning_content })]
      : []),
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

const getProviderResponseId = (messages: ModelMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }

    const providerData = message.parts.find(
      (part) =>
        part.type === "provider-data" &&
        part.provider === "qwen" &&
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

const serializeResponsesToolOutput = (message: ModelMessage) =>
  message.parts
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "tool-result" }> => part.type === "tool-result")
    .map((part) => ({
      type: "function_call_output",
      call_id: part.toolResult.toolCallId,
      output: JSON.stringify(part.toolResult.isError ? part.toolResult.error : part.toolResult.output ?? null)
    }));

const toResponsesInput = (messages: ModelMessage[]) => {
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push(...serializeResponsesToolOutput(message));
      continue;
    }

    const content: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          content.push({ type: "input_text", text: part.text });
          break;
        case "image":
          content.push({ type: "input_image", image_url: part.image });
          break;
        case "file":
          if (!/^https?:\/\//i.test(part.data)) {
            throw new UnsupportedFeatureError(
              "Qwen Responses file input requires a public HTTP(S) file URL; DashScope Files IDs are reserved for batch jobs."
            );
          }
          content.push({
            type: "input_file",
            file_url: part.data,
            ...(part.filename ? { filename: part.filename } : {})
          });
          break;
        case "tool-call":
          if (message.role === "assistant") {
            input.push({
              type: "function_call",
              call_id: part.toolCall.id,
              name: part.toolCall.name,
              arguments: JSON.stringify(part.toolCall.input)
            });
          }
          break;
        case "provider-data":
          if (
            message.role === "assistant" &&
            part.provider === "qwen" &&
            part.data &&
            typeof part.data === "object" &&
            typeof (part.data as Record<string, unknown>).type === "string"
          ) {
            input.push(part.data as Record<string, unknown>);
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

const parseResponsesProviderData = (item: unknown) => {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const typedItem = item as Record<string, unknown>;
  if (typeof typedItem.type !== "string" || ["message", "function_call"].includes(typedItem.type)) {
    return undefined;
  }

  return item as JsonValue;
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

    const providerData = parseResponsesProviderData(item);
    if (providerData) {
      parts.push(providerDataPart("qwen", providerData));
    }
  }

  if (!parts.some((part) => part.type === "text") && typeof json.output_text === "string" && json.output_text) {
    parts.push({ type: "text", text: json.output_text });
  }

  if (typeof json.id === "string") {
    parts.push(providerDataPart("qwen", { responseId: json.id }));
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

    if (
      (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") &&
      typeof json.delta === "string"
    ) {
      yield {
        type: "provider-data",
        provider: "qwen",
        data: {
          type: "reasoning_content",
          reasoningContent: json.delta
        }
      } satisfies StreamEvent;
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

      const providerData = parseResponsesProviderData(item);
      if (providerData && type === "response.output_item.done") {
        yield {
          type: "provider-data",
          provider: "qwen",
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
      if (typeof responseData.id === "string") {
        yield {
          type: "provider-data",
          provider: "qwen",
          data: { responseId: responseData.id }
        } satisfies StreamEvent;
      }
      yield {
        type: "finish",
        finishReason: normalizeResponsesFinishReason(responseData.status, sawToolCalls),
        providerFinishReason: responseData.status,
        usage: mapResponsesUsage(responseData.usage)
      } satisfies StreamEvent;
    }
  }
};

class QwenLanguageModel implements LanguageModel<QwenLanguageModelOptions> {
  readonly provider = "qwen";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {
    this.capabilities = qwenLanguageCapabilities(modelId);
  }

  async generate(input: ModelGenerateInput<QwenLanguageModelOptions>): Promise<GenerateResult> {
    if (isQwenOmniLanguageModel(this.modelId)) {
      throw new UnsupportedFeatureError(
        `Qwen Omni model "${this.modelId}" is streaming-only. Use streamText() instead of generateText().`
      );
    }
    const { signal, cleanup } = withTimeoutSignal(input);
    const providerOptions = { ...(input.providerOptions ?? {}) } as QwenLanguageModelOptions;
    const apiMode = resolveApiMode(this.modelId, providerOptions.apiMode ?? "auto", input);
    delete providerOptions.apiMode;

    try {
      if (apiMode === "responses") {
        const previousResponse = getProviderResponseId(input.messages);
        const responseProviderOptions = stripResponsesRequestOptions(providerOptions);
        const messages =
          previousResponse && previousResponse.index < input.messages.length - 1
            ? input.messages.slice(previousResponse.index + 1)
            : input.messages;
        const response = await withRetry(
          () =>
            this.fetcher(`${this.baseURL}/responses`, {
              method: "POST",
              headers: providerHeaders(this.apiKey, providerOptions),
              signal,
              body: JSON.stringify({
                ...responseProviderOptions,
                model: this.modelId,
                ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
                ...(messages.length ? { input: toResponsesInput(messages) } : {}),
                tools: mapResponsesTools(input.tools),
                tool_choice: mapResponsesToolChoice(input.toolChoice, input.tools),
                temperature: input.temperature,
                ...mapResponsesReasoning(input),
                stream: false
              })
            }),
          input
        );

        const json = await parseJson(response);
        const assistantMessage = parseResponsesAssistantMessage(json);
        const hasToolCalls = assistantMessage.parts.some((part) => part.type === "tool-call");

        return {
          messages: [assistantMessage],
          text: assistantMessage.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
          finishReason: normalizeResponsesFinishReason(json.status, hasToolCalls),
          providerFinishReason: json.status,
          usage: mapResponsesUsage(json.usage),
          rawResponse: json
        };
      }

      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: providerHeaders(this.apiKey, providerOptions),
            signal,
            body: JSON.stringify({
              ...stripHeaderOptions(providerOptions),
              model: this.modelId,
              messages: mapMessages(withStructuredOutputMessages(input)),
              tools: mapChatTools(input.tools),
              tool_choice: mapChatToolChoice(input.toolChoice),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              max_tokens: input.maxTokens,
              stream: false,
              ...mapChatReasoning(input)
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
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        finishReason: normalizeFinishReason(choice?.finish_reason),
        providerFinishReason: choice?.finish_reason,
        usage: mapChatUsage(json.usage),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput<QwenLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const providerOptions = { ...(input.providerOptions ?? {}) } as QwenLanguageModelOptions;
    const apiMode = resolveApiMode(this.modelId, providerOptions.apiMode ?? "auto", input);
    delete providerOptions.apiMode;

    if (apiMode === "responses") {
      const previousResponse = getProviderResponseId(input.messages);
      const responseProviderOptions = stripResponsesRequestOptions(providerOptions);
      const messages =
        previousResponse && previousResponse.index < input.messages.length - 1
          ? input.messages.slice(previousResponse.index + 1)
          : input.messages;
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: providerHeaders(this.apiKey, providerOptions),
            signal,
            body: JSON.stringify({
              ...responseProviderOptions,
              model: this.modelId,
              ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
              ...(messages.length ? { input: toResponsesInput(messages) } : {}),
              tools: mapResponsesTools(input.tools),
              tool_choice: mapResponsesToolChoice(input.toolChoice, input.tools),
              temperature: input.temperature,
              ...mapResponsesReasoning(input),
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

    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: providerHeaders(this.apiKey, providerOptions),
          signal,
          body: JSON.stringify({
            ...stripHeaderOptions(providerOptions),
            model: this.modelId,
            modalities: isQwenOmniLanguageModel(this.modelId) ? providerOptions.modalities ?? ["text"] : undefined,
            messages: mapMessages(withStructuredOutputMessages(input)),
            tools: mapChatTools(input.tools),
            tool_choice: mapChatToolChoice(input.toolChoice),
            response_format: mapStructuredOutput(input),
            temperature: input.temperature,
            max_tokens: input.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            ...mapChatReasoning(input)
          })
        }),
      input
    );

    return (async function* () {
      try {
        const toolBuffers = new Map<number, { id: string; name: string; args: string; emitted: boolean }>();

        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            return;
          }

          const json = JSON.parse(event.data);
          const choice = json.choices?.[0];
          const delta = choice?.delta;

          if (delta?.reasoning_content) {
            yield {
              type: "provider-data",
              provider: "qwen",
              data: {
                type: "reasoning_content",
                reasoningContent: delta.reasoning_content
              }
            } satisfies StreamEvent;
          }

          if (delta?.content) {
            yield { type: "text-delta", textDelta: delta.content } satisfies StreamEvent;
          }

          for (const toolCall of delta?.tool_calls ?? []) {
            const index = Number(toolCall.index ?? 0);
            const existing = toolBuffers.get(index) ?? {
              id: toolCall.id ?? `${index}`,
              name: toolCall.function?.name ?? "",
              args: "",
              emitted: false
            };
            existing.id = toolCall.id ?? existing.id;
            existing.name ||= toolCall.function?.name ?? "";
            existing.args += toolCall.function?.arguments ?? "";
            toolBuffers.set(index, existing);
          }

          if (choice?.finish_reason) {
            if (choice.finish_reason === "tool_calls") {
              for (const toolCall of toolBuffers.values()) {
                if (toolCall.emitted) {
                  continue;
                }
                toolCall.emitted = true;
                yield {
                  type: "tool-call",
                  toolCall: {
                    id: toolCall.id,
                    name: toolCall.name,
                    input: JSON.parse(toolCall.args || "{}")
                  }
                } satisfies StreamEvent;
              }
            }
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

class QwenEmbeddingModel implements EmbeddingModel {
  readonly provider = "qwen";
  readonly capabilities = embeddingCapabilities;

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
        throw new UnsupportedFeatureError('Provider "qwen" does not support multimodal embedding values.');
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

const toMultimodalEmbeddingContent = (value: QwenRerankValue) => {
  if (typeof value === "string") {
    return { text: value };
  }

  if (value.mediaType.startsWith("image/")) {
    return { image: mediaValue(value) };
  }
  if (value.mediaType.startsWith("video/")) {
    if (!value.uri) {
      throw new UnsupportedFeatureError("Qwen multimodal embedding requires a public URL for video input.");
    }
    return { video: value.uri };
  }

  throw new UnsupportedFeatureError(
    `Qwen multimodal embedding supports text, image, and video inputs, not "${value.mediaType}".`
  );
};

class QwenMultimodalEmbeddingModelImpl implements QwenMultimodalEmbeddingModel {
  readonly provider = "qwen";
  readonly capabilities: ModelCapabilities = {
    ...embeddingCapabilities,
    vision: true
  };

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly taskBaseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async embed(
    input: EmbedInput & {
      providerOptions?: Record<string, unknown>;
      abortSignal?: AbortSignal;
      timeoutMs?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
    }
  ): Promise<EmbedResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(
            `${this.taskBaseURL}/services/embeddings/multimodal-embedding/multimodal-embedding`,
            {
              method: "POST",
              headers: jsonHeaders(this.apiKey),
              signal,
              body: JSON.stringify({
                model: this.modelId,
                input: { contents: input.values.map(toMultimodalEmbeddingContent) },
                ...(input.providerOptions && Object.keys(input.providerOptions).length
                  ? { parameters: input.providerOptions }
                  : {})
              })
            }
          ),
        input
      );
      const json = await parseJson(response);
      return {
        embeddings: (json.output?.embeddings ?? []).map((entry: any) => entry.embedding),
        usage: {
          inputTokens: json.usage?.input_tokens,
          totalTokens: json.usage?.total_tokens
        },
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

const normalizeUploadedFile = (json: any): UploadedFile => ({
  name: json.id ?? json.name ?? json.file_id ?? "",
  uri: json.url ?? json.uri,
  mimeType: json.mime_type ?? json.mimeType ?? json.content_type,
  sizeBytes: json.bytes ?? json.size_bytes ?? json.sizeBytes,
  state: json.status ?? json.state,
  displayName: json.filename ?? json.display_name ?? json.displayName,
  rawResponse: json,
  providerMetadata: json
});

const normalizeBatchJob = (json: any): BatchJob => ({
  name: json.id ?? json.name ?? "",
  model: json.model,
  state: json.status ?? json.state,
  done: ["completed", "failed", "cancelled", "expired"].includes(String(json.status ?? json.state ?? "").toLowerCase()),
  createTime: json.created_at ? String(json.created_at) : json.createTime,
  updateTime: json.updated_at ? String(json.updated_at) : json.updateTime,
  rawResponse: json,
  providerMetadata: json
});

const normalizeOperation = (json: any): PredictionOperation => ({
  name: json.output?.task_id ?? json.task_id ?? json.id ?? json.name ?? "",
  done: json.output?.task_status ? ["SUCCEEDED", "FAILED", "CANCELED"].includes(json.output.task_status) : json.done,
  response: json.output ?? json.response,
  error:
    json.error ??
    (json.output?.task_status === "FAILED"
      ? { message: json.output?.message ?? "Qwen task failed.", code: json.output?.code }
      : undefined),
  metadata: json.usage ?? json.metadata,
  rawResponse: json
});

class QwenFilesClient implements FilesClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async upload(input: FileUploadInput): Promise<UploadedFile> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const form = new FormData();
    form.set("file", await createFile(input.data, input.mediaType, input.filename ?? input.displayName ?? input.name ?? "file"));
    form.set("purpose", String(input.providerOptions?.purpose ?? "file-extract"));
    for (const [key, value] of Object.entries(input.providerOptions ?? {})) {
      if (key !== "purpose") {
        form.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }
    try {
      const response = await withRetry(
        () => this.fetcher(`${this.baseURL}/files`, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, signal, body: form }),
        input
      );
      return normalizeUploadedFile(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async get(input: FileGetInput): Promise<UploadedFile> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const fileId = encodeQwenResourceId(input.name, "file");
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/files/${fileId}`, { method: "GET", headers: jsonHeaders(this.apiKey), signal }), input);
      return normalizeUploadedFile(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: FileListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () => this.fetcher(appendQuery(`${this.baseURL}/files`, { limit: input.pageSize, after: input.pageToken }), { method: "GET", headers: jsonHeaders(this.apiKey), signal }),
        input
      );
      const json = await parseJson(response);
      return {
        files: (json.data ?? json.files ?? []).map(normalizeUploadedFile),
        nextPageToken: json.next ?? json.nextPageToken,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async delete(input: FileDeleteInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const fileId = encodeQwenResourceId(input.name, "file");
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/files/${fileId}`, { method: "DELETE", headers: jsonHeaders(this.apiKey), signal }), input);
      const json = await parseJson(response);
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class QwenBatchesClient implements BatchesClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async create(input: BatchCreateInput): Promise<BatchJob> {
    if (!input.fileName) {
      throw new ConfigurationError("Qwen batch creation requires a JSONL fileName uploaded with purpose \"batch\".");
    }
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/batches`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              input_file_id: input.fileName,
              endpoint: input.providerOptions?.endpoint ?? "/v1/chat/completions",
              completion_window: input.providerOptions?.completion_window ?? "24h",
              metadata: input.displayName ? { displayName: input.displayName } : undefined
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
      const batchId = encodeQwenResourceId(input.name, "batch");
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/batches/${batchId}`, { method: "GET", headers: jsonHeaders(this.apiKey), signal }), input);
      return normalizeBatchJob(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: BatchListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () => this.fetcher(appendQuery(`${this.baseURL}/batches`, { limit: input.pageSize, after: input.pageToken }), { method: "GET", headers: jsonHeaders(this.apiKey), signal }),
        input
      );
      const json = await parseJson(response);
      return { batches: (json.data ?? json.batches ?? []).map(normalizeBatchJob), nextPageToken: json.next ?? json.nextPageToken, rawResponse: json };
    } finally {
      cleanup();
    }
  }

  async cancel(input: BatchCancelInput): Promise<BatchJob> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const batchId = encodeQwenResourceId(input.name, "batch");
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/batches/${batchId}/cancel`, { method: "POST", headers: jsonHeaders(this.apiKey), signal }), input);
      return normalizeBatchJob(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async delete(input: BatchDeleteInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const batchId = encodeQwenResourceId(input.name, "batch");
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/batches/${batchId}`, { method: "DELETE", headers: jsonHeaders(this.apiKey), signal }), input);
      const json = await parseJson(response);
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class QwenTranscriptionModel implements TranscriptionModel {
  readonly provider = "qwen";
  readonly capabilities = transcriptionCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly responseLimits = resolveAudioResponseLimits()
  ) {}

  async transcribe(input: { audio: AudioInput; prompt?: string; language?: string; providerOptions?: Record<string, unknown>; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<TranscriptionResult> {
    if (input.prompt) {
      throw new UnsupportedFeatureError(
        "Qwen3-ASR-Flash does not expose the common transcription prompt field; use providerOptions for documented asr_options."
      );
    }
    const { signal, cleanup, abort } = withTimeoutSignal(input);
    const providerOptions = { ...(input.providerOptions ?? {}) };
    const nestedOptions =
      providerOptions.asr_options && typeof providerOptions.asr_options === "object"
        ? (providerOptions.asr_options as Record<string, unknown>)
        : {};
    delete providerOptions.asr_options;
    delete providerOptions.model;
    delete providerOptions.messages;
    delete providerOptions.stream;
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_audio",
                      input_audio: {
                        data: toDataURL(input.audio.data, input.audio.mediaType)
                      }
                    }
                  ]
                }
              ],
              stream: false,
              asr_options: {
                ...providerOptions,
                ...nestedOptions,
                ...(input.language ? { language: input.language } : {})
              }
            })
          }),
        input
      );
      const json = await parseJson(response, {
        maxBytes: this.responseLimits.transcriptionBytes,
        errorBodyBytes: this.responseLimits.errorBodyBytes,
        endpoint: "chat/completions",
        abort
      });
      const content = json.choices?.[0]?.message?.content;
      const text = Array.isArray(content)
        ? content.map((part: any) => part?.text ?? "").join("")
        : typeof content === "string"
          ? content
          : "";
      return { text, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class QwenSpeechModel implements SpeechModel {
  readonly provider = "qwen";
  readonly capabilities = speechCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly taskBaseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly responseLimits = resolveAudioResponseLimits(),
    private readonly speechAudioURLValidator?: QwenSpeechAudioURLValidator,
    private readonly speechAudioMaxRedirects = 3
  ) {}

  async generateSpeech(input: { input: string; voice?: string; providerOptions?: Record<string, unknown>; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<SpeechResult> {
    const { signal, cleanup, abort } = withTimeoutSignal(input);
    const providerOptions = { ...(input.providerOptions ?? {}) };
    const nestedInput =
      providerOptions.input && typeof providerOptions.input === "object"
        ? (providerOptions.input as Record<string, unknown>)
        : {};
    const parameters =
      providerOptions.parameters && typeof providerOptions.parameters === "object"
        ? (providerOptions.parameters as Record<string, unknown>)
        : undefined;
    delete providerOptions.input;
    delete providerOptions.parameters;
    delete providerOptions.model;
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.taskBaseURL}/services/aigc/multimodal-generation/generation`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: {
                ...providerOptions,
                ...nestedInput,
                text: input.input,
                voice: input.voice ?? "Cherry"
              },
              ...(parameters ? { parameters } : {})
            })
          }),
        input
      );
      const json = await parseJson(response, {
        maxBytes: this.responseLimits.speechJsonBytes,
        errorBodyBytes: this.responseLimits.errorBodyBytes,
        endpoint: "multimodal-generation/generation",
        abort
      });
      const audio = json.audio?.data ?? json.output?.audio?.data;
      const audioURL = json.audio?.url ?? json.output?.audio?.url;
      const rawResponse = {
        ...json,
        ...(json.audio && typeof json.audio === "object"
          ? { audio: { ...json.audio, data: undefined, data_omitted: audio ? true : undefined } }
          : {}),
        ...(json.output && typeof json.output === "object"
          ? {
              output: {
                ...json.output,
                ...(json.output.audio && typeof json.output.audio === "object"
                  ? { audio: { ...json.output.audio, data: undefined, data_omitted: audio ? true : undefined } }
                  : {})
              }
            }
          : {})
      };

      if (audio) {
        const decodedAudio = decodeBase64WithLimit(String(audio), {
          maxBytes: this.responseLimits.speechBytes,
          provider: "qwen",
          endpoint: "multimodal-generation/generation",
          abort
        });
        return {
          audio: decodedAudio,
          mediaType: json.audio?.media_type ?? json.output?.audio?.media_type ?? "audio/pcm",
          rawResponse
        };
      }

      if (typeof audioURL !== "string" || !/^https?:\/\//i.test(audioURL)) {
        throw new ProviderHTTPError("Qwen speech response did not contain audio data or a downloadable audio URL.", 502);
      }
      const audioResponse = await withRetry(
        () =>
          downloadQwenSpeechAudio(
            audioURL,
            this.fetcher,
            signal,
            this.speechAudioURLValidator,
            this.speechAudioMaxRedirects
          ),
        input
      );
      if (!audioResponse.ok) {
        const body = await readErrorBodyWithLimit(audioResponse, this.responseLimits.errorBodyBytes);
        throw new ProviderHTTPError(`Qwen audio download failed with status ${audioResponse.status}.`, audioResponse.status, {
          responseBody: body
        });
      }
      return {
        audio: await readBodyWithLimit(audioResponse, {
          maxBytes: this.responseLimits.speechBytes,
          provider: "qwen",
          endpoint: "speech-audio-download",
          abort
        }),
        mediaType: audioResponse.headers.get("content-type") ?? json.output?.audio?.media_type ?? "audio/wav",
        rawResponse
      };
    } finally {
      cleanup();
    }
  }
}

const normalizeGeneratedMedia = (item: any, fallbackMimeType: string): GeneratedMedia => ({
  uri: item.url ?? item.uri ?? item.image ?? item.video_url,
  data: item.b64_json || item.base64 ? Uint8Array.from(Buffer.from(item.b64_json ?? item.base64, "base64")) : undefined,
  mediaType: item.mime_type ?? item.mediaType ?? fallbackMimeType,
  text: item.revised_prompt ?? item.text,
  providerMetadata: item
});

class QwenImageGenerationModel implements ImageGenerationModel {
  readonly provider = "qwen";
  readonly capabilities = imageGenerationCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly taskBaseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generateImage(input: { prompt: string; images?: MediaInput[]; count?: number; aspectRatio?: string; size?: string; negativePrompt?: string; outputMimeType?: string; providerOptions?: Record<string, unknown>; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<ImageGenerationResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const providerOptions = { ...(input.providerOptions ?? {}) };
    delete providerOptions.endpoint;
    const nestedParameters =
      providerOptions.parameters && typeof providerOptions.parameters === "object"
        ? (providerOptions.parameters as Record<string, unknown>)
        : {};
    delete providerOptions.parameters;
    delete providerOptions.model;
    delete providerOptions.input;
    const endpoint = `${this.taskBaseURL}/services/aigc/multimodal-generation/generation`;
    const sizeFromAspectRatio: Record<string, string> = {
      "1:1": "2048*2048",
      "16:9": "1664*928",
      "9:16": "928*1664",
      "4:3": "1472*1104",
      "3:4": "1104*1472"
    };
    try {
      const response = await withRetry(
        () =>
          this.fetcher(endpoint, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: {
                messages: [
                  {
                    role: "user",
                    content: [
                      ...(input.images ?? []).map((image) => ({ image: mediaValue(image) })),
                      { text: input.prompt }
                    ]
                  }
                ]
              },
              parameters: {
                ...providerOptions,
                ...nestedParameters,
                n: input.count,
                size: input.size ?? (input.aspectRatio ? sizeFromAspectRatio[input.aspectRatio] : undefined),
                negative_prompt: input.negativePrompt
              }
            })
          }),
        input
      );
      const json = await parseJson(response);
      const data =
        json.output?.choices?.flatMap((choice: any) => choice.message?.content ?? []) ??
        json.output?.results ??
        json.output?.images ??
        json.data ??
        [];
      return {
        images: data.map((item: any) => normalizeGeneratedMedia(item, input.outputMimeType ?? "image/png")),
        text: json.output?.text,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class QwenVideoGenerationModel implements VideoGenerationModel {
  readonly provider = "qwen";
  readonly capabilities = videoGenerationCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly taskBaseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generateVideo(input: { prompt: string; image?: MediaInput; count?: number; aspectRatio?: string; negativePrompt?: string; durationSeconds?: number; outputStorageUri?: string; pollIntervalMs?: number; providerOptions?: Record<string, unknown>; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<VideoGenerationResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const providerOptions = { ...(input.providerOptions ?? {}) };
    delete providerOptions.endpoint;
    const nestedInput =
      providerOptions.input && typeof providerOptions.input === "object"
        ? (providerOptions.input as Record<string, unknown>)
        : {};
    const nestedParameters =
      providerOptions.parameters && typeof providerOptions.parameters === "object"
        ? (providerOptions.parameters as Record<string, unknown>)
        : {};
    delete providerOptions.input;
    delete providerOptions.parameters;
    delete providerOptions.model;
    const isWan27 = /^wan2\.7(?:$|-)/i.test(this.modelId);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.taskBaseURL}/services/aigc/video-generation/video-synthesis`, {
            method: "POST",
            headers: { ...jsonHeaders(this.apiKey), "X-DashScope-Async": "enable" },
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: {
                ...nestedInput,
                prompt: input.prompt,
                negative_prompt: input.negativePrompt,
                ...(input.image
                  ? isWan27
                    ? { media: [{ type: "first_frame", url: mediaValue(input.image) }] }
                    : { img_url: mediaValue(input.image) }
                  : {})
              },
              parameters: {
                ...providerOptions,
                ...nestedParameters,
                ratio: input.aspectRatio,
                duration: input.durationSeconds,
                n: input.count,
                output_storage_uri: input.outputStorageUri
              }
            })
          }),
        input
      );
      const json = await parseJson(response);
      const items =
        json.output?.results ??
        json.output?.videos ??
        (json.output?.video_url ? [{ url: json.output.video_url }] : []);
      return {
        videos: items.map((item: any) => normalizeGeneratedMedia(item, "video/mp4")),
        operationName: json.output?.task_id ?? json.task_id,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class QwenRerankModelImpl implements QwenRerankModel {
  readonly provider = "qwen" as const;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly taskBaseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async rerank(input: QwenRerankInput): Promise<QwenRerankResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const isCompatibleRerank = /^qwen3-rerank(?:$|-)/i.test(this.modelId);
    if (
      isCompatibleRerank &&
      (typeof input.query !== "string" || input.documents.some((document) => typeof document !== "string"))
    ) {
      throw new UnsupportedFeatureError("qwen3-rerank accepts text queries and text documents only.");
    }

    const toRerankContent = (value: QwenRerankValue) => {
      if (typeof value === "string") {
        return /^qwen3-vl-rerank(?:$|-)/i.test(this.modelId) ? { text: value } : value;
      }
      return toMultimodalEmbeddingContent(value);
    };
    try {
      const response = await withRetry(
        () =>
          this.fetcher(
            isCompatibleRerank
              ? `${this.baseURL}/reranks`
              : `${this.taskBaseURL}/services/rerank/text-rerank/text-rerank`,
            {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
              body: JSON.stringify(
                isCompatibleRerank
                  ? {
                      ...input.providerOptions,
                      model: this.modelId,
                      query: input.query,
                      documents: input.documents,
                      top_n: input.topN
                    }
                  : {
                      model: this.modelId,
                      input: {
                        query: toRerankContent(input.query),
                        documents: input.documents.map(toRerankContent)
                      },
                      parameters: {
                        return_documents: true,
                        ...input.providerOptions,
                        top_n: input.topN
                      }
                    }
              )
            }
          ),
        input
      );
      const json = await parseJson(response);
      return {
        results: (json.results ?? json.output?.results ?? []).map((entry: any) => ({
          index: entry.index,
          document: input.documents[entry.index] ?? entry.document?.text ?? "",
          relevanceScore: entry.relevance_score ?? entry.score ?? 0,
          providerMetadata: entry
        })),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class QwenTasksClientImpl implements QwenTasksClient {
  constructor(
    private readonly apiKey: string,
    private readonly taskBaseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async get(input: { name: string; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const taskId = encodeQwenResourceId(input.name, "task");
      const response = await withRetry(() => this.fetcher(`${this.taskBaseURL}/tasks/${taskId}`, { method: "GET", headers: jsonHeaders(this.apiKey), signal }), input);
      return normalizeOperation(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async cancel(input: { name: string; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const taskId = encodeQwenResourceId(input.name, "task");
      const response = await withRetry(() => this.fetcher(`${this.taskBaseURL}/tasks/${taskId}/cancel`, { method: "POST", headers: jsonHeaders(this.apiKey), signal }), input);
      return normalizeOperation(await parseJson(response));
    } finally {
      cleanup();
    }
  }
}

const parseRealtimeEvent = (payload: Record<string, unknown>): RealtimeEvent[] => {
  const type = String(payload.type ?? "");
  const metadata = payload as Record<string, JsonValue>;
  const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
  const responseId = typeof payload.response_id === "string" ? payload.response_id : undefined;

  if (type === "response.text.delta" && typeof payload.delta === "string") {
    return [{ type: "realtime-text-delta", textDelta: payload.delta, itemId, responseId, providerMetadata: metadata }];
  }
  if (type === "response.audio.delta" && typeof payload.delta === "string") {
    return [{
      type: "realtime-audio-output",
      audio: Uint8Array.from(Buffer.from(payload.delta, "base64")),
      mediaType: "audio/pcm",
      sampleRateHz: 24_000,
      channels: 1,
      itemId,
      responseId,
      providerMetadata: metadata
    }];
  }
  if (type === "response.audio_transcript.delta" && typeof payload.delta === "string") {
    return [{ type: "realtime-transcript", text: payload.delta, role: "assistant", isFinal: false, itemId, responseId, providerMetadata: metadata }];
  }
  if (type === "response.audio_transcript.done" && typeof payload.transcript === "string") {
    return [{ type: "realtime-transcript", text: payload.transcript, role: "assistant", isFinal: true, itemId, responseId, providerMetadata: metadata }];
  }
  if (type === "conversation.item.input_audio_transcription.delta") {
    const text = `${typeof payload.text === "string" ? payload.text : ""}${typeof payload.stash === "string" ? payload.stash : ""}`;
    return [{ type: "realtime-transcript", text, role: "user", isFinal: false, itemId, providerMetadata: metadata }];
  }
  if (type === "conversation.item.input_audio_transcription.completed" && typeof payload.transcript === "string") {
    return [{ type: "realtime-transcript", text: payload.transcript, role: "user", isFinal: true, itemId, providerMetadata: metadata }];
  }
  if (type === "response.function_call_arguments.done") {
    return [{
      type: "realtime-tool-call",
      toolCall: {
        id: String(payload.call_id ?? payload.item_id ?? "qwen-tool-call"),
        name: String(payload.name ?? ""),
        input: JSON.parse(typeof payload.arguments === "string" ? payload.arguments : "{}")
      }
    }];
  }
  if (type === "response.done") {
    const response = payload.response as Record<string, unknown> | undefined;
    return [{ type: "realtime-response-complete", reason: typeof response?.status === "string" ? response.status : undefined, providerMetadata: metadata }];
  }
  if (type === "session.finished") {
    return [{ type: "realtime-end", reason: "finished", providerMetadata: metadata }];
  }
  if (type === "error" || type.endsWith(".failed")) {
    const error = payload.error as Record<string, unknown> | undefined;
    return [{
      type: "realtime-error",
      message: String(error?.message ?? payload.message ?? "Qwen realtime error"),
      providerMetadata: metadata
    }];
  }
  return [];
};

const mapRealtimeTools = (config: RealtimeSessionConfig) => {
  const tools = toToolSet(config.tools);
  if (!tools) {
    return undefined;
  }
  return Object.values(tools).map((tool) => {
    if (!isCallableToolDefinition(tool)) {
      throw new UnsupportedFeatureError("Qwen realtime supports callable function tools only.");
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toJSONSchema(tool.schema)
      }
    };
  });
};

const mapRealtimeSession = (config: RealtimeSessionConfig) => ({
  ...(config.providerOptions ?? {}),
  instructions: config.instructions,
  voice: config.voice,
  input_audio_format: "pcm",
  output_audio_format: "pcm",
  turn_detection: config.turnDetection,
  input_audio_transcription:
    typeof config.inputAudioTranscription === "object"
      ? config.inputAudioTranscription
      : config.inputAudioTranscription
        ? {}
        : undefined,
  tools: mapRealtimeTools(config)
});

const encodeRealtimeData = (data: string | Uint8Array | ArrayBuffer) => {
  if (typeof data === "string") {
    return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  }
  return Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)).toString("base64");
};

class QwenRealtimeModel implements RealtimeModel {
  readonly provider = "qwen";
  readonly capabilities = realtimeCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly realtimeURL: string,
    private readonly connectionFactory?: RealtimeConnectionFactory
  ) {}

  async connect(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions) {
    const url = appendQuery(this.realtimeURL, { model: this.modelId });
    const connection = await (this.connectionFactory ?? openWebSocketConnection)(url, { authorization: `Bearer ${this.apiKey}` }, options);
    const session = new CallbackRealtimeSession({
      provider: this.provider,
      modelId: this.modelId,
      capabilities: this.capabilities,
      config,
      connection,
      callbacks: {
        parseEvent: parseRealtimeEvent,
        buildInitialPayloads: (value) => [{ type: "session.update", session: mapRealtimeSession(value) }],
        buildAudioPayloads: (frame: AudioFrame) => [{ type: "input_audio_buffer.append", audio: encodeRealtimeData(frame.data) }],
        buildMediaPayloads: (frame: MediaFrame) => {
          if (!/^image\/(jpeg|jpg)$/i.test(frame.mediaType)) {
            throw new UnsupportedFeatureError("Qwen realtime media frames must be JPEG images.");
          }
          return [{ type: "input_image_buffer.append", image: encodeRealtimeData(frame.data) }];
        },
        buildTextPayloads: (text) => [{ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }, { type: "response.create" }],
        buildToolResultPayloads: (result: ToolExecutionResult) => [
          { type: "conversation.item.create", item: { type: "function_call_output", call_id: result.toolCallId, output: JSON.stringify(result.isError ? result.error : result.output ?? null) } },
          { type: "response.create" }
        ],
        buildUpdatePayloads: (value) => [{ type: "session.update", session: mapRealtimeSession(value) }],
        buildClosePayloads: () => []
      }
    });
    await session.initialize();
    return session;
  }
}

export const createQwen = (
  options: QwenProviderOptions = {}
): QwenProvider => {
  const apiKey = options.apiKey ?? process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Qwen API key.");
  }

  const workspaceURLs = options.workspaceId
    ? qwenWorkspaceURLs(options.workspaceId, options.region ?? "singapore")
    : undefined;
  const baseURL = options.baseURL ?? workspaceURLs?.baseURL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const taskBaseURL = options.taskBaseURL ?? workspaceURLs?.taskBaseURL ?? qwenTaskBaseURLFrom(baseURL);
  const realtimeURL =
    options.realtimeURL ??
    workspaceURLs?.realtimeURL ??
    "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";
  const fetcher = options.fetch ?? globalThis.fetch;
  const responseLimits = resolveAudioResponseLimits(options.responseLimits);
  const speechAudioMaxRedirects = options.speechAudioMaxRedirects ?? 3;
  if (!Number.isInteger(speechAudioMaxRedirects) || speechAudioMaxRedirects < 0 || speechAudioMaxRedirects > 10) {
    throw new ConfigurationError("Qwen speechAudioMaxRedirects must be an integer between 0 and 10.");
  }

  return createProviderAdapter({
    name: "qwen",
    languageModel: (modelId) => new QwenLanguageModel(modelId, apiKey, baseURL, fetcher),
    embeddingModel: (modelId) => new QwenEmbeddingModel(modelId, apiKey, baseURL, fetcher),
    transcriptionModel: (modelId) => new QwenTranscriptionModel(modelId, apiKey, baseURL, fetcher, responseLimits),
    speechModel: (modelId) =>
      new QwenSpeechModel(
        modelId,
        apiKey,
        taskBaseURL,
        fetcher,
        responseLimits,
        options.speechAudioURLValidator,
        speechAudioMaxRedirects
      ),
    imageGenerationModel: (modelId) => new QwenImageGenerationModel(modelId, apiKey, taskBaseURL, fetcher),
    videoGenerationModel: (modelId) => new QwenVideoGenerationModel(modelId, apiKey, taskBaseURL, fetcher),
    realtimeModel: (modelId) => new QwenRealtimeModel(modelId, apiKey, realtimeURL, options.realtimeConnectionFactory),
    files: new QwenFilesClient(apiKey, baseURL, fetcher),
    batches: new QwenBatchesClient(apiKey, baseURL, fetcher),
    rerankModel: (modelId: string) => new QwenRerankModelImpl(modelId, apiKey, baseURL, taskBaseURL, fetcher),
    multimodalEmbeddingModel: (modelId: string) =>
      new QwenMultimodalEmbeddingModelImpl(modelId, apiKey, taskBaseURL, fetcher),
    tasks: new QwenTasksClientImpl(apiKey, taskBaseURL, fetcher),
    rawFetch: fetcher
  }) as QwenProvider;
};

export const qwenWebSearchTool = (config: Record<string, unknown> = {}) =>
  hostedTool({
    name: "web_search",
    provider: "qwen",
    type: "web_search",
    toolClass: "web-search",
    config: config as unknown as JsonValue
  });

export const qwenWebExtractorTool = (config: Record<string, unknown> = {}) =>
  hostedTool({
    name: "web_extractor",
    provider: "qwen",
    type: "web_extractor",
    toolClass: "web-extraction",
    config: config as unknown as JsonValue
  });

export const qwenCodeInterpreterTool = (config: Record<string, unknown> = {}) =>
  hostedTool({
    name: "code_interpreter",
    provider: "qwen",
    type: "code_interpreter",
    toolClass: "code-execution",
    config: config as unknown as JsonValue
  });

export const qwenFileSearchTool = (config: Record<string, unknown> = {}) =>
  hostedTool({
    name: "file_search",
    provider: "qwen",
    type: "file_search",
    toolClass: "file-search",
    config: config as unknown as JsonValue
  });

export const qwenMcpTool = (config: Record<string, unknown>) =>
  hostedTool({
    name: typeof config.server_label === "string" ? config.server_label : "mcp",
    provider: "qwen",
    type: "mcp",
    toolClass: "remote-mcp",
    config: config as unknown as JsonValue
  });

export const qwenWebSearchImageTool = (config: Record<string, unknown> = {}) =>
  hostedTool({
    name: "web_search_image",
    provider: "qwen",
    type: "web_search_image",
    toolClass: "custom",
    config: config as unknown as JsonValue
  });

export const qwenImageSearchTool = (config: Record<string, unknown> = {}) =>
  hostedTool({
    name: "image_search",
    provider: "qwen",
    type: "image_search",
    toolClass: "custom",
    config: config as unknown as JsonValue
  });
