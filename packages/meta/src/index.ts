import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createProviderAdapter,
  hostedTool,
  isCallableToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type FileDeleteInput,
  type FileGetInput,
  type FileListInput,
  type FilesClient,
  type FileUploadInput,
  type GenerateResult,
  type GroundedGenerateResult,
  type GroundedLanguageModel,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent,
  type UploadedFile
} from "@zhivex-ai/core";

export interface MetaProviderOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

export interface MetaLanguageModelOptions {
  apiMode?: "chat" | "responses";
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
  include?: string[];
  store?: boolean;
  parallel_tool_calls?: boolean;
  [key: string]: unknown;
}

export interface MetaFileOptions {
  purpose?: "user_data" | "batch" | string;
  [key: string]: unknown;
}

export interface MetaWebSearchToolConfig {
  search_context_size?: "low" | "medium" | "high";
  user_location?: {
    type: "approximate";
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
  include_results?: boolean;
  [key: string]: JsonValue | undefined;
}

export interface MetaToolSearchToolConfig {
  [key: string]: JsonValue | undefined;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: true,
  vision: true,
  files: true,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: true,
  webSearch: true,
  contextCaching: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolSearch: true,
    toolsets: false
  }
};

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

const stripProviderOptions = (options: Record<string, unknown> | undefined) => {
  if (!options) {
    return {};
  }
  const { apiMode: _apiMode, ...rest } = options;
  return rest;
};

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Meta request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const blobFromData = (data: FileUploadInput["data"], mediaType: string) => {
  if (data instanceof Blob) {
    return data;
  }
  if (typeof data === "string") {
    return new Blob([Buffer.from(data, "base64")], { type: mediaType });
  }
  return new Blob([data instanceof Uint8Array ? data.buffer as ArrayBuffer : data], { type: mediaType });
};

const isUrlLike = (value: string) => /^https?:\/\//i.test(value) || /^data:/i.test(value);
const isFileId = (value: string) => /^file-[A-Za-z0-9_-]+/.test(value);
const isImage = (mediaType: string | undefined) => mediaType?.toLowerCase().startsWith("image/");
const isVideo = (mediaType: string | undefined) => mediaType?.toLowerCase().startsWith("video/");

const mapChatContentParts = (message: ModelMessage) => {
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

const mapChatMessages = (messages: ModelMessage[]) =>
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
      content: mapChatContentParts(message)
    };

    if (toolCalls.length) {
      payload.tool_calls = toolCalls;
    }

    return payload;
  });

const mapChatTools = (input: ModelGenerateInput["tools"]) =>
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

        throw new UnsupportedFeatureError('Provider "meta" supports hosted tools through the Responses API only.');
      })
    : undefined;

const mapResponsesTools = (input: ModelGenerateInput["tools"]) =>
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

        if (tool.provider && tool.provider !== "meta") {
          throw new UnsupportedFeatureError(
            `Provider "meta" does not support hosted tools declared for provider "${tool.provider}".`
          );
        }

        return {
          type: tool.type,
          ...(tool.config && typeof tool.config === "object" ? tool.config : {})
        };
      })
    : undefined;

const hasHostedTools = (tools: ModelGenerateInput["tools"]) =>
  Object.values(tools ?? {}).some((tool) => !isCallableToolDefinition(tool));

const hasFileParts = (messages: ModelMessage[]) =>
  messages.some((message) => message.parts.some((part) => part.type === "file"));

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

const assertReasoningSupported = (input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return;
  }
  if (input.reasoning.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "meta" does not support "reasoning.budgetTokens".');
  }
  if (input.reasoning.effort === "none") {
    throw new UnsupportedFeatureError('Provider "meta" does not support "reasoning.effort=none".');
  }
};

const mapChatReasoning = (input: ModelGenerateInput) => {
  assertReasoningSupported(input);
  return input.reasoning?.effort
    ? {
        reasoning_effort: input.reasoning.effort
      }
    : {};
};

const mapResponsesReasoning = (input: ModelGenerateInput) => {
  assertReasoningSupported(input);
  return input.reasoning?.effort
    ? {
        reasoning: {
          effort: input.reasoning.effort
        }
      }
    : {};
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
        part.provider === "meta" &&
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
    .map((part) => ({
      type: "function_call_output",
      call_id: part.toolResult.toolCallId,
      output: JSON.stringify(part.toolResult.isError ? part.toolResult.error : part.toolResult.output ?? null)
    }));

const mapFilePartToResponsesContent = (part: Extract<ModelMessage["parts"][number], { type: "file" }>) => {
  if (isFileId(part.data)) {
    return {
      type: "input_file",
      file_id: part.data
    };
  }

  if (isImage(part.mediaType) && isUrlLike(part.data)) {
    return {
      type: "input_image",
      image_url: part.data
    };
  }

  if (isVideo(part.mediaType) && isUrlLike(part.data)) {
    return {
      type: "input_video",
      video_url: part.data
    };
  }

  if (/^https?:\/\//i.test(part.data)) {
    return {
      type: "input_file",
      file_url: part.data
    };
  }

  return {
    type: "input_file",
    filename: part.filename,
    file_data: part.data
  };
};

const toResponsesInput = (messages: ModelMessage[]) => {
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push(...serializeToolOutput(message));
      continue;
    }

    const content: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          content.push({
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: part.text
          });
          break;
        case "image":
          content.push({ type: "input_image", image_url: part.image });
          break;
        case "file":
          content.push(mapFilePartToResponsesContent(part));
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
        type: "message",
        role: message.role,
        content
      });
    }
  }

  return input;
};

const parseAssistantMessage = (message: any): ModelMessage => ({
  role: "assistant",
  parts: [
    ...(typeof message.content === "string" && message.content ? [{ type: "text", text: message.content } as const] : []),
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
      parts.push(providerDataPart("meta", providerData));
    }
  }

  if (!parts.some((part) => part.type === "text") && typeof json.output_text === "string" && json.output_text) {
    parts.push({ type: "text", text: json.output_text });
  }

  if (typeof json.id === "string") {
    parts.push({
      type: "provider-data",
      provider: "meta",
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

const extractMessageText = (message: ModelMessage) =>
  message.parts
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");

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

const streamResponses = async function* (response: Response): AsyncGenerator<StreamEvent, void, undefined> {
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

      const providerData = parseResponsesProviderData(item);
      if (providerData && type === "response.output_item.done") {
        yield {
          type: "provider-data",
          provider: "meta",
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

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        child.forEach(visit);
      } else if (child && typeof child === "object") {
        visit(child);
      }
    }
  };

  visit(value);
  return sources.filter((source, index, list) => list.findIndex((candidate) => candidate.url === source.url) === index);
};

class MetaLanguageModel implements LanguageModel<MetaLanguageModelOptions> {
  readonly provider = "meta";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private usesResponsesAPI(input: ModelGenerateInput<MetaLanguageModelOptions>) {
    return input.providerOptions?.apiMode === "responses" || hasHostedTools(input.tools) || hasFileParts(input.messages);
  }

  private async generateViaResponses(
    input: ModelGenerateInput<MetaLanguageModelOptions>,
    signal: AbortSignal | undefined
  ): Promise<GenerateResult> {
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
            ...stripProviderOptions(input.providerOptions),
            model: this.modelId,
            ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
            ...(messages.length ? { input: toResponsesInput(messages) } : {}),
            tools: mapResponsesTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            text: mapResponsesStructuredOutput(input),
            temperature: input.temperature,
            max_output_tokens: input.maxTokens,
            ...mapResponsesReasoning(input)
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

  async generate(input: ModelGenerateInput<MetaLanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

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
              ...stripProviderOptions(input.providerOptions),
              model: this.modelId,
              messages: mapChatMessages(input.messages),
              tools: mapChatTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              max_tokens: input.maxTokens,
              ...mapChatReasoning(input),
              stream: false
            })
          }),
        input
      );

      const json = await parseJson(response);
      const choice = json.choices?.[0];
      const assistantMessage = parseAssistantMessage(choice?.message ?? {});

      return {
        messages: [assistantMessage],
        text: extractMessageText(assistantMessage),
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

  async stream(input: ModelGenerateInput<MetaLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);

    if (this.usesResponsesAPI(input)) {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...stripProviderOptions(input.providerOptions),
              model: this.modelId,
              input: toResponsesInput(input.messages),
              tools: mapResponsesTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              text: mapResponsesStructuredOutput(input),
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
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
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify({
            ...stripProviderOptions(input.providerOptions),
            model: this.modelId,
            messages: mapChatMessages(input.messages),
            tools: mapChatTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            response_format: mapStructuredOutput(input),
            temperature: input.temperature,
            max_tokens: input.maxTokens,
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
          }

          if (choice?.finish_reason === "tool_calls") {
            for (const [id, toolCall] of toolBuffers) {
              yield {
                type: "tool-call",
                toolCall: {
                  id,
                  name: toolCall.name,
                  input: JSON.parse(toolCall.args || "{}")
                }
              } satisfies StreamEvent;
            }
          }

          if (choice?.finish_reason || json.usage) {
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(choice?.finish_reason),
              providerFinishReason: choice?.finish_reason,
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

class MetaGroundedLanguageModel implements GroundedLanguageModel<MetaLanguageModelOptions> {
  readonly provider = "meta";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generate(input: Parameters<GroundedLanguageModel<MetaLanguageModelOptions>["generate"]>[0]): Promise<GroundedGenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const messages = [
      ...(input.system ? [{ role: "system" as const, parts: [{ type: "text" as const, text: input.system }] }] : []),
      ...(input.messages ?? (input.prompt ? [{ role: "user" as const, parts: [{ type: "text" as const, text: input.prompt }] }] : []))
    ];

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...stripProviderOptions(input.providerOptions),
              model: this.modelId,
              input: toResponsesInput(messages),
              tools: [{ type: "web_search" }],
              include: ["web_search_call.results"],
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              ...mapResponsesReasoning({
                messages,
                reasoning: input.reasoning
              })
            })
          }),
        input
      );
      const json = await parseJson(response);
      return {
        text: typeof json.output_text === "string" ? json.output_text : extractMessageText(parseResponsesAssistantMessage(json)),
        sources: extractSources(json),
        finishReason: normalizeResponsesFinishReason(json.status, false),
        providerFinishReason: json.status,
        usage: {
          inputTokens: json.usage?.input_tokens,
          outputTokens: json.usage?.output_tokens,
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
  name: json.id ?? json.name,
  uri: json.id ?? json.uri,
  mimeType: json.mime_type ?? json.mimeType,
  sizeBytes: json.bytes ?? json.size_bytes ?? json.sizeBytes,
  state: json.status ?? json.state,
  displayName: json.filename ?? json.display_name ?? json.displayName,
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

class MetaFilesClient implements FilesClient<MetaFileOptions> {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async upload(input: FileUploadInput<MetaFileOptions>): Promise<UploadedFile> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const form = new FormData();
    const filename = input.filename ?? input.displayName ?? input.name ?? "file";
    form.set("file", blobFromData(input.data, input.mediaType), filename);
    form.set("purpose", input.providerOptions?.purpose ?? "user_data");
    for (const [key, value] of Object.entries(input.providerOptions ?? {})) {
      if (key !== "purpose" && value !== undefined) {
        form.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    }

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/files`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}` },
            signal,
            body: form
          }),
        input
      );
      return normalizeUploadedFile(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async get(input: FileGetInput<MetaFileOptions>): Promise<UploadedFile> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/files/${input.name}`, {
            method: "GET",
            headers: jsonHeaders(this.apiKey),
            signal
          }),
        input
      );
      return normalizeUploadedFile(await parseJson(response));
    } finally {
      cleanup();
    }
  }

  async list(input: FileListInput<MetaFileOptions> = {}) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(appendQuery(`${this.baseURL}/files`, { limit: input.pageSize, after: input.pageToken }), {
            method: "GET",
            headers: jsonHeaders(this.apiKey),
            signal
          }),
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

  async delete(input: FileDeleteInput<MetaFileOptions>) {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/files/${input.name}`, {
            method: "DELETE",
            headers: jsonHeaders(this.apiKey),
            signal
          }),
        input
      );
      return {
        name: input.name,
        rawResponse: await parseJson(response)
      };
    } finally {
      cleanup();
    }
  }
}

export const createMeta = (
  options: MetaProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.MODEL_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Meta Model API key.");
  }

  const baseURL = (options.baseURL ?? "https://api.meta.ai/v1").replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "meta",
    languageModel: (modelId) => new MetaLanguageModel(modelId, apiKey, baseURL, fetcher),
    groundedLanguageModel: (modelId) => new MetaGroundedLanguageModel(modelId, apiKey, baseURL, fetcher),
    files: new MetaFilesClient(apiKey, baseURL, fetcher),
    rawFetch: fetcher
  });
};

export const metaWebSearchTool = (config: MetaWebSearchToolConfig = {}) => {
  const { include_results: _includeResults, ...toolConfig } = config;
  const sanitizedConfig = Object.fromEntries(
    Object.entries(toolConfig).filter(([, value]) => value !== undefined)
  ) as Record<string, JsonValue>;
  return hostedTool({
    name: "web_search",
    provider: "meta",
    type: "web_search",
    config: sanitizedConfig
  });
};

export const metaToolSearchTool = (config: MetaToolSearchToolConfig = {}) => {
  const sanitizedConfig = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined)
  ) as Record<string, JsonValue>;
  return hostedTool({
    name: "tool_search",
    provider: "meta",
    type: "tool_search",
    config: sanitizedConfig
  });
};

export const metaFilePart = (fileId: string, mediaType = "application/octet-stream", filename?: string) => ({
  type: "file" as const,
  data: fileId,
  mediaType,
  filename
});
