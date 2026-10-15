import { toJSONSchema } from "zod";

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type BedrockRuntimeClientConfig,
  type ContentBlock,
  type ConverseCommandInput,
  type Message
} from "@aws-sdk/client-bedrock-runtime";

import {
  ConfigurationError,
  isCallableToolDefinition,
  ProviderHTTPError,
  ProviderToolCallError,
  UnsupportedFeatureError,
  ValidationError,
  assertTrustedEndpoint,
  createProviderAdapter,
  createMcpToolSet,
  hostedTool,
  normalizeFinishReason,
  providerDataPart,
  streamSSE,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  withRetry,
  withResponseRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type FinishReason,
  type GenerateResult,
  type JsonValue,
  type LanguageModel,
  type McpCallToolRequest,
  type McpCallToolResponse,
  type McpCallToolOptions,
  type McpClient,
  type McpListedTool,
  type McpListToolsRequest,
  type McpListToolsResponse,
  type McpToolSetOptions,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type StreamEvent,
  type TokenUsage,
  type ToolSet
} from "@zhivex-ai/core/provider";

export interface BedrockProviderOptions {
  client?: BedrockRuntimeClient;
  /**
   * AWS region. When omitted, the AWS SDK resolves `AWS_REGION`, `AWS_DEFAULT_REGION`,
   * and the shared config profile on its own.
   */
  region?: string;
  /** Static credentials or an AWS credential provider. Assume-role callers can pass `fromTemporaryCredentials()`. */
  credentials?: BedrockRuntimeClientConfig["credentials"];
  /** Shared config profile for this client. Does not mutate `AWS_PROFILE`. */
  profile?: string;
  /**
   * SDK attempt budget, including the first call. Defaults to 1 so `maxRetries` is the only retry layer.
   * Inject your own `client` to keep the AWS SDK retry mode.
   */
  maxAttempts?: number;
  runtime?: "converse" | "openai";
  baseURL?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  allowUnsafeEndpoints?: boolean;
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
  allowUnsafeEndpoints?: boolean;
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
  reasoning: true,
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
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
    return assertTrustedEndpoint(options.endpoint, {
      label: "Bedrock AgentCore MCP endpoint",
      protocols: ["https"],
      allowUnsafe: options.allowUnsafeEndpoints
    }).toString();
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

  return readJsonWithLimit<Record<string, unknown>>(response, {
    maxBytes: 16 * 1024 * 1024,
    provider: "bedrock",
    endpoint: "agentcore-mcp"
  });
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

const BEDROCK_REASONING_TYPE = "reasoning_content";

const stripBedrockModelId = (modelId: string) => {
  const arn = modelId.match(/(?:foundation-model|inference-profile)\/([^/]+)$/);
  const raw = arn?.[1] ?? modelId;
  return raw.replace(/^(?:global|us|eu|apac|jp|au|in)\./, "");
};

const isClaudeModel = (modelId: string) => /anthropic\.claude|claude-/.test(stripBedrockModelId(modelId));

const usesAdaptiveClaudeThinking = (modelId: string) => {
  const id = stripBedrockModelId(modelId);
  return /claude-(?:fable|mythos)(?:-|$)/.test(id)
    || /claude-(?:opus|sonnet)-4\.(?:[6-9]|[1-9]\d)/.test(id)
    || /claude-(?:opus|sonnet|haiku)-[5-9]/.test(id);
};

const isNova2Model = (modelId: string) => /amazon\.nova-2/.test(stripBedrockModelId(modelId));

const readsReasoningContent = (modelId: string) => {
  const id = stripBedrockModelId(modelId);
  return /deepseek\.r1|deepseek-r1/.test(id) || /gpt-oss/.test(id);
};

const bytesToBase64 = (value: Uint8Array | string) =>
  typeof value === "string" ? value : Buffer.from(value).toString("base64");

const reasoningProviderData = (block: {
  reasoningText?: { text?: string; signature?: string };
  redactedContent?: Uint8Array | string;
}): JsonValue => ({
  type: BEDROCK_REASONING_TYPE,
  replay: true,
  ...(block.reasoningText?.text || block.reasoningText?.signature
    ? {
        reasoningText: {
          ...(block.reasoningText.text ? { text: block.reasoningText.text } : {}),
          ...(block.reasoningText.signature ? { signature: block.reasoningText.signature } : {})
        }
      }
    : {}),
  ...(block.redactedContent ? { redactedContent: bytesToBase64(block.redactedContent) } : {})
});

const reasoningContentBlock = (part: ModelMessage["parts"][number]): ContentBlock[] | undefined => {
  if (part.type !== "provider-data" || part.provider !== "bedrock" || !part.data || typeof part.data !== "object") {
    return undefined;
  }
  const data = part.data as Record<string, unknown>;
  if (data.type !== BEDROCK_REASONING_TYPE || data.replay !== true) {
    return [];
  }
  const reasoningText = data.reasoningText;
  const text = reasoningText && typeof reasoningText === "object"
    ? reasoningText as { text?: unknown; signature?: unknown }
    : undefined;
  const redacted = typeof data.redactedContent === "string" ? data.redactedContent : undefined;
  if (!text?.text && !text?.signature && !redacted) {
    return [];
  }
  return [{
    reasoningContent: {
      ...(typeof text?.text === "string" || typeof text?.signature === "string"
        ? {
            reasoningText: {
              text: typeof text.text === "string" ? text.text : "",
              ...(typeof text.signature === "string" ? { signature: text.signature } : {})
            }
          }
        : {}),
      ...(redacted ? { redactedContent: Buffer.from(redacted, "base64") } : {})
    }
  } as ContentBlock];
};

const historyHasToolBlocks = (messages: ModelMessage[]) =>
  messages.some((message) => message.parts.some((part) => part.type === "tool-call" || part.type === "tool-result"));

const mapBedrockStopReason = (reason: string | undefined): FinishReason | undefined => {
  if (!reason) {
    return undefined;
  }
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "guardrail_intervened":
    case "content_filtered":
      return "content-filter";
    case "malformed_model_output":
    case "malformed_tool_use":
      return "error";
    default:
      return normalizeFinishReason(reason);
  }
};

const bedrockUsage = (usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
} | undefined): TokenUsage | undefined => usage ? {
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  totalTokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
  ...(usage.cacheReadInputTokens !== undefined ? { cachedInputTokens: usage.cacheReadInputTokens } : {}),
  ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteInputTokens } : {})
} : undefined;

const parseToolInput = (raw: string, effectsPossible: boolean): JsonValue => {
  try {
    const value = raw ? JSON.parse(raw) as unknown : {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Bedrock tool input must be a JSON object.");
    }
    return value as JsonValue;
  } catch (cause) {
    throw new ProviderToolCallError({
      provider: "bedrock",
      transport: "converse",
      diagnosticCode: "BEDROCK_MALFORMED_TOOL_USE",
      reason: "invalid_json",
      retryable: false,
      effectsPossible,
      cause
    });
  }
};

const claudeThinkingFields = (modelId: string, input: ModelGenerateInput): Record<string, unknown> => {
  const reasoning = input.reasoning;
  if (!reasoning) {
    return {};
  }
  if (usesAdaptiveClaudeThinking(modelId)) {
    if (reasoning.budgetTokens !== undefined) {
      throw new UnsupportedFeatureError(
        'Provider "bedrock" does not support "reasoning.budgetTokens" for this Claude model; use "reasoning.effort".'
      );
    }
    const effort = reasoning.effort;
    if (effort === "none") {
      if (/claude-(?:fable|mythos)(?:-|$)/.test(stripBedrockModelId(modelId))) {
        throw new UnsupportedFeatureError('Provider "bedrock" cannot disable thinking for Claude Fable or Claude Mythos.');
      }
      return { thinking: { type: "disabled" } };
    }
    if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      throw new UnsupportedFeatureError(`Provider "bedrock" does not support reasoning effort "${effort}" for this Claude model.`);
    }
    return {
      thinking: { type: "adaptive" },
      ...(effort ? { output_config: { effort } } : {})
    };
  }

  const budget = reasoning.budgetTokens ?? 1024;
  if (!Number.isSafeInteger(budget) || budget < 1024) {
    throw new ValidationError('Bedrock extended thinking requires "reasoning.budgetTokens" of at least 1024.');
  }
  if (input.maxTokens !== undefined && budget >= input.maxTokens) {
    throw new ValidationError('Bedrock extended thinking requires "reasoning.budgetTokens" to be less than "maxTokens".');
  }
  return { thinking: { type: "enabled", budget_tokens: budget } };
};

const novaReasoningFields = (input: ModelGenerateInput): Record<string, unknown> => {
  const reasoning = input.reasoning;
  if (!reasoning) {
    return {};
  }
  if (reasoning.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "bedrock" does not support "reasoning.budgetTokens" for Amazon Nova 2.');
  }
  const effort = reasoning.effort;
  if (effort === "none") {
    return { reasoningConfig: { type: "disabled" } };
  }
  if (effort === "high" && (input.temperature !== undefined || input.maxTokens !== undefined)) {
    throw new ValidationError('Amazon Nova 2 reasoning effort "high" cannot be combined with temperature or maxTokens.');
  }
  if (effort !== undefined && effort !== "low" && effort !== "medium" && effort !== "high") {
    throw new UnsupportedFeatureError(`Provider "bedrock" does not support reasoning effort "${effort}" for Amazon Nova 2.`);
  }
  return {
    reasoningConfig: {
      type: "enabled",
      ...(effort ? { maxReasoningEffort: effort } : {})
    }
  };
};

const bedrockReasoningFields = (modelId: string, input: ModelGenerateInput): Record<string, unknown> => {
  if (!input.reasoning) {
    return {};
  }
  if (isClaudeModel(modelId)) {
    return claudeThinkingFields(modelId, input);
  }
  if (isNova2Model(modelId)) {
    return novaReasoningFields(input);
  }
  if (readsReasoningContent(modelId)) {
    if (input.reasoning.budgetTokens !== undefined) {
      throw new UnsupportedFeatureError('Provider "bedrock" does not support "reasoning.budgetTokens" for this model.');
    }
    return {};
  }
  throw new UnsupportedFeatureError(`Provider "bedrock" does not support reasoning for model "${modelId}".`);
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
    case "provider-data":
      return reasoningContentBlock(part) ?? [];
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
    const chunk = block as {
      text?: string;
      toolUse?: { toolUseId: string; name: string; input?: JsonValue };
      reasoningContent?: {
        reasoningText?: { text?: string; signature?: string };
        redactedContent?: Uint8Array | string;
      };
    };

    if (chunk.text) {
      parts.push({ type: "text", text: chunk.text });
      continue;
    }

    if (chunk.reasoningContent) {
      parts.push(providerDataPart("bedrock", reasoningProviderData(chunk.reasoningContent)));
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

const RETRYABLE_BEDROCK_ERRORS: Record<string, number> = {
  ThrottlingException: 429,
  ServiceUnavailableException: 503,
  ModelNotReadyException: 429,
  InternalServerException: 500,
  ModelTimeoutException: 408,
  ModelStreamErrorException: 500
};

const bedrockRetryAfterMs = (error: unknown) => {
  const headers = (error as { $response?: { headers?: Record<string, string | undefined> } }).$response?.headers;
  const header = headers?.["retry-after"] ?? headers?.["Retry-After"];
  return header && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1_000 : undefined;
};

const isSdkError = (error: unknown): error is {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
} => Boolean(error) && typeof error === "object";

/**
 * Classify AWS SDK failures by exception name. Message text is not a signal:
 * retryable faults such as ModelTimeoutException often mention "model".
 */
const normalizeBedrockError = (error: unknown): Error => {
  if (
    error instanceof ConfigurationError ||
    error instanceof ValidationError ||
    error instanceof UnsupportedFeatureError ||
    error instanceof ProviderHTTPError ||
    error instanceof ProviderToolCallError
  ) {
    return error;
  }

  const err = isSdkError(error) ? error : undefined;
  const message = err?.message || "Bedrock request failed.";
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name;
  const retryAfterMs = bedrockRetryAfterMs(error);

  if (
    name === "AccessDeniedException" ||
    name === "UnrecognizedClientException" ||
    status === 401 ||
    status === 403
  ) {
    return new ConfigurationError(message, { cause: error });
  }

  const retryableStatus = name ? RETRYABLE_BEDROCK_ERRORS[name] : undefined;
  if (retryableStatus !== undefined) {
    return new ProviderHTTPError(message, status ?? retryableStatus, { cause: error, retryAfterMs });
  }

  if (name === "ValidationException" || status === 400 || name === "ServiceQuotaExceededException") {
    return new ValidationError(message, { cause: error });
  }

  if (name === "ResourceNotFoundException") {
    return new ConfigurationError(message, { cause: error });
  }

  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return new ProviderHTTPError(message, status, { cause: error, retryAfterMs });
  }

  return error instanceof Error ? error : new Error(message);
};

const STREAM_FAULTS: Record<string, string> = {
  internalServerException: "InternalServerException",
  modelStreamErrorException: "ModelStreamErrorException",
  validationException: "ValidationException",
  throttlingException: "ThrottlingException",
  serviceUnavailableException: "ServiceUnavailableException"
};

const streamFaultError = (event: Record<string, unknown>) => {
  for (const [key, name] of Object.entries(STREAM_FAULTS)) {
    const value = event[key];
    if (!value || typeof value !== "object") {
      continue;
    }
    const fault = value as { message?: string; $metadata?: { httpStatusCode?: number } };
    return { name, message: fault.message || name, $metadata: fault.$metadata };
  }
  return undefined;
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
    const {
      outputConfig: _outputConfig,
      additionalModelRequestFields: userRequestFields,
      ...otherProviderOptions
    } = providerOptions;
    const generatedFields = bedrockReasoningFields(this.modelId, input);
    const userFields =
      userRequestFields && typeof userRequestFields === "object" && !Array.isArray(userRequestFields)
        ? userRequestFields as Record<string, unknown>
        : {};
    const additionalModelRequestFields = { ...generatedFields, ...userFields };
    const textFormat = mapStructuredOutput(input.structuredOutput);
    const keepTools = input.toolChoice !== "none" || historyHasToolBlocks(input.messages);
    if (input.toolChoice === "none" && keepTools && !input.tools) {
      throw new ValidationError(
        'Bedrock requires tool definitions when toolChoice is "none" and the history contains tool blocks.'
      );
    }
    const tools = keepTools ? mapTools(input.tools) : undefined;
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
      ...(Object.keys(additionalModelRequestFields).length
        ? { additionalModelRequestFields: additionalModelRequestFields as ConverseCommandInput["additionalModelRequestFields"] }
        : {}),
      ...otherProviderOptions
    };
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const commandInput = this.toCommandInput(input);

      const response = await withRetry(async () => {
        try {
          return await this.client.send(new ConverseCommand(commandInput), { abortSignal: signal });
        } catch (error) {
          throw normalizeBedrockError(error);
        }
      }, input);

      const assistantMessage = parseAssistantMessage(response.output?.message);
      const text = assistantMessage.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

      return {
        messages: [assistantMessage],
        text,
        finishReason: mapBedrockStopReason(response.stopReason),
        providerFinishReason: response.stopReason,
        usage: bedrockUsage(response.usage),
        rawResponse: response
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);

    let response;
    try {
      const commandInput = this.toCommandInput(input);
      response = await withRetry(async () => {
        try {
          return await this.client.send(new ConverseStreamCommand(commandInput), { abortSignal: signal });
        } catch (error) {
          throw normalizeBedrockError(error);
        }
      }, input);
    } catch (error) {
      cleanup();
      throw error;
    }

    return (async function* () {
      let effectsPossible = false;
      let sawMessageStop = false;
      let finishEmitted = false;
      let stopReason: string | undefined;
      let usage: TokenUsage | undefined;
      const toolBuffers = new Map<number, { id: string; name: string; input: string }>();
      const reasoningBuffers = new Map<number, { text: string; signature?: string; redactedContent?: string }>();

      const finishEvent = (): StreamEvent => ({
        type: "finish",
        ...(stopReason
          ? { finishReason: mapBedrockStopReason(stopReason), providerFinishReason: stopReason }
          : {}),
        ...(usage ? { usage } : {})
      });

      const interrupted = (error: unknown) => {
        if (error instanceof ProviderToolCallError) {
          return error;
        }
        const normalized = normalizeBedrockError(error);
        if (!effectsPossible) {
          return normalized;
        }
        return new ProviderToolCallError({
          provider: "bedrock",
          transport: "converse",
          diagnosticCode: "BEDROCK_STREAM_INTERRUPTED",
          reason: "stream_truncated",
          effectsPossible: true,
          ...(usage ? { usage } : {}),
          cause: normalized
        });
      };

      try {
        const stream = response.stream;
        if (!stream) {
          throw new ValidationError("Bedrock streaming response did not include a stream.");
        }

        try {
          for await (const event of stream as AsyncIterable<Record<string, any>>) {
            const fault = streamFaultError(event);
            if (fault) {
              throw fault;
            }

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

            const reasoningDelta = event.contentBlockDelta?.delta?.reasoningContent;
            if (reasoningDelta) {
              const index = event.contentBlockDelta.contentBlockIndex as number;
              const current = reasoningBuffers.get(index) ?? { text: "" };
              if (typeof reasoningDelta.text === "string" && reasoningDelta.text) {
                current.text += reasoningDelta.text;
                yield {
                  type: "provider-data",
                  provider: "bedrock",
                  data: { type: "reasoning_delta", text: reasoningDelta.text }
                } satisfies StreamEvent;
              }
              if (typeof reasoningDelta.signature === "string") {
                current.signature = reasoningDelta.signature;
              }
              if (reasoningDelta.redactedContent) {
                current.redactedContent = bytesToBase64(reasoningDelta.redactedContent);
              }
              reasoningBuffers.set(index, current);
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
              const index = event.contentBlockStop.contentBlockIndex as number;
              const current = toolBuffers.get(index);
              if (current) {
                const toolCall = {
                  id: current.id,
                  name: current.name,
                  input: parseToolInput(current.input, effectsPossible)
                };
                effectsPossible = true;
                yield { type: "tool-call", toolCall } satisfies StreamEvent;
              }
              const reasoning = reasoningBuffers.get(index);
              if (reasoning && (reasoning.text || reasoning.signature || reasoning.redactedContent)) {
                yield {
                  type: "provider-data",
                  provider: "bedrock",
                  data: reasoningProviderData({
                    ...(reasoning.text || reasoning.signature
                      ? { reasoningText: { text: reasoning.text, ...(reasoning.signature ? { signature: reasoning.signature } : {}) } }
                      : {}),
                    ...(reasoning.redactedContent ? { redactedContent: reasoning.redactedContent } : {})
                  })
                } satisfies StreamEvent;
              }
              continue;
            }

            if (event.messageStop) {
              sawMessageStop = true;
              stopReason = event.messageStop.stopReason;
              continue;
            }

            if (event.metadata?.usage) {
              usage = bedrockUsage(event.metadata.usage);
              if (sawMessageStop && !finishEmitted) {
                finishEmitted = true;
                yield finishEvent();
              }
            }
          }
        } catch (error) {
          throw interrupted(error);
        }

        if (!sawMessageStop) {
          throw interrupted(new ConfigurationError("Bedrock Converse stream ended without messageStop."));
        }
        if (!finishEmitted) {
          yield finishEvent();
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
      const response = await withResponseRetry(
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
        { ...input, abortSignal: signal },
        "Bedrock"
      );
      if (!response.ok) {
        const body = await readErrorBodyWithLimit(response);
        throw new ProviderHTTPError(`Bedrock OpenAI-compatible request failed with status ${response.status}.`, response.status, {
          responseBody: body
        });
      }
      const json = await readJsonWithLimit<any>(response, {
        maxBytes: 128 * 1024 * 1024,
        provider: "bedrock",
        endpoint: "responses"
      });
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
    const response = await withResponseRetry(
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
      { ...input, abortSignal: signal },
      "Bedrock"
    ).catch((error) => { cleanup(); throw error; });

    return (async function* () {
      try {
        let providerEffectsPossible = false;
        const pendingCalls: Array<{ call_id?: string; id?: string; name: string; arguments?: string }> = [];
        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            break;
          }
          const json = JSON.parse(event.data);
          if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
            yield { type: "text-delta", textDelta: json.delta } satisfies StreamEvent;
          }
          if (json.type === "response.output_item.done" && json.item?.type === "function_call") {
            pendingCalls.push(json.item);
          }
          if (
            json.type === "response.output_item.done" &&
            json.item?.type &&
            !["message", "function_call", "function_call_output"].includes(json.item.type)
          ) {
            providerEffectsPossible = true;
            yield {
              type: "provider-data",
              provider: "bedrock",
              data: json.item as JsonValue
            } satisfies StreamEvent;
          }
          if (["response.completed", "response.failed", "response.incomplete"].includes(json.type)) {
            const status = json.type.slice("response.".length);
            const calls = status === "completed" ? pendingCalls.map(item => {
              const id = item.call_id ?? item.id;
              if (!id || !item.name) throw new ConfigurationError("Incomplete Bedrock function call.");
              return { id, name: item.name, input: JSON.parse(item.arguments ?? "{}") };
            }) : [];
            for (const toolCall of calls) yield { type: "tool-call", toolCall } satisfies StreamEvent;
            yield {
              type: "finish",
              finishReason: normalizeOpenAICompatibleFinishReason(status, calls.length > 0),
              providerFinishReason: status,
              usage: json.response?.usage ? {
                inputTokens: json.response.usage.input_tokens,
                outputTokens: json.response.usage.output_tokens,
                totalTokens: json.response.usage.total_tokens
              } : undefined
            } satisfies StreamEvent;
            if (status === "failed") throw new ProviderToolCallError({
              provider: "bedrock", transport: "responses", diagnosticCode: "BEDROCK_RESPONSE_FAILED",
              reason: "response_failed", retryable: false,
              // Hosted output items may already represent provider-side effects.
              effectsPossible: providerEffectsPossible,
              usage: json.response?.usage ? {
                inputTokens: json.response.usage.input_tokens,
                outputTokens: json.response.usage.output_tokens,
                totalTokens: json.response.usage.total_tokens
              } : undefined
            });
            return;
          }
          if (json.type === "error") throw new ConfigurationError("Bedrock reported a response stream error.");
        }
        throw new ConfigurationError("Bedrock response stream ended without a terminal event.");
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
    const customHeaders = Object.fromEntries(
      Object.entries(this.options.headers ?? {}).filter(
        ([key]) => !["authorization", "content-type", "content-length", "host", "connection", "transfer-encoding"].includes(key.toLowerCase())
      )
    );
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...customHeaders,
      ...(this.options.authorization || this.options.bearerToken
        ? { Authorization: this.options.authorization ?? `Bearer ${this.options.bearerToken}` }
        : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {})
    };
  }

  private async request<T>(
    method: "tools/list" | "tools/call",
    params?: Record<string, JsonValue>,
    abortSignal?: AbortSignal
  ): Promise<T> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      redirect: "error",
      headers: this.headers(),
      signal: abortSignal,
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

  async listTools(
    input?: McpListToolsRequest,
    options?: McpCallToolOptions
  ): Promise<McpListToolsResponse | McpListedTool[]> {
    return this.request<McpListToolsResponse>(
      "tools/list",
      input?.cursor === undefined ? undefined : { cursor: input.cursor },
      options?.abortSignal
    );
  }

  async callTool(
    input: McpCallToolRequest,
    options?: McpCallToolOptions
  ): Promise<JsonValue | McpCallToolResponse> {
    return this.request<McpCallToolResponse>("tools/call", {
      name: input.name,
      arguments: input.arguments ?? {}
    }, options?.abortSignal);
  }
}

export const createBedrock = (
  options: BedrockProviderOptions = {}
): CallableProviderAdapter<
  LanguageModel<BedrockLanguageModelOptions | BedrockOpenAICompatibleLanguageModelOptions>
> => {
  if (options.runtime === "openai") {
    const apiKey = options.apiKey ?? process.env.BEDROCK_API_KEY ?? process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (!apiKey) {
      throw new ConfigurationError("Missing Bedrock OpenAI-compatible API key.");
    }
    const configuredBaseURL = options.baseURL ?? process.env.BEDROCK_OPENAI_BASE_URL;
    if (!configuredBaseURL) {
      throw new ConfigurationError("Missing Bedrock OpenAI-compatible base URL.");
    }
    const baseURL = assertTrustedEndpoint(configuredBaseURL, {
      label: "Bedrock OpenAI-compatible baseURL",
      protocols: ["https"],
      allowUnsafe: options.allowUnsafeEndpoints
    }).toString().replace(/\/+$/, "");
    const fetcher = options.fetch ?? globalThis.fetch;
    return createProviderAdapter({
      name: "bedrock",
      languageModel: (modelId) => new BedrockOpenAICompatibleLanguageModel(modelId, apiKey, baseURL, fetcher)
    });
  }

  const client =
    options.client ??
    (() => {
      const config: BedrockRuntimeClientConfig = {
        maxAttempts: options.maxAttempts ?? 1
      };
      if (options.region) {
        config.region = options.region;
      }
      if (options.profile) {
        config.profile = options.profile;
      }
      if (options.credentials) {
        config.credentials = options.credentials;
      }
      if (options.apiKey) {
        config.token = { token: options.apiKey };
      }
      try {
        return new BedrockRuntimeClient(config);
      } catch (error) {
        throw new ConfigurationError("Failed to create the Bedrock runtime client.", { cause: error });
      }
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
