import { toJSONSchema } from "zod";

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type Message
} from "@aws-sdk/client-bedrock-runtime";

import {
  ConfigurationError,
  isCallableToolDefinition,
  ProviderHTTPError,
  UnsupportedFeatureError,
  ValidationError,
  createProviderAdapter,
  createMcpToolSet,
  hostedTool,
  normalizeFinishReason,
  providerDataPart,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type GenerateResult,
  type JsonValue,
  type LanguageModel,
  type McpCallToolRequest,
  type McpCallToolResponse,
  type McpClient,
  type McpListedTool,
  type McpListToolsResponse,
  type McpToolSetOptions,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent,
  type ToolSet
} from "@zhivex-ai/core";

export interface BedrockProviderOptions {
  client?: BedrockRuntimeClient;
  region?: string;
  runtime?: "converse" | "openai";
  baseURL?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export interface BedrockLanguageModelOptions {
  additionalModelRequestFields?: Record<string, unknown>;
  additionalModelResponseFieldPaths?: string[];
  [key: string]: unknown;
}

export interface BedrockOpenAICompatibleLanguageModelOptions {
  [key: string]: unknown;
}

export interface BedrockServerToolConfig {
  name: string;
  type: string;
  config?: JsonValue;
  toolClass?: "web-search" | "code-execution" | "remote-mcp" | "custom";
  requiresApproval?: boolean;
}

export interface BedrockWebSearchToolConfig {
  type?: "web_search";
  search_context_size?: "small" | "medium" | "large" | "low" | "high";
}

export interface BedrockCodeExecutionToolConfig {
  container?: string | { type: "auto"; memory_limit?: "1g" | "4g" | "16g" | "64g"; file_ids?: string[] };
}

export interface BedrockRemoteMcpToolConfig {
  server_label?: string;
  server_url: string;
  server_description?: string;
  headers?: Record<string, string>;
  authorization?: string;
  require_approval?: "never" | "always" | Record<string, JsonValue>;
  allowed_tools?: string[] | Record<string, JsonValue>;
}

export interface BedrockMcpApprovalResponse {
  approval_request_id: string;
  approve: boolean;
  id?: string;
  reason?: string;
}

export interface BedrockAgentCoreMcpClientOptions {
  runtimeArn?: string;
  endpoint?: string;
  region?: string;
  qualifier?: string;
  bearerToken?: string;
  authorization?: string;
  headers?: Record<string, string>;
  sessionId?: string;
  fetch?: typeof globalThis.fetch;
}

export type BedrockAgentCoreMcpToolSetOptions = BedrockAgentCoreMcpClientOptions;

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

const openAICompatibleCapabilities: ModelCapabilities = {
  ...capabilities,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-a",
    toolChoiceNone: true,
    approvalRequests: true,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: true,
    computerUse: false,
    codeExecution: true,
    toolsets: false
  }
};

const getHeader = (headers: Headers, name: string) => headers.get(name) ?? headers.get(name.toLowerCase());

const parseAgentCoreRegion = (runtimeArn: string) => runtimeArn.split(":")[3];

const createBedrockAgentCoreMcpEndpoint = (options: BedrockAgentCoreMcpClientOptions) => {
  if (options.endpoint) {
    return options.endpoint;
  }

  if (!options.runtimeArn) {
    throw new ConfigurationError("Missing Bedrock AgentCore MCP endpoint or runtime ARN.");
  }

  const region = options.region ?? parseAgentCoreRegion(options.runtimeArn);
  if (!region) {
    throw new ConfigurationError("Missing AWS region for Bedrock AgentCore MCP runtime.");
  }

  const qualifier = options.qualifier ?? "DEFAULT";
  const encodedArn = encodeURIComponent(options.runtimeArn);
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodedArn}/invocations?qualifier=${encodeURIComponent(
    qualifier
  )}`;
};

const parseMcpHttpResponse = async (response: Response): Promise<Record<string, unknown>> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for await (const event of streamSSE(response)) {
      if (event.data === "[DONE]") {
        break;
      }
      const data = event.data.trim();
      if (data) {
        return JSON.parse(data) as Record<string, unknown>;
      }
    }
    throw new ProviderHTTPError("Bedrock AgentCore MCP response did not include a JSON-RPC payload.", response.status);
  }

  return (await response.json()) as Record<string, unknown>;
};

const requireJsonRpcResult = <T>(json: Record<string, unknown>, method: string): T => {
  if (json.error && typeof json.error === "object") {
    const error = json.error as { message?: string; code?: number };
    throw new ProviderHTTPError(
      `Bedrock AgentCore MCP ${method} failed: ${error.message ?? "JSON-RPC error"}.`,
      typeof error.code === "number" ? error.code : 500,
      {
        responseBody: JSON.stringify(json)
      }
    );
  }

  return json.result as T;
};

const supportedImageFormats = new Set(["png", "jpeg", "gif", "webp"]);

const parseDataUrl = (value: string) => {
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new ValidationError("Bedrock image inputs must be provided as data URLs.");
  }

  return {
    mediaType: match[1].toLowerCase(),
    bytes: Buffer.from(match[2], "base64")
  };
};

const toBedrockImageFormat = (mediaType: string) => {
  const subtype = mediaType.split("/")[1]?.toLowerCase() ?? "";
  if (!supportedImageFormats.has(subtype)) {
    throw new ValidationError(`Unsupported Bedrock image media type "${mediaType}".`);
  }
  return subtype as "png" | "jpeg" | "gif" | "webp";
};

const mapMessagePart = (part: ModelMessage["parts"][number]): ContentBlock[] => {
  switch (part.type) {
    case "text":
      return part.text ? [{ text: part.text }] : [];
    case "image": {
      const parsed = parseDataUrl(part.image);
      return [
        {
          image: {
            format: toBedrockImageFormat(part.mediaType ?? parsed.mediaType),
            source: {
              bytes: parsed.bytes
            }
          }
        }
      ];
    }
    case "tool-call":
      return [
        {
          toolUse: {
            toolUseId: part.toolCall.id,
            name: part.toolCall.name,
            input: part.toolCall.input
          }
        }
      ];
    default:
      return [];
  }
};

const mapToolResultContent = (toolResult: Extract<ModelMessage["parts"][number], { type: "tool-result" }>["toolResult"]) => {
  const value = toolResult.isError ? toolResult.error : toolResult.output;

  if (typeof value === "string") {
    return [{ text: value }];
  }

  return [{ json: value ?? null }];
};

const systemBlocksFromMessages = (messages: ModelMessage[]) => {
  const text = messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return text ? [{ text }] : undefined;
};

const mapMessages = (messages: ModelMessage[]): Message[] =>
  messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          role: "user",
          content: message.parts.flatMap((part) =>
            part.type === "tool-result"
              ? [
                  {
                    toolResult: {
                      toolUseId: part.toolResult.toolCallId,
                      content: mapToolResultContent(part.toolResult),
                      ...(part.toolResult.isError ? { status: "error" as const } : {})
                    }
                  }
                ]
              : []
          )
        };
      }

      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.parts.flatMap(mapMessagePart)
      };
    });

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? (() => {
        const toolDefinitions = Object.values(tools);
        const callableTools = toolDefinitions.filter(isCallableToolDefinition);
        if (callableTools.length !== toolDefinitions.length) {
          throw new UnsupportedFeatureError('Provider "bedrock" does not support hosted tools.');
        }

        return callableTools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: {
              json: toJSONSchema(tool.schema)
            }
          }
        })) as unknown as NonNullable<ConverseCommandInput["toolConfig"]>["tools"];
      })()
    : undefined;

const mapToolChoice = (
  toolChoice: ModelGenerateInput["toolChoice"]
): NonNullable<ConverseCommandInput["toolConfig"]>["toolChoice"] | undefined => {
  if (!toolChoice || toolChoice === "auto") {
    return undefined;
  }

  if (toolChoice === "none") {
    return undefined;
  }

  if (toolChoice === "required") {
    return {
      any: {}
    };
  }

  return {
    tool: {
      name: toolChoice.toolName
    }
  } as unknown as NonNullable<ConverseCommandInput["toolConfig"]>["toolChoice"];
};

const mapStructuredOutput = (structuredOutput: ModelGenerateInput["structuredOutput"]) => {
  if (!structuredOutput || structuredOutput.mode !== "native") {
    return undefined;
  }

  return {
    type: "json_schema",
    structure: {
      jsonSchema: {
        schema: JSON.stringify(toJSONSchema(structuredOutput.schema)),
        name: structuredOutput.name ?? "response",
        ...(structuredOutput.description ? { description: structuredOutput.description } : {})
      }
    }
  };
};

const mapOpenAIToolOutput = (message: ModelMessage) =>
  message.parts
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "tool-result" }> => part.type === "tool-result")
    .map((part) => ({
      type: "function_call_output",
      call_id: part.toolResult.toolCallId,
      output: JSON.stringify(part.toolResult.isError ? part.toolResult.error : part.toolResult.output ?? null)
    }));

const mapOpenAIProviderDataInput = (message: ModelMessage) =>
  message.parts
    .filter(
      (part): part is Extract<ModelMessage["parts"][number], { type: "provider-data" }> =>
        part.type === "provider-data" &&
        part.provider === "bedrock" &&
        part.data !== null &&
        typeof part.data === "object" &&
        (part.data as Record<string, unknown>).type === "mcp_approval_response"
    )
    .map((part) => part.data as Record<string, unknown>);

const mapOpenAIInput = (messages: ModelMessage[]) => {
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push(...mapOpenAIToolOutput(message));
      continue;
    }

    input.push(...mapOpenAIProviderDataInput(message));

    const content: Array<Record<string, unknown>> = [];
    for (const part of message.parts) {
      if (part.type === "text") {
        content.push({ type: "input_text", text: part.text });
      }
      if (part.type === "tool-call" && message.role === "assistant") {
        content.push({
          type: "function_call",
          call_id: part.toolCall.id,
          name: part.toolCall.name,
          arguments: JSON.stringify(part.toolCall.input)
        });
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

const getOpenAICompatibleResponseId = (messages: ModelMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const providerData = messages[index]?.parts.find(
      (part) =>
        part.type === "provider-data" &&
        part.provider === "bedrock" &&
        part.data !== null &&
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

const mapOpenAITools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? Object.values(tools).map((definition) => {
        if (isCallableToolDefinition(definition)) {
          return {
            type: "function",
            name: definition.name,
            description: definition.description,
            parameters: toJSONSchema(definition.schema)
          };
        }

        if (definition.provider && definition.provider !== "bedrock") {
          throw new UnsupportedFeatureError(
            `Provider "bedrock" does not support hosted tools declared for provider "${definition.provider}".`
          );
        }

        return {
          type: definition.type,
          ...(definition.config && typeof definition.config === "object" ? definition.config : {})
        };
      })
    : undefined;

const mapOpenAIToolChoice = (toolChoice: ModelGenerateInput["toolChoice"]) => {
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

const parseOpenAICompatibleMessage = (json: any): ModelMessage => {
  const output = json.output ?? [];
  const parts: ModelMessage["parts"] = [];

  for (const item of output) {
    if (item.type === "message") {
      for (const content of item.content ?? []) {
        if (typeof content.text === "string") {
          parts.push({ type: "text", text: content.text });
        }
        if (typeof content.output_text === "string") {
          parts.push({ type: "text", text: content.output_text });
        }
      }
    }
    if (item.type === "function_call") {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: item.call_id ?? item.id,
          name: item.name,
          input: JSON.parse(item.arguments ?? "{}")
        }
      });
    }
    if (
      item.type &&
      !["message", "function_call"].includes(item.type) &&
      item.type !== "function_call_output" &&
      typeof item === "object"
    ) {
      parts.push(providerDataPart("bedrock", item as JsonValue));
    }
  }

  if (!parts.some((part) => part.type === "text") && typeof json.output_text === "string" && json.output_text) {
    parts.push({ type: "text", text: json.output_text });
  }

  if (typeof json.id === "string") {
    parts.push(providerDataPart("bedrock", { responseId: json.id }));
  }
  return { role: "assistant", parts };
};

const normalizeOpenAICompatibleFinishReason = (status: unknown, hasToolCalls: boolean) => {
  if (hasToolCalls) {
    return "tool-calls" as const;
  }
  if (status === "completed") {
    return "stop" as const;
  }
  if (status === "incomplete") {
    return "length" as const;
  }
  if (status === "failed") {
    return "error" as const;
  }
  return "unknown" as const;
};

const parseAssistantMessage = (message: { content?: ContentBlock[] } | undefined): ModelMessage => {
  const parts: ModelMessage["parts"] = [];

  for (const block of message?.content ?? []) {
    const chunk = block as any;

    if (chunk.text) {
      parts.push({ type: "text", text: chunk.text });
      continue;
    }

    if (chunk.toolUse) {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: chunk.toolUse.toolUseId,
          name: chunk.toolUse.name,
          input: chunk.toolUse.input ?? {}
        }
      });
    }
  }

  return {
    role: "assistant",
    parts
  };
};

const normalizeBedrockError = (error: unknown) => {
  const err = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const message = err.message || "Bedrock request failed.";
  const lower = message.toLowerCase();
  const status = err.$metadata?.httpStatusCode;

  if (status === 401 || status === 403 || lower.includes("accessdenied") || lower.includes("credential")) {
    return new ConfigurationError(message, { cause: error });
  }

  if (status === 400 || lower.includes("validation") || lower.includes("model")) {
    return new ValidationError(message, { cause: error });
  }

  return error instanceof Error ? error : new Error(message);
};

class BedrockLanguageModel implements LanguageModel<BedrockLanguageModelOptions> {
  readonly provider = "bedrock";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly client: BedrockRuntimeClient
  ) {}

  private toCommandInput(input: ModelGenerateInput): ConverseCommandInput {
    const providerOptions = (input.providerOptions ?? {}) as Record<string, unknown>;
    const outputConfigFromProviderOptions =
      typeof providerOptions.outputConfig === "object" && providerOptions.outputConfig
        ? (providerOptions.outputConfig as Record<string, unknown>)
        : undefined;
    const { outputConfig: _outputConfig, ...otherProviderOptions } = providerOptions;
    const textFormat = mapStructuredOutput(input.structuredOutput);
    const tools = input.toolChoice === "none" ? undefined : mapTools(input.tools);
    const toolChoice = input.toolChoice === "none" ? undefined : mapToolChoice(input.toolChoice);

    return {
      modelId: this.modelId,
      messages: mapMessages(input.messages),
      system: systemBlocksFromMessages(input.messages),
      inferenceConfig: {
        temperature: input.temperature,
        maxTokens: input.maxTokens
      },
      ...(tools || toolChoice
        ? {
            toolConfig: {
              ...(tools ? { tools } : {}),
              ...(toolChoice ? { toolChoice } : {})
            } as ConverseCommandInput["toolConfig"]
          }
        : {}),
      ...(textFormat || outputConfigFromProviderOptions
        ? {
            outputConfig: {
              ...(outputConfigFromProviderOptions ?? {}),
              ...(textFormat ? { textFormat } : {})
            } as ConverseCommandInput["outputConfig"]
          }
        : {}),
      ...otherProviderOptions
    };
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { cleanup } = withTimeoutSignal(input);

    try {
      if (input.reasoning) {
        throw new UnsupportedFeatureError('Provider "bedrock" does not support "reasoning".');
      }

      const commandInput = this.toCommandInput(input);

      const response = await withRetry(() => this.client.send(new ConverseCommand(commandInput)), input).catch((error) => {
        throw normalizeBedrockError(error);
      });

      const assistantMessage = parseAssistantMessage(response.output?.message);
      const text = assistantMessage.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

      return {
        messages: [assistantMessage],
        text,
        finishReason: normalizeFinishReason(response.stopReason),
        providerFinishReason: response.stopReason,
        usage: {
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          totalTokens:
            response.usage?.totalTokens ?? ((response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0))
        },
        rawResponse: response
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
    const { cleanup } = withTimeoutSignal(input);

    if (input.reasoning) {
      throw new UnsupportedFeatureError('Provider "bedrock" does not support "reasoning".');
    }

    const commandInput = this.toCommandInput(input);
    const response = await withRetry(() => this.client.send(new ConverseStreamCommand(commandInput)), input).catch(
      (error) => {
        throw normalizeBedrockError(error);
      }
    );

    return (async function* () {
      try {
        const toolBuffers = new Map<number, { id: string; name: string; input: string }>();
        const stream = response.stream;
        if (!stream) {
          throw new ValidationError("Bedrock streaming response did not include a stream.");
        }

        for await (const event of stream as AsyncIterable<Record<string, any>>) {
          if (event.contentBlockStart?.start?.toolUse) {
            toolBuffers.set(event.contentBlockStart.contentBlockIndex, {
              id: event.contentBlockStart.start.toolUse.toolUseId,
              name: event.contentBlockStart.start.toolUse.name,
              input: ""
            });
            continue;
          }

          if (event.contentBlockDelta?.delta?.text) {
            yield {
              type: "text-delta",
              textDelta: event.contentBlockDelta.delta.text
            } satisfies StreamEvent;
            continue;
          }

          if (event.contentBlockDelta?.delta?.toolUse) {
            const index = event.contentBlockDelta.contentBlockIndex;
            const current = toolBuffers.get(index) ?? {
              id: `${index}`,
              name: "",
              input: ""
            };
            current.input += event.contentBlockDelta.delta.toolUse.input ?? "";
            toolBuffers.set(index, current);
            continue;
          }

          if (event.contentBlockStop) {
            const current = toolBuffers.get(event.contentBlockStop.contentBlockIndex);
            if (current) {
              yield {
                type: "tool-call",
                toolCall: {
                  id: current.id,
                  name: current.name,
                  input: JSON.parse(current.input || "{}")
                }
              } satisfies StreamEvent;
            }
            continue;
          }

          if (event.messageStop) {
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(event.messageStop.stopReason),
              providerFinishReason: event.messageStop.stopReason
            } satisfies StreamEvent;
            continue;
          }

          if (event.metadata?.usage) {
            yield {
              type: "finish",
              usage: {
                inputTokens: event.metadata.usage.inputTokens,
                outputTokens: event.metadata.usage.outputTokens,
                totalTokens:
                  event.metadata.usage.totalTokens ??
                  ((event.metadata.usage.inputTokens ?? 0) + (event.metadata.usage.outputTokens ?? 0))
              }
            } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
  }
}

class BedrockOpenAICompatibleLanguageModel implements LanguageModel<BedrockOpenAICompatibleLanguageModelOptions> {
  readonly provider = "bedrock";
  readonly capabilities = openAICompatibleCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generate(input: ModelGenerateInput<BedrockOpenAICompatibleLanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const previousResponse = getOpenAICompatibleResponseId(input.messages);
      const messages =
        previousResponse && previousResponse.index < input.messages.length - 1
          ? input.messages.slice(previousResponse.index + 1)
          : input.messages;
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/responses`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.apiKey}`
            },
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              model: this.modelId,
              ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
              input: mapOpenAIInput(messages),
              tools: mapOpenAITools(input.tools),
              tool_choice: mapOpenAIToolChoice(input.toolChoice),
              temperature: input.temperature,
              max_output_tokens: input.maxTokens,
              stream: false
            })
          }),
        input
      );
      const json = await response.json();
      if (!response.ok) {
        throw new ProviderHTTPError(`Bedrock OpenAI-compatible request failed with status ${response.status}.`, response.status, {
          responseBody: JSON.stringify(json)
        });
      }
      const assistantMessage = parseOpenAICompatibleMessage(json);
      const hasToolCalls = assistantMessage.parts.some((part) => part.type === "tool-call");
      return {
        messages: [assistantMessage],
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        finishReason: normalizeOpenAICompatibleFinishReason(json.status, hasToolCalls),
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

  async stream(input: ModelGenerateInput<BedrockOpenAICompatibleLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const previousResponse = getOpenAICompatibleResponseId(input.messages);
    const messages =
      previousResponse && previousResponse.index < input.messages.length - 1
        ? input.messages.slice(previousResponse.index + 1)
        : input.messages;
    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`
          },
          signal,
          body: JSON.stringify({
            ...input.providerOptions,
            model: this.modelId,
            ...(previousResponse ? { previous_response_id: previousResponse.responseId } : {}),
            input: mapOpenAIInput(messages),
            tools: mapOpenAITools(input.tools),
            tool_choice: mapOpenAIToolChoice(input.toolChoice),
            temperature: input.temperature,
            max_output_tokens: input.maxTokens,
            stream: true
          })
        }),
      input
    );

    return (async function* () {
      try {
        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            return;
          }
          const json = JSON.parse(event.data);
          if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
            yield { type: "text-delta", textDelta: json.delta } satisfies StreamEvent;
          }
          if (json.type === "response.output_item.done" && json.item?.type === "function_call") {
            yield {
              type: "tool-call",
              toolCall: {
                id: json.item.call_id ?? json.item.id,
                name: json.item.name,
                input: JSON.parse(json.item.arguments ?? "{}")
              }
            } satisfies StreamEvent;
          }
          if (
            json.type === "response.output_item.done" &&
            json.item?.type &&
            !["message", "function_call", "function_call_output"].includes(json.item.type)
          ) {
            yield {
              type: "provider-data",
              provider: "bedrock",
              data: json.item as JsonValue
            } satisfies StreamEvent;
          }
          if (json.type === "response.completed") {
            yield {
              type: "finish",
              finishReason: "stop",
              providerFinishReason: "completed",
              usage: json.response?.usage
                ? {
                    inputTokens: json.response.usage.input_tokens,
                    outputTokens: json.response.usage.output_tokens,
                    totalTokens: json.response.usage.total_tokens
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

class BedrockAgentCoreMcpClient implements McpClient {
  private readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  private sessionId: string | undefined;
  private requestId = 0;

  constructor(private readonly options: BedrockAgentCoreMcpClientOptions) {
    this.endpoint = createBedrockAgentCoreMcpEndpoint(options);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.sessionId = options.sessionId;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.options.headers ?? {}),
      ...(this.options.authorization || this.options.bearerToken
        ? { Authorization: this.options.authorization ?? `Bearer ${this.options.bearerToken}` }
        : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {})
    };
  }

  private async request<T>(method: "tools/list" | "tools/call", params?: Record<string, JsonValue>): Promise<T> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `bedrock-agentcore-${++this.requestId}`,
        method,
        ...(params ? { params } : {})
      })
    });

    const returnedSessionId = getHeader(response.headers, "Mcp-Session-Id");
    if (returnedSessionId) {
      this.sessionId = returnedSessionId;
    }

    const json = await parseMcpHttpResponse(response);
    if (!response.ok) {
      throw new ProviderHTTPError(`Bedrock AgentCore MCP request failed with status ${response.status}.`, response.status, {
        responseBody: JSON.stringify(json)
      });
    }

    return requireJsonRpcResult<T>(json, method);
  }

  async listTools(): Promise<McpListToolsResponse | McpListedTool[]> {
    return this.request<McpListToolsResponse>("tools/list");
  }

  async callTool(input: McpCallToolRequest): Promise<JsonValue | McpCallToolResponse> {
    return this.request<McpCallToolResponse>("tools/call", {
      name: input.name,
      arguments: input.arguments ?? {}
    });
  }
}

export const createBedrock = (options: BedrockProviderOptions = {}): CallableProviderAdapter & ProviderAdapter => {
  if (options.runtime === "openai") {
    const apiKey = options.apiKey ?? process.env.BEDROCK_API_KEY ?? process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (!apiKey) {
      throw new ConfigurationError("Missing Bedrock OpenAI-compatible API key.");
    }
    const baseURL = (options.baseURL ?? process.env.BEDROCK_OPENAI_BASE_URL)?.replace(/\/+$/, "");
    if (!baseURL) {
      throw new ConfigurationError("Missing Bedrock OpenAI-compatible base URL.");
    }
    const fetcher = options.fetch ?? globalThis.fetch;
    return createProviderAdapter({
      name: "bedrock",
      languageModel: (modelId) => new BedrockOpenAICompatibleLanguageModel(modelId, apiKey, baseURL, fetcher)
    });
  }

  const client =
    options.client ??
    (() => {
      const region = options.region ?? process.env.AWS_REGION;
      if (!region) {
        throw new ConfigurationError("Missing AWS region for Bedrock.");
      }
      return new BedrockRuntimeClient(
        options.apiKey
          ? {
              region,
              token: { token: options.apiKey }
            }
          : { region }
      );
    })();

  return createProviderAdapter({
    name: "bedrock",
    languageModel: (modelId) => new BedrockLanguageModel(modelId, client)
  });
};

export const bedrockServerTool = (config: BedrockServerToolConfig) =>
  hostedTool({
    name: config.name,
    provider: "bedrock",
    type: config.type,
    toolClass: config.toolClass ?? "custom",
    requiresApproval: config.requiresApproval,
    config: config.config ?? {}
  });

export const bedrockWebSearchTool = (config: BedrockWebSearchToolConfig = {}) =>
  hostedTool({
    name: "web_search",
    provider: "bedrock",
    type: config.type ?? "web_search",
    toolClass: "web-search",
    config: config as unknown as JsonValue
  });

export const bedrockCodeExecutionTool = (config: BedrockCodeExecutionToolConfig = {}) =>
  hostedTool({
    name: "code_interpreter",
    provider: "bedrock",
    type: "code_interpreter",
    toolClass: "code-execution",
    config: config as unknown as JsonValue
  });

export const bedrockRemoteMcpTool = (config: BedrockRemoteMcpToolConfig) =>
  hostedTool({
    name: config.server_label ?? "mcp",
    provider: "bedrock",
    type: "mcp",
    toolClass: "remote-mcp",
    requiresApproval: config.require_approval !== "never",
    config: config as unknown as JsonValue
  });

export const bedrockMcpApprovalResponse = (response: BedrockMcpApprovalResponse) =>
  providerDataPart("bedrock", {
    type: "mcp_approval_response",
    ...response
  });

export const createBedrockAgentCoreMcpClient = (options: BedrockAgentCoreMcpClientOptions): McpClient =>
  new BedrockAgentCoreMcpClient(options);

export const createBedrockAgentCoreMcpToolSet = (
  options: BedrockAgentCoreMcpToolSetOptions,
  mcpOptions?: McpToolSetOptions
): Promise<ToolSet> => createMcpToolSet(createBedrockAgentCoreMcpClient(options), mcpOptions);
