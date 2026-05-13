import { toJSONSchema } from "zod";

import {
  CallbackRealtimeSession,
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createProviderAdapter,
  hostedTool,
  openWebSocketConnection,
  isCallableToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type AudioFrame,
  type AudioInput,
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
  baseURL?: string;
  taskBaseURL?: string;
  realtimeURL?: string;
  realtimeConnectionFactory?: RealtimeConnectionFactory;
  fetch?: typeof globalThis.fetch;
}

export interface QwenLanguageModelOptions {
  apiMode?: "responses" | "chat";
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

export interface QwenRerankInput {
  query: string;
  documents: string[];
  topN?: number;
  providerOptions?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
}

export interface QwenRerankResult {
  results: Array<{ index: number; document: string; relevanceScore: number; providerMetadata?: Record<string, unknown> }>;
  rawResponse?: unknown;
}

export interface QwenRerankModel {
  readonly provider: "qwen";
  readonly modelId: string;
  rerank(input: QwenRerankInput): Promise<QwenRerankResult>;
}

export interface QwenTasksClient {
  get(input: { name: string; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<PredictionOperation>;
  cancel(input: { name: string; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<PredictionOperation>;
}

export type QwenProvider = CallableProviderAdapter &
  ProviderAdapter & {
    rawFetch: typeof globalThis.fetch;
    rerankModel(modelId: string): QwenRerankModel;
    multimodalEmbeddingModel(modelId: string): EmbeddingModel;
    tasks: QwenTasksClient;
  };

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

const modelFamily = (modelId: string) => modelId.toLowerCase();
const supportsQwenReasoning = (modelId: string) => /^(qwen-(plus|turbo|max|flash)|qwq|qwen3|qwen3\.)/i.test(modelId);
const supportsQwenVision = (modelId: string) => {
  const model = modelFamily(modelId);
  return model.includes("vl") || model.includes("omni") || model.includes("vision") || /^qwen3\./.test(model);
};
const supportsQwenTools = (modelId: string) => !modelFamily(modelId).includes("embedding");
const qwenLanguageCapabilities = (modelId: string): ModelCapabilities => ({
  ...capabilities,
  vision: supportsQwenVision(modelId),
  tools: supportsQwenTools(modelId),
  structuredOutput: supportsQwenTools(modelId),
  jsonMode: supportsQwenTools(modelId),
  toolChoice: supportsQwenTools(modelId),
  parallelToolCalls: supportsQwenTools(modelId),
  reasoning: supportsQwenReasoning(modelId)
});

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

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Qwen request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  return response.json();
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
        url: part.image
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

const hasPreservedReasoning = (messages: ModelMessage[]) =>
  messages.some((message) => message.role === "assistant" && reasoningContentFromMessage(message));

const mapReasoning = (input: ModelGenerateInput) => {
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
    const { signal, cleanup } = withTimeoutSignal(input);
    const providerOptions = { ...(input.providerOptions ?? {}) } as QwenLanguageModelOptions;
    const apiMode = providerOptions.apiMode ?? "responses";
    delete providerOptions.apiMode;

    try {
      if (apiMode === "responses") {
        const previousResponse = getProviderResponseId(input.messages);
        const responseProviderOptions = stripHeaderOptions(providerOptions);
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
                model: this.modelId,
                ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
                ...(messages.length ? { input: toResponsesInput(messages) } : {}),
                ...(input.structuredOutput?.mode === "native" ? { response_format: mapStructuredOutput(input) } : {}),
                tools: mapResponsesTools(input.tools),
                tool_choice: mapToolChoice(input.toolChoice),
                temperature: input.temperature,
                max_output_tokens: input.maxTokens,
                ...mapReasoning(input),
                ...responseProviderOptions,
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
          usage: {
            inputTokens: json.usage?.input_tokens,
            outputTokens: json.usage?.output_tokens,
            totalTokens: json.usage?.total_tokens
          },
          rawResponse: json
        };
      }

      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              messages: mapMessages(input.messages),
              tools: mapChatTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              max_tokens: input.maxTokens,
              stream: false,
              ...mapReasoning(input),
              ...providerOptions
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

  async stream(input: ModelGenerateInput<QwenLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const providerOptions = { ...(input.providerOptions ?? {}) } as QwenLanguageModelOptions;
    const apiMode = providerOptions.apiMode ?? "responses";
    delete providerOptions.apiMode;

    if (apiMode === "responses") {
      const responseProviderOptions = stripHeaderOptions(providerOptions);
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: providerHeaders(this.apiKey, providerOptions),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: toResponsesInput(input.messages),
              ...(input.structuredOutput?.mode === "native" ? { response_format: mapStructuredOutput(input) } : {}),
              tools: mapResponsesTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              ...mapReasoning(input),
              ...responseProviderOptions,
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
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify({
            model: this.modelId,
            messages: mapMessages(input.messages),
            tools: mapChatTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            response_format: mapStructuredOutput(input),
            temperature: input.temperature,
            max_tokens: input.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            ...mapReasoning(input),
            ...providerOptions
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

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/embeddings`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: input.values
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

const normalizeFileSearchStore = (json: any): FileSearchStore => ({
  name: json.id ?? json.name ?? "",
  displayName: json.name ?? json.display_name ?? json.displayName,
  createTime: json.created_at ? String(json.created_at) : json.createTime,
  updateTime: json.updated_at ? String(json.updated_at) : json.updateTime,
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
  name: json.task_id ?? json.id ?? json.name ?? "",
  done: json.output?.task_status ? ["SUCCEEDED", "FAILED", "CANCELED"].includes(json.output.task_status) : json.done,
  response: json.output ?? json.response,
  error: json.error,
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
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/files/${input.name}`, { method: "GET", headers: jsonHeaders(this.apiKey), signal }), input);
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
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/files/${input.name}`, { method: "DELETE", headers: jsonHeaders(this.apiKey), signal }), input);
      const json = await parseJson(response);
      return { name: input.name, rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

class QwenFileSearchStoresClient implements FileSearchStoresClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async create(input: FileSearchStoreCreateInput = {}): Promise<FileSearchStore> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/file_search_stores`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({ name: input.displayName, ...input.providerOptions })
          }),
        input
      );
      return normalizeFileSearchStore(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async upload(input: FileSearchStoreUploadInput): Promise<PredictionOperation> {
    const files = new QwenFilesClient(this.apiKey, this.baseURL, this.fetcher);
    const file = await files.upload(input);
    return this.importFile({ ...input, fileName: file.name });
  }

  async importFile(input: FileSearchStoreImportInput): Promise<PredictionOperation> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/file_search_stores/${input.storeName}/files`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({ file_id: input.fileName, ...input.providerOptions })
          }),
        input
      );
      return normalizeOperation(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async get(input: FileSearchStoreGetInput): Promise<FileSearchStore> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/file_search_stores/${input.name}`, { method: "GET", headers: jsonHeaders(this.apiKey), signal }), input);
      return normalizeFileSearchStore(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: FileSearchStoreListInput = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () => this.fetcher(appendQuery(`${this.baseURL}/file_search_stores`, { limit: input.pageSize, after: input.pageToken }), { method: "GET", headers: jsonHeaders(this.apiKey), signal }),
        input
      );
      const json = await parseJson(response);
      return {
        stores: (json.data ?? json.file_search_stores ?? json.fileSearchStores ?? []).map(normalizeFileSearchStore),
        nextPageToken: json.next ?? json.nextPageToken,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async delete(input: FileSearchStoreDeleteInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/file_search_stores/${input.name}`, { method: "DELETE", headers: jsonHeaders(this.apiKey), signal }), input);
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
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/batches`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              input_file_id: input.fileName,
              endpoint: input.providerOptions?.endpoint ?? "/v1/chat/completions",
              completion_window: input.providerOptions?.completion_window ?? "24h",
              metadata: input.displayName ? { displayName: input.displayName } : undefined,
              model: input.modelId,
              requests: input.requests,
              ...input.providerOptions
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
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/batches/${input.name}`, { method: "GET", headers: jsonHeaders(this.apiKey), signal }), input);
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
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/batches/${input.name}/cancel`, { method: "POST", headers: jsonHeaders(this.apiKey), signal }), input);
      return normalizeBatchJob(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async delete(input: BatchDeleteInput) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/batches/${input.name}`, { method: "DELETE", headers: jsonHeaders(this.apiKey), signal }), input);
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
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async transcribe(input: { audio: AudioInput; prompt?: string; language?: string; providerOptions?: Record<string, unknown>; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<TranscriptionResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const form = new FormData();
    form.set("model", this.modelId);
    form.set("file", await createFile(input.audio.data, input.audio.mediaType, input.audio.filename ?? "audio"));
    if (input.prompt) form.set("prompt", input.prompt);
    if (input.language) form.set("language", input.language);
    for (const [key, value] of Object.entries(input.providerOptions ?? {})) {
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    try {
      const response = await withRetry(() => this.fetcher(`${this.baseURL}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, signal, body: form }), input);
      const json = await parseJson(response);
      return { text: json.text ?? json.output?.text ?? "", rawResponse: json };
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
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generateSpeech(input: { input: string; voice?: string; providerOptions?: Record<string, unknown>; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<SpeechResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/audio/speech`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({ model: this.modelId, input: input.input, voice: input.voice ?? "Chelsie", ...input.providerOptions })
          }),
        input
      );
      if (response.headers.get("content-type")?.includes("application/json")) {
        const json = await parseJson(response);
        const audio = json.audio?.data ?? json.output?.audio?.data ?? "";
        return { audio: Uint8Array.from(Buffer.from(audio, "base64")), mediaType: json.audio?.media_type ?? json.output?.audio?.media_type ?? "audio/mpeg", rawResponse: json };
      }
      return { audio: new Uint8Array(await response.arrayBuffer()), mediaType: response.headers.get("content-type") ?? "audio/mpeg" };
    } finally {
      cleanup();
    }
  }
}

const normalizeGeneratedMedia = (item: any, fallbackMimeType: string): GeneratedMedia => ({
  uri: item.url ?? item.uri,
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
    private readonly baseURL: string,
    private readonly taskBaseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generateImage(input: { prompt: string; images?: MediaInput[]; count?: number; aspectRatio?: string; size?: string; negativePrompt?: string; outputMimeType?: string; providerOptions?: Record<string, unknown>; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<ImageGenerationResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const endpoint = String(input.providerOptions?.endpoint ?? `${this.baseURL}/images/generations`);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(endpoint, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              prompt: input.prompt,
              n: input.count,
              size: input.size,
              negative_prompt: input.negativePrompt,
              response_format: input.providerOptions?.response_format,
              input_image: input.images?.[0]?.uri,
              ...input.providerOptions
            })
          }),
        input
      );
      const json = await parseJson(response);
      const data = json.data ?? json.output?.results ?? json.output?.images ?? [];
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
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.taskBaseURL}/services/aigc/video-generation/generation`, {
            method: "POST",
            headers: { ...jsonHeaders(this.apiKey), "X-DashScope-Async": "enable" },
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: { prompt: input.prompt, img_url: input.image?.uri, negative_prompt: input.negativePrompt },
              parameters: { size: input.aspectRatio, duration: input.durationSeconds, n: input.count, output_storage_uri: input.outputStorageUri },
              ...input.providerOptions
            })
          }),
        input
      );
      const json = await parseJson(response);
      const items = json.output?.results ?? json.output?.videos ?? [];
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
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async rerank(input: QwenRerankInput): Promise<QwenRerankResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/rerank`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({ model: this.modelId, query: input.query, documents: input.documents, top_n: input.topN, ...input.providerOptions })
          }),
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
      const response = await withRetry(() => this.fetcher(`${this.taskBaseURL}/tasks/${input.name}`, { method: "GET", headers: jsonHeaders(this.apiKey), signal }), input);
      return normalizeOperation(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async cancel(input: { name: string; abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(() => this.fetcher(`${this.taskBaseURL}/tasks/${input.name}/cancel`, { method: "POST", headers: jsonHeaders(this.apiKey), signal }), input);
      return normalizeOperation(await parseJson(response));
    } finally {
      cleanup();
    }
  }
}

const parseRealtimeEvent = (payload: Record<string, unknown>): RealtimeEvent[] => {
  const type = String(payload.type ?? "");
  if (type.includes("text.delta") && typeof payload.delta === "string") {
    return [{ type: "realtime-text-delta", textDelta: payload.delta, providerMetadata: payload as Record<string, JsonValue> }];
  }
  if (type.includes("audio.delta") && typeof payload.delta === "string") {
    return [{ type: "realtime-audio-output", audio: Uint8Array.from(Buffer.from(payload.delta, "base64")), mediaType: "audio/pcm", providerMetadata: payload as Record<string, JsonValue> }];
  }
  if (type.includes("transcript") && typeof payload.text === "string") {
    return [{ type: "realtime-transcript", text: payload.text, role: type.includes("input") ? "user" : "assistant", isFinal: type.includes("done"), providerMetadata: payload as Record<string, JsonValue> }];
  }
  if (type.includes("completed") || type.includes("done")) {
    return [{ type: "realtime-response-complete", providerMetadata: payload as Record<string, JsonValue> }];
  }
  if (type.includes("error")) {
    return [{ type: "realtime-error", message: String(payload.error ?? payload.message ?? "Qwen realtime error"), providerMetadata: payload as Record<string, JsonValue> }];
  }
  return [];
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
        buildInitialPayloads: (value) => [{ type: "session.update", session: { instructions: value.instructions, voice: value.voice, ...value.providerOptions } }],
        buildAudioPayloads: (frame: AudioFrame) => [{ type: "input_audio_buffer.append", audio: typeof frame.data === "string" ? frame.data : Buffer.from(frame.data as Uint8Array).toString("base64") }],
        buildMediaPayloads: (frame: MediaFrame) => [{ type: "input_media.append", media_type: frame.mediaType, data: typeof frame.data === "string" ? frame.data : Buffer.from(frame.data as Uint8Array).toString("base64") }],
        buildTextPayloads: (text) => [{ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }, { type: "response.create" }],
        buildToolResultPayloads: (result: ToolExecutionResult) => [{ type: "conversation.item.create", item: { type: "function_call_output", call_id: result.toolCallId, output: JSON.stringify(result.isError ? result.error : result.output ?? null) } }],
        buildUpdatePayloads: (value) => [{ type: "session.update", session: { instructions: value.instructions, voice: value.voice, ...value.providerOptions } }],
        buildClosePayloads: () => [{ type: "session.close" }]
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

  const baseURL = options.baseURL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const taskBaseURL = options.taskBaseURL ?? qwenTaskBaseURLFrom(baseURL);
  const realtimeURL = options.realtimeURL ?? "wss://dashscope-intl.aliyuncs.com/compatible-mode/v1/realtime";
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "qwen",
    languageModel: (modelId) => new QwenLanguageModel(modelId, apiKey, baseURL, fetcher),
    embeddingModel: (modelId) => new QwenEmbeddingModel(modelId, apiKey, baseURL, fetcher),
    transcriptionModel: (modelId) => new QwenTranscriptionModel(modelId, apiKey, baseURL, fetcher),
    speechModel: (modelId) => new QwenSpeechModel(modelId, apiKey, baseURL, fetcher),
    imageGenerationModel: (modelId) => new QwenImageGenerationModel(modelId, apiKey, baseURL, taskBaseURL, fetcher),
    videoGenerationModel: (modelId) => new QwenVideoGenerationModel(modelId, apiKey, taskBaseURL, fetcher),
    realtimeModel: (modelId) => new QwenRealtimeModel(modelId, apiKey, realtimeURL, options.realtimeConnectionFactory),
    files: new QwenFilesClient(apiKey, baseURL, fetcher),
    fileSearchStores: new QwenFileSearchStoresClient(apiKey, baseURL, fetcher),
    batches: new QwenBatchesClient(apiKey, baseURL, fetcher),
    rerankModel: (modelId: string) => new QwenRerankModelImpl(modelId, apiKey, baseURL, fetcher),
    multimodalEmbeddingModel: (modelId: string) => new QwenEmbeddingModel(modelId, apiKey, baseURL, fetcher),
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
