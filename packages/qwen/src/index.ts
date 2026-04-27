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
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  type GenerateResult,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent
} from "@zhivex-ai/core";

export interface QwenProviderOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

export interface QwenLanguageModelOptions {
  apiMode?: "responses" | "chat";
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
  reasoning: false,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: false,
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

const supportsQwenReasoning = (modelId: string) => /^(qwen-(plus|turbo|max)|qwq|qwen3)/i.test(modelId);

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
    this.capabilities = {
      ...capabilities,
      reasoning: supportsQwenReasoning(modelId)
    };
  }

  async generate(input: ModelGenerateInput<QwenLanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const providerOptions = { ...(input.providerOptions ?? {}) } as QwenLanguageModelOptions;
    const apiMode = providerOptions.apiMode ?? "responses";
    delete providerOptions.apiMode;

    try {
      if (apiMode === "responses") {
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
                model: this.modelId,
                ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
                ...(messages.length ? { input: toResponsesInput(messages) } : {}),
                tools: mapResponsesTools(input.tools),
                tool_choice: mapToolChoice(input.toolChoice),
                temperature: input.temperature,
                max_output_tokens: input.maxTokens,
                ...mapReasoning(input),
                ...providerOptions,
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
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: toResponsesInput(input.messages),
              tools: mapResponsesTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              ...mapReasoning(input),
              ...providerOptions,
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

export const createQwen = (
  options: QwenProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Qwen API key.");
  }

  const baseURL = options.baseURL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "qwen",
    languageModel: (modelId) => new QwenLanguageModel(modelId, apiKey, baseURL, fetcher),
    embeddingModel: (modelId) => new QwenEmbeddingModel(modelId, apiKey, baseURL, fetcher),
    rawFetch: fetcher
  });
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
