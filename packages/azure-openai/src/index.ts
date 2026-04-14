import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  hostedTool,
  providerDataPart,
  UnsupportedFeatureError,
  createProviderAdapter,
  isCallableToolDefinition,
  isHostedToolDefinition,
  normalizeFinishReason,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type AudioInput,
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
  type ProviderAdapter,
  type SpeechModel,
  type SpeechResult,
  type StreamEvent,
  type TranscriptionModel,
  type TranscriptionResult
} from "@zhivex-ai/core";

export interface AzureOpenAIProviderOptions {
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
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
    codeExecution: false,
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

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  "api-key": apiKey
});

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Azure OpenAI request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const toUint8Array = (data: AudioInput["data"]) => {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return Uint8Array.from(Buffer.from(data, "base64"));
};

const createAudioFile = (audio: AudioInput) =>
  new File([toUint8Array(audio.data).buffer as ArrayBuffer], audio.filename ?? "audio", {
    type: audio.mediaType
  });

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

    if (toolCalls.length) {
      payload.tool_calls = toolCalls;
    }

    return payload;
  });

const hasHostedTools = (tools: ModelGenerateInput["tools"]) =>
  Object.values(tools ?? {}).some((tool) => isHostedToolDefinition(tool));

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
    .map((part) => ({
      type: "function_call_output",
      call_id: part.toolResult.toolCallId,
      output: JSON.stringify(part.toolResult.isError ? part.toolResult.error : part.toolResult.output ?? null)
    }));

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
  if (typeof typedItem.type !== "string" || !typedItem.type.startsWith("mcp_")) {
    return undefined;
  }

  return item as JsonValue;
};

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

      const providerData = parseResponsesProviderData(item);
      if (providerData && type === "response.output_item.done") {
        yield {
          type: "provider-data",
          provider: "azure-openai",
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

class AzureOpenAILanguageModel implements LanguageModel<AzureOpenAILanguageModelOptions> {
  readonly provider = "azure-openai";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generate(input: ModelGenerateInput<AzureOpenAILanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              messages: mapMessages(input.messages),
              tools: mapTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
              ...input.providerOptions,
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

  async stream(input: ModelGenerateInput<AzureOpenAILanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify({
            model: this.modelId,
            messages: mapMessages(input.messages),
            tools: mapTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            response_format: mapStructuredOutput(input),
            temperature: input.temperature,
            ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
            ...input.providerOptions,
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
            const existing = toolBuffers.get(id) ?? { name: "", args: "" };
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

class AzureOpenAIEmbeddingModel implements EmbeddingModel {
  readonly provider = "azure-openai";
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

class AzureOpenAITranscriptionModel implements TranscriptionModel {
  readonly provider = "azure-openai";
  readonly capabilities = transcriptionCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly urlResolver: (modelId: string, path: AzurePath) => string,
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
    form.set("file", createAudioFile(input.audio));
    form.set("model", this.modelId);
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
          this.fetcher(this.urlResolver(this.modelId, "audio/transcriptions"), {
            method: "POST",
            headers: { "api-key": this.apiKey },
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

class AzureOpenAISpeechModel implements SpeechModel {
  readonly provider = "azure-openai";
  readonly capabilities = speechCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly urlResolver: (modelId: string, path: AzurePath) => string,
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
          this.fetcher(this.urlResolver(this.modelId, "audio/speech"), {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: input.input,
              voice: input.voice ?? "alloy",
              ...input.providerOptions
            })
          }),
        input
      );

      if (!response.ok) {
        const body = await response.text();
        throw new ProviderHTTPError(`Azure OpenAI request failed with status ${response.status}.`, response.status, {
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

class AzureOpenAIGroundedLanguageModel implements GroundedLanguageModel {
  readonly provider = "azure-openai";
  readonly capabilities = groundedCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
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
      const response = await withRetry(
        () =>
          this.fetcher(this.urlResolver(this.modelId, "responses"), {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: toResponsesInput(input.messages),
              tools: [{ type: "web_search_preview" }],
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              ...input.providerOptions
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

const normalizeEndpoint = (endpoint: string) => endpoint.replace(/\/+$/, "");
type AzurePath = "chat/completions" | "embeddings" | "audio/transcriptions" | "audio/speech" | "responses";

export const createAzureOpenAI = (
  options: AzureOpenAIProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Azure OpenAI API key.");
  }

  const endpoint = options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) {
    throw new ConfigurationError("Missing Azure OpenAI endpoint.");
  }

  const apiVersion = options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION;
  const baseURL = apiVersion
    ? `${normalizeEndpoint(endpoint)}/openai/deployments/{deployment}?api-version=${apiVersion}`
    : `${normalizeEndpoint(endpoint)}/openai/v1`;
  const fetcher = options.fetch ?? globalThis.fetch;

  const resolveURL = (modelId: string, path: AzurePath) =>
    baseURL.includes("{deployment}")
      ? baseURL.replace("{deployment}", modelId).replace(/\?api-version=.*$/, `/${path}?api-version=${apiVersion}`)
      : `${baseURL}/${path}`;

  return createProviderAdapter({
    name: "azure-openai",
    languageModel: (modelId) =>
      new (class extends AzureOpenAILanguageModel {
        async generate(input: ModelGenerateInput<AzureOpenAILanguageModelOptions>): Promise<GenerateResult> {
          const { signal, cleanup } = withTimeoutSignal(input);
          try {
            if (hasHostedTools(input.tools)) {
              const previousResponse = getProviderResponseId(input.messages);
              const messages =
                previousResponse && previousResponse.index < input.messages.length - 1
                  ? input.messages.slice(previousResponse.index + 1)
                  : input.messages;
              const response = await withRetry(
                () =>
                  fetcher(resolveURL(modelId, "responses"), {
                    method: "POST",
                    headers: jsonHeaders(apiKey),
                    signal,
                    body: JSON.stringify({
                      model: baseURL.endsWith("/openai/v1") ? modelId : undefined,
                      ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
                      ...(messages.length ? { input: toResponsesInput(messages) } : {}),
                      tools: mapResponsesTools(input.tools),
                      tool_choice: mapToolChoice(input.toolChoice),
                      text: mapResponsesStructuredOutput(input),
                      temperature: input.temperature,
                      max_output_tokens: input.maxTokens,
                      ...input.providerOptions,
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
                text: assistantMessage.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
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
                fetcher(resolveURL(modelId, "chat/completions"), {
                  method: "POST",
                  headers: jsonHeaders(apiKey),
                  signal,
                  body: JSON.stringify({
                    model: baseURL.endsWith("/openai/v1") ? modelId : undefined,
                    messages: mapMessages(input.messages),
                    tools: mapTools(input.tools),
                    tool_choice: mapToolChoice(input.toolChoice),
                    response_format: mapStructuredOutput(input),
                    temperature: input.temperature,
                    ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
                    ...input.providerOptions,
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
              text: assistantMessage.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
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

        async stream(input: ModelGenerateInput<AzureOpenAILanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
          if (hasHostedTools(input.tools)) {
            const { signal, cleanup } = withTimeoutSignal(input);
            const response = await withRetry(
              () =>
                fetcher(resolveURL(modelId, "responses"), {
                  method: "POST",
                  headers: jsonHeaders(apiKey),
                  signal,
                  body: JSON.stringify({
                    model: baseURL.endsWith("/openai/v1") ? modelId : undefined,
                    input: toResponsesInput(input.messages),
                    tools: mapResponsesTools(input.tools),
                    tool_choice: mapToolChoice(input.toolChoice),
                    text: mapResponsesStructuredOutput(input),
                    temperature: input.temperature,
                    max_output_tokens: input.maxTokens,
                    ...input.providerOptions,
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

          const { signal, cleanup } = withTimeoutSignal(input);
          const response = await withRetry(
            () =>
              fetcher(resolveURL(modelId, "chat/completions"), {
                method: "POST",
                headers: jsonHeaders(apiKey),
                signal,
                  body: JSON.stringify({
                    model: baseURL.endsWith("/openai/v1") ? modelId : undefined,
                    messages: mapMessages(input.messages),
                    tools: mapTools(input.tools),
                    tool_choice: mapToolChoice(input.toolChoice),
                    response_format: mapStructuredOutput(input),
                    temperature: input.temperature,
                  ...(input.reasoning ? {} : { max_tokens: input.maxTokens }),
                  ...input.providerOptions,
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
                  const existing = toolBuffers.get(id) ?? { name: "", args: "" };
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
      })(modelId, apiKey, baseURL, fetcher),
    embeddingModel: (modelId) =>
      new (class extends AzureOpenAIEmbeddingModel {
        async embed(input: EmbedInput & { abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<EmbedResult> {
          const { signal, cleanup } = withTimeoutSignal(input);

          try {
            const response = await withRetry(
              () =>
                fetcher(resolveURL(modelId, "embeddings"), {
                  method: "POST",
                  headers: jsonHeaders(apiKey),
                  signal,
                  body: JSON.stringify({
                    model: baseURL.endsWith("/openai/v1") ? modelId : undefined,
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
      })(modelId, apiKey, baseURL, fetcher),
    transcriptionModel: (modelId) => new AzureOpenAITranscriptionModel(modelId, apiKey, resolveURL, fetcher),
    speechModel: (modelId) => new AzureOpenAISpeechModel(modelId, apiKey, resolveURL, fetcher),
    groundedLanguageModel: (modelId) => new AzureOpenAIGroundedLanguageModel(modelId, apiKey, resolveURL, fetcher),
    rawFetch: fetcher
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
