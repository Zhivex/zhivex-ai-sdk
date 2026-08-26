import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ParseError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  ValidationError,
  assertTrustedEndpoint,
  createProviderAdapter,
  isCallableToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  serializeJsonValue,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type GenerateResult,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type StreamEvent
} from "@zhivex-ai/core";

export const ZAI_GENERAL_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

export type ZAIEndpoint = "general" | "coding";
export type ZAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ZAIProviderOptions {
  apiKey?: string;
  /** Overrides the selected official endpoint. */
  baseURL?: string;
  /** Selects the general pay-as-you-go API (default) or the Coding Plan endpoint. */
  endpoint?: ZAIEndpoint;
  fetch?: typeof globalThis.fetch;
  allowUnsafeEndpoints?: boolean;
}

export interface ZAILanguageModelOptions {
  thinking?: {
    type: "enabled" | "disabled";
    /** Preserve reasoning across tool turns when false. */
    clear_thinking?: boolean;
  };
  reasoning_effort?: ZAIReasoningEffort;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  response_format?: { type: "text" | "json_object" };
  stop?: string[];
  tool_stream?: boolean;
  tool_choice?: "auto";
  do_sample?: boolean;
  request_id?: string;
  user_id?: string;
  [key: string]: unknown;
}

const baseCapabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  contextCaching: true,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-b",
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

const isGLM53 = (modelId: string) => modelId.toLowerCase() === "glm-5.3";
const isGLM53Flash = (modelId: string) => modelId.toLowerCase() === "glm-5.3-flash";
const isGLM53Family = (modelId: string) => isGLM53(modelId) || isGLM53Flash(modelId);
const isGLM52 = (modelId: string) => modelId.toLowerCase() === "glm-5.2";

const capabilitiesForModel = (modelId: string): ModelCapabilities => ({
  ...baseCapabilities,
  vision: isGLM53Flash(modelId),
  reasoning: isGLM53Family(modelId) || isGLM52(modelId),
  reasoningEfforts: isGLM53Family(modelId)
    ? ["low", "high", "max"]
    : isGLM52(modelId)
      ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
      : undefined
});

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const textContentFromMessage = (message: ModelMessage) =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

type ZAIMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

const toZAIImageURL = (image: string, mediaType: string | undefined) => {
  const normalizedImage = image.trim();
  if (!normalizedImage) {
    throw new ValidationError("Z.ai image input must not be empty.");
  }
  if (mediaType !== undefined && !mediaType.toLowerCase().startsWith("image/")) {
    throw new ValidationError('Z.ai ImagePart "mediaType" must use an image/* MIME type.');
  }
  if (/^https?:\/\//i.test(normalizedImage)) {
    return normalizedImage;
  }
  if (/^data:/i.test(normalizedImage)) {
    if (!/^data:image\//i.test(normalizedImage)) {
      throw new ValidationError("Z.ai image Data URLs must use an image/* MIME type.");
    }
    return normalizedImage;
  }
  return `data:${mediaType ?? "image/png"};base64,${normalizedImage}`;
};

const mapContentParts = (modelId: string, message: ModelMessage): string | ZAIMessageContentPart[] => {
  const unsupportedMedia = message.parts.find((part) => part.type === "audio" || part.type === "file");
  if (unsupportedMedia) {
    throw new UnsupportedFeatureError(`Z.ai model "${modelId}" does not support ${unsupportedMedia.type} input.`);
  }

  const hasImages = message.parts.some((part) => part.type === "image");
  if (!hasImages) {
    return textContentFromMessage(message);
  }
  if (!isGLM53Flash(modelId)) {
    throw new UnsupportedFeatureError(`Z.ai model "${modelId}" does not support image input.`);
  }

  return message.parts.flatMap<ZAIMessageContentPart>((part) => {
    if (part.type === "text") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "image") {
      return [
        {
          type: "image_url",
          image_url: { url: toZAIImageURL(part.image, part.mediaType) }
        }
      ];
    }
    return [];
  });
};

const reasoningContentFromMessage = (message: ModelMessage) =>
  message.parts
    .filter((part) => {
      if (part.type !== "provider-data" || part.provider !== "zai" || !isJsonObject(part.data)) {
        return false;
      }
      return part.data.type === "reasoning_content" && typeof part.data.reasoningContent === "string";
    })
    .map((part) =>
      part.type === "provider-data" && isJsonObject(part.data) ? String(part.data.reasoningContent) : ""
    )
    .join("");

const hasReasoningHistory = (messages: ModelMessage[]) =>
  messages.some((message) => reasoningContentFromMessage(message).length > 0);

const parseToolArguments = (value: unknown): Record<string, JsonValue> => {
  let parsed: unknown = value ?? {};
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch (error) {
      throw new ParseError("Z.ai tool call arguments contained invalid JSON.", { cause: error });
    }
  }
  if (!isJsonObject(parsed)) {
    throw new ValidationError("Z.ai tool call arguments must be a JSON object.");
  }
  try {
    return serializeJsonValue(parsed) as Record<string, JsonValue>;
  } catch (error) {
    throw new ValidationError("Z.ai tool call arguments must be JSON-compatible.", { cause: error });
  }
};

const mergeStreamFragment = (current: string, fragment: unknown) => {
  if (typeof fragment !== "string" || !fragment) {
    return current;
  }
  if (!current || fragment.startsWith(current)) {
    return fragment;
  }
  if (fragment === current || current.endsWith(fragment)) {
    return current;
  }
  return current + fragment;
};

const mapMessages = (modelId: string, messages: ModelMessage[]) =>
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
      content: mapContentParts(modelId, message)
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

const ensureJsonOutputInstruction = (
  messages: ModelMessage[],
  responseFormat: ZAILanguageModelOptions["response_format"] | undefined,
  structuredOutput: ModelGenerateInput["structuredOutput"]
) => {
  if (responseFormat?.type !== "json_object") {
    return messages;
  }
  const schema = structuredOutput?.mode === "native" ? JSON.stringify(toJSONSchema(structuredOutput.schema)) : undefined;
  if (!schema && messages.some((message) => /\bjson\b/i.test(textContentFromMessage(message)))) {
    return messages;
  }
  return [
    {
      role: "system",
      parts: [
        {
          type: "text",
          text: schema
            ? `Return only valid JSON matching this JSON Schema: ${schema}`
            : "Return only valid JSON."
        }
      ]
    } satisfies ModelMessage,
    ...messages
  ];
};

const mapTools = (tools: ModelGenerateInput["tools"]) => {
  if (!tools) {
    return undefined;
  }
  const definitions = Object.values(tools);
  if (definitions.length > 128) {
    throw new ValidationError("Z.ai accepts at most 128 function tools per request.");
  }
  const callableTools = definitions.filter(isCallableToolDefinition);
  if (callableTools.length !== definitions.length) {
    throw new UnsupportedFeatureError('Provider "zai" does not support hosted tools.');
  }
  return callableTools.map((tool) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) {
      throw new ValidationError(
        `Z.ai tool name "${tool.name}" must contain 1-64 letters, numbers, underscores, or hyphens.`
      );
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: toJSONSchema(tool.schema)
      }
    };
  });
};

const mapStructuredOutput = (input: ModelGenerateInput): ZAILanguageModelOptions["response_format"] | undefined =>
  input.structuredOutput?.mode === "native" ? { type: "json_object" } : undefined;

const unsupportedReasoningFields = (input: ModelGenerateInput) => {
  if (input.reasoning?.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "zai" does not support "reasoning.budgetTokens".');
  }
  if (input.reasoning?.mode !== undefined || input.reasoning?.context !== undefined) {
    throw new UnsupportedFeatureError('Provider "zai" does not support "reasoning.mode" or "reasoning.context".');
  }
};

interface MappedZAIReasoning {
  thinking: { type: "enabled" | "disabled"; clear_thinking?: boolean };
  reasoningEffort?: ZAIReasoningEffort;
}

const mapSharedReasoning = (modelId: string, input: ModelGenerateInput): MappedZAIReasoning | undefined => {
  const reasoning = input.reasoning;
  if (!reasoning) {
    return undefined;
  }
  unsupportedReasoningFields(input);
  const effort = reasoning.effort;
  if (isGLM53Family(modelId)) {
    if (reasoning.includeThoughts === false) {
      throw new UnsupportedFeatureError(
        'Provider "zai" cannot hide reasoning content while GLM-5.3 thinking is enabled.'
      );
    }
    if (effort !== undefined && effort !== "low" && effort !== "high" && effort !== "max") {
      throw new UnsupportedFeatureError(
        'Z.ai GLM-5.3 supports shared reasoning effort "low", "high", or "max" only.'
      );
    }
    return {
      thinking: { type: "enabled" as const },
      ...(effort ? { reasoningEffort: effort } : {})
    };
  }
  if (isGLM52(modelId)) {
    if (effort === "none" || effort === "minimal") {
      if (reasoning.includeThoughts) {
        throw new UnsupportedFeatureError(
          'Provider "zai" cannot include reasoning content while reasoning effort is disabled.'
        );
      }
      return { thinking: { type: "disabled" as const } };
    }
    if (reasoning.includeThoughts === false) {
      throw new UnsupportedFeatureError(
        'Provider "zai" cannot hide reasoning content while thinking mode is enabled.'
      );
    }
    const mappedEffort = effort === "xhigh" || effort === "max" ? "max" : effort ? "high" : undefined;
    return {
      thinking: { type: "enabled" as const },
      ...(mappedEffort ? { reasoningEffort: mappedEffort } : {})
    };
  }
  throw new UnsupportedFeatureError(`Provider "zai" model "${modelId}" has no documented shared reasoning contract.`);
};

const validateStringLength = (value: unknown, field: string, min: number, max: number) => {
  if (value !== undefined && (typeof value !== "string" || value.length < min || value.length > max)) {
    throw new ValidationError(`Z.ai "${field}" must contain ${min}-${max} characters.`);
  }
};

const validateProviderOptions = (modelId: string, input: ModelGenerateInput<ZAILanguageModelOptions>) => {
  const options = input.providerOptions;
  if (input.reasoning && (options?.thinking !== undefined || options?.reasoning_effort !== undefined)) {
    throw new ValidationError(
      'Do not combine shared "reasoning" with Z.ai "providerOptions.thinking" or "providerOptions.reasoning_effort".'
    );
  }
  if (
    options?.thinking !== undefined &&
    (!isJsonObject(options.thinking) ||
      (options.thinking.type !== "enabled" && options.thinking.type !== "disabled") ||
      (options.thinking.clear_thinking !== undefined && typeof options.thinking.clear_thinking !== "boolean"))
  ) {
    throw new ValidationError(
      'Z.ai "thinking" must include type "enabled" or "disabled" and optional boolean "clear_thinking".'
    );
  }
  const effort = options?.reasoning_effort;
  if (
    effort !== undefined &&
    !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)
  ) {
    throw new ValidationError(
      'Z.ai "reasoning_effort" must be "none", "minimal", "low", "medium", "high", "xhigh", or "max".'
    );
  }
  if (isGLM53Family(modelId)) {
    if (options?.thinking?.type === "disabled") {
      throw new UnsupportedFeatureError('Z.ai GLM-5.3 requires thinking.type "enabled".');
    }
    if (effort !== undefined && effort !== "low" && effort !== "high" && effort !== "max") {
      throw new UnsupportedFeatureError('Z.ai GLM-5.3 supports reasoning_effort "low", "high", or "max" only.');
    }
  }
  if (options?.thinking?.type === "disabled" && effort !== undefined) {
    throw new UnsupportedFeatureError('Z.ai does not accept "reasoning_effort" while thinking is disabled.');
  }
  const temperature = input.temperature ?? options?.temperature;
  if (
    temperature !== undefined &&
    (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 1)
  ) {
    throw new ValidationError('Z.ai "temperature" must be between 0 and 1.');
  }
  if (
    options?.top_p !== undefined &&
    (typeof options.top_p !== "number" || !Number.isFinite(options.top_p) || options.top_p < 0.01 || options.top_p > 1)
  ) {
    throw new ValidationError('Z.ai "top_p" must be between 0.01 and 1.');
  }
  const maxTokens = input.maxTokens ?? options?.max_tokens;
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > 131_072)) {
    throw new ValidationError('Z.ai "max_tokens" must be a positive safe integer no greater than 131072.');
  }
  if (
    options?.stop !== undefined &&
    (!Array.isArray(options.stop) || options.stop.length > 4 || options.stop.some((value) => typeof value !== "string"))
  ) {
    throw new ValidationError('Z.ai "stop" must be an array of at most 4 strings.');
  }
  if (options?.tool_stream !== undefined && typeof options.tool_stream !== "boolean") {
    throw new ValidationError('Z.ai "tool_stream" must be a boolean.');
  }
  if (options?.tool_choice !== undefined && options.tool_choice !== "auto") {
    throw new UnsupportedFeatureError('Z.ai supports tool_choice "auto" only.');
  }
  if (
    options?.response_format !== undefined &&
    (!isJsonObject(options.response_format) ||
      (options.response_format.type !== "text" && options.response_format.type !== "json_object"))
  ) {
    throw new ValidationError('Z.ai "response_format.type" must be "text" or "json_object".');
  }
  if (options?.do_sample !== undefined && typeof options.do_sample !== "boolean") {
    throw new ValidationError('Z.ai "do_sample" must be a boolean.');
  }
  validateStringLength(options?.request_id, "request_id", 6, 64);
  validateStringLength(options?.user_id, "user_id", 6, 128);
};

const mapProviderOptions = (providerOptions: ZAILanguageModelOptions | undefined) => {
  const {
    thinking: _thinking,
    reasoning_effort: _reasoningEffort,
    temperature: _temperature,
    max_tokens: _maxTokens,
    response_format: _responseFormat,
    tool_stream: _toolStream,
    tool_choice: _toolChoice,
    model: _model,
    messages: _messages,
    tools: _tools,
    stream: _stream,
    ...rest
  } = providerOptions ?? {};
  return rest;
};

const resolveRequestOptions = (modelId: string, input: ModelGenerateInput<ZAILanguageModelOptions>) => {
  validateProviderOptions(modelId, input);
  const providerOptions = input.providerOptions;
  const sharedReasoning = mapSharedReasoning(modelId, input);
  let thinking = sharedReasoning?.thinking ?? providerOptions?.thinking;
  const reasoningHistory = hasReasoningHistory(input.messages);
  if (isGLM53Family(modelId) && !thinking) {
    thinking = { type: "enabled" };
  }
  if (isGLM53Flash(modelId) && thinking?.type === "enabled" && thinking.clear_thinking === undefined) {
    thinking = { ...thinking, clear_thinking: false };
  }
  const preserveThinking = reasoningHistory || Boolean(input.tools && Object.keys(input.tools).length);
  const rawThinkingDisabled =
    isGLM52(modelId) &&
    !sharedReasoning &&
    (providerOptions?.reasoning_effort === "none" || providerOptions?.reasoning_effort === "minimal");
  if (
    preserveThinking &&
    !rawThinkingDisabled &&
    (thinking?.type === "enabled" || (!thinking && (isGLM53Family(modelId) || isGLM52(modelId))))
  ) {
    thinking = { ...(thinking ?? { type: "enabled" as const }), clear_thinking: false };
  }
  return {
    bodyOptions: mapProviderOptions(providerOptions),
    thinking,
    reasoningEffort: sharedReasoning?.reasoningEffort ?? providerOptions?.reasoning_effort,
    temperature: input.temperature ?? providerOptions?.temperature,
    maxTokens: input.maxTokens ?? providerOptions?.max_tokens,
    responseFormat: mapStructuredOutput(input) ?? providerOptions?.response_format,
    toolStream: providerOptions?.tool_stream,
    toolChoice: providerOptions?.tool_choice
  };
};

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

const parseRetryAfterMs = (value: string | null) => {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 60_000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.min(Math.max(date - Date.now(), 0), 60_000);
};

const errorStatusFromCode = (code: unknown) => {
  const numericCode = Number(code);
  if (Number.isInteger(numericCode) && numericCode >= 400 && numericCode <= 599) {
    return numericCode;
  }
  switch (numericCode) {
    case 1000:
    case 1001:
    case 1003:
    case 1005:
      return 401;
    case 1210:
    case 1211:
    case 1212:
    case 1213:
    case 1214:
    case 1215:
    case 1221:
    case 1222:
    case 1261:
    case 1301:
      return 400;
    case 1220:
      return 403;
    case 1113:
    case 1302:
    case 1305:
    case 1308:
    case 1309:
    case 1310:
    case 1311:
    case 1313:
    case 1314:
    case 1315:
    case 1316:
    case 1317:
    case 1318:
    case 1319:
    case 1320:
    case 1321:
      return 429;
    case 1200:
    case 1230:
    case 1234:
      return 500;
    default:
      return 500;
  }
};

const providerErrorFromPayload = (
  payload: Record<string, unknown>,
  fallbackStatus = 0,
  retryAfterMs?: number
) => {
  const error = isJsonObject(payload.error) ? payload.error : undefined;
  const code = error?.code ?? payload.code;
  const message = error?.message ?? payload.message;
  const status = fallbackStatus >= 400 && fallbackStatus <= 599 ? fallbackStatus : errorStatusFromCode(code);
  return new ProviderHTTPError(
    typeof message === "string" && message ? `Z.ai request failed: ${message}` : "Z.ai request failed.",
    status,
    { responseBody: JSON.stringify(payload), retryAfterMs }
  );
};

const assertNoErrorPayload = (payload: unknown) => {
  if (!isJsonObject(payload)) {
    throw new ParseError("Z.ai returned a non-object response payload.");
  }
  if (payload.error !== undefined || (payload.code !== undefined && !Array.isArray(payload.choices))) {
    throw providerErrorFromPayload(payload);
  }
  return payload;
};

const assertResponseOk = async (response: Response) => {
  if (!response.ok) {
    const body = await readErrorBodyWithLimit(response);
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    let payload: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(body) as unknown;
      payload = isJsonObject(parsed) ? parsed : undefined;
    } catch {
      // Preserve the bounded raw body below.
    }
    if (payload) {
      throw providerErrorFromPayload(payload, response.status, retryAfterMs);
    }
    throw new ProviderHTTPError(`Z.ai request failed with status ${response.status}.`, response.status, {
      responseBody: body,
      retryAfterMs
    });
  }
};

const parseJson = async (response: Response) => {
  await assertResponseOk(response);
  const json = await readJsonWithLimit<unknown>(response, {
    maxBytes: 128 * 1024 * 1024,
    provider: "zai",
    endpoint: response.url || undefined
  });
  return assertNoErrorPayload(json);
};

const mapUsage = (usage: any) =>
  usage
    ? {
        inputTokens: usage.prompt_tokens,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
        outputTokens: usage.completion_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        totalTokens: usage.total_tokens
      }
    : undefined;

const normalizeZAIFinishReason = (finishReason: string | undefined) => {
  switch (finishReason) {
    case "sensitive":
      return "content-filter" as const;
    case "model_context_window_exceeded":
      return "length" as const;
    case "network_error":
      return "error" as const;
    default:
      return normalizeFinishReason(finishReason);
  }
};

const parseAssistantMessage = (message: unknown): ModelMessage => {
  if (!isJsonObject(message)) {
    throw new ParseError("Z.ai response did not contain an assistant message object.");
  }
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    throw new ParseError("Z.ai assistant tool_calls must be an array.");
  }
  const toolCalls = (message.tool_calls ?? []).map((call) => {
    if (!isJsonObject(call) || !isJsonObject(call.function)) {
      throw new ParseError("Z.ai returned a malformed tool call.");
    }
    if (typeof call.id !== "string" || !call.id || typeof call.function.name !== "string" || !call.function.name) {
      throw new ParseError("Z.ai tool calls require non-empty string id and function name fields.");
    }
    return {
      type: "tool-call" as const,
      toolCall: {
        id: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments)
      }
    };
  });
  return {
    role: "assistant",
    parts: [
      ...(typeof message.reasoning_content === "string" && message.reasoning_content
        ? [providerDataPart("zai", { type: "reasoning_content", reasoningContent: message.reasoning_content })]
        : []),
      ...(typeof message.content === "string" && message.content
        ? [{ type: "text", text: message.content } as const]
        : []),
      ...toolCalls
    ]
  };
};

class ZAILanguageModel implements LanguageModel<ZAILanguageModelOptions> {
  readonly provider = "zai";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {
    this.capabilities = capabilitiesForModel(modelId);
  }

  async generate(input: ModelGenerateInput<ZAILanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const options = resolveRequestOptions(this.modelId, input);
      const tools = mapTools(input.tools);
      const json = await withRetry(async () => {
        const response = await this.fetcher(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify({
            ...options.bodyOptions,
            model: this.modelId,
            messages: mapMessages(
              this.modelId,
              ensureJsonOutputInstruction(input.messages, options.responseFormat, input.structuredOutput)
            ),
            tools,
            tool_choice: tools?.length ? options.toolChoice ?? "auto" : options.toolChoice,
            response_format: options.responseFormat,
            temperature: options.temperature,
            max_tokens: options.maxTokens,
            stream: false,
            ...(options.thinking ? { thinking: options.thinking } : {}),
            ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {})
          })
        });
        return parseJson(response);
      }, { ...input, abortSignal: signal });

      const choices = (json as any).choices;
      if (!Array.isArray(choices) || !choices.length || !isJsonObject(choices[0])) {
        throw new ParseError("Z.ai response did not contain a completion choice.");
      }
      const choice = choices[0];
      const message = parseAssistantMessage(choice.message);
      const providerFinishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
      return {
        messages: [message],
        text: message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
        finishReason: normalizeZAIFinishReason(providerFinishReason),
        providerFinishReason,
        usage: mapUsage((json as any).usage),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput<ZAILanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    let response: Response;
    try {
      const options = resolveRequestOptions(this.modelId, input);
      const tools = mapTools(input.tools);
      response = await withRetry(async () => {
        const result = await this.fetcher(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: jsonHeaders(this.apiKey),
          signal,
          body: JSON.stringify({
            ...options.bodyOptions,
            model: this.modelId,
            messages: mapMessages(
              this.modelId,
              ensureJsonOutputInstruction(input.messages, options.responseFormat, input.structuredOutput)
            ),
            tools,
            tool_choice: tools?.length ? options.toolChoice ?? "auto" : options.toolChoice,
            response_format: options.responseFormat,
            temperature: options.temperature,
            max_tokens: options.maxTokens,
            stream: true,
            tool_stream: tools?.length ? options.toolStream ?? true : options.toolStream,
            ...(options.thinking ? { thinking: options.thinking } : {}),
            ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {})
          })
        });
        await assertResponseOk(result);
        return result;
      }, { ...input, abortSignal: signal });
    } catch (error) {
      cleanup();
      throw error;
    }

    return (async function* (): AsyncGenerator<StreamEvent> {
      try {
        const toolBuffers = new Map<number, { id: string; name: string; args: string }>();
        let lastFinishReason: string | undefined;
        let lastUsage: any;

        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            break;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data) as unknown;
          } catch (error) {
            throw new ParseError("Z.ai streaming response contained invalid JSON.", { cause: error });
          }
          const json = assertNoErrorPayload(parsed) as any;
          const choice = json.choices?.[0];
          const delta = choice?.delta;
          const usage = json.usage ?? choice?.usage;
          if (usage) {
            lastUsage = usage;
          }
          if (delta?.reasoning_content) {
            yield {
              type: "provider-data",
              provider: "zai",
              data: { type: "reasoning_content", reasoningContent: delta.reasoning_content }
            } satisfies StreamEvent;
          }
          if (delta?.content) {
            yield { type: "text-delta", textDelta: delta.content } satisfies StreamEvent;
          }
          if (delta?.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
            throw new ParseError("Z.ai streaming tool_calls must be an array.");
          }
          for (const toolCall of delta?.tool_calls ?? []) {
            if (!isJsonObject(toolCall)) {
              throw new ParseError("Z.ai returned a malformed streaming tool call.");
            }
            if (!Number.isSafeInteger(toolCall.index) || (toolCall.index as number) < 0) {
              throw new ParseError("Z.ai streaming tool calls require a non-negative integer index.");
            }
            const index = toolCall.index as number;
            const existing = toolBuffers.get(index) ?? { id: "", name: "", args: "" };
            existing.id = mergeStreamFragment(existing.id, toolCall.id);
            const toolFunction = isJsonObject(toolCall.function) ? toolCall.function : undefined;
            existing.name = mergeStreamFragment(existing.name, toolFunction?.name);
            existing.args += typeof toolFunction?.arguments === "string" ? toolFunction.arguments : "";
            toolBuffers.set(index, existing);
          }
          if (choice?.finish_reason === "tool_calls") {
            for (const [index, toolCall] of [...toolBuffers.entries()].sort(([left], [right]) => left - right)) {
              if (!toolCall.id || !toolCall.name) {
                throw new ParseError("Z.ai fragmented tool calls require non-empty id and function name fields.");
              }
              yield {
                type: "tool-call",
                toolCall: {
                  id: toolCall.id,
                  name: toolCall.name,
                  input: parseToolArguments(toolCall.args)
                }
              } satisfies StreamEvent;
            }
            toolBuffers.clear();
          }
          if (choice?.finish_reason) {
            lastFinishReason = choice.finish_reason;
          }
        }

        if (toolBuffers.size) {
          throw new ParseError("Z.ai streaming response ended before fragmented tool calls were completed.");
        }
        if (!lastFinishReason) {
          throw new ParseError("Z.ai streaming response ended without a finish reason.");
        }
        yield {
          type: "finish",
          finishReason: normalizeZAIFinishReason(lastFinishReason),
          providerFinishReason: lastFinishReason,
          usage: mapUsage(lastUsage)
        } satisfies StreamEvent;
      } finally {
        cleanup();
      }
    })();
  }
}

export const createZAI = (
  options: ZAIProviderOptions = {}
): CallableProviderAdapter<LanguageModel<ZAILanguageModelOptions>> & {
  rawFetch: typeof globalThis.fetch;
  endpoint: ZAIEndpoint;
} => {
  const apiKey = options.apiKey ?? process.env.ZAI_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Z.ai API key.");
  }
  const endpoint = options.endpoint ?? "general";
  const selectedBaseURL = endpoint === "coding" ? ZAI_CODING_BASE_URL : ZAI_GENERAL_BASE_URL;
  const baseURL = assertTrustedEndpoint(options.baseURL ?? process.env.ZAI_BASE_URL ?? selectedBaseURL, {
    label: "Z.ai baseURL",
    protocols: ["https"],
    allowUnsafe: options.allowUnsafeEndpoints
  }).toString().replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  return createProviderAdapter({
    name: "zai",
    endpoint,
    languageModel: (modelId) => new ZAILanguageModel(modelId, apiKey, baseURL, fetcher),
    rawFetch: fetcher
  });
};

/** Conventional camel-case alias for consumers that do not use acronym casing. */
export const createZai = createZAI;
