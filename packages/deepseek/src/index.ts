import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  ValidationError,
  createProviderAdapter,
  isCallableToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type GenerateResult,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent
} from "@zhivex-ai/core";

import { createDeepSeekClients, type DeepSeekClients } from "./clients.js";

export * from "./clients.js";

export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseURL?: string;
  /** Base URL for DeepSeek beta APIs. Defaults to `<baseURL>/beta`. */
  betaBaseURL?: string;
  fetch?: typeof globalThis.fetch;
}

export interface DeepSeekPrefixOptions {
  /** Assistant text that DeepSeek should continue. */
  content: string;
  /** Optional reasoning prefix used by thinking-mode prefix completion. */
  reasoningContent?: string;
}

export interface DeepSeekLanguageModelOptions {
  thinking?: {
    type: "enabled" | "disabled";
  };
  reasoning_effort?: "high" | "max";
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  response_format?: { type: "text" | "json_object" };
  stop?: string | string[];
  user_id?: string;
  logprobs?: boolean;
  top_logprobs?: number;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  /** Enables DeepSeek's strict tool schema mode and routes this request through the beta API. */
  strictTools?: boolean;
  /** Appends an assistant prefix and routes this request through the beta API. */
  prefix?: DeepSeekPrefixOptions;
  [key: string]: unknown;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: true,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  contextCaching: true,
  reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
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

const reasoningContentFromMessage = (message: ModelMessage) =>
  message.parts
    .filter((part) => {
      if (part.type !== "provider-data" || part.provider !== "deepseek") {
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

const assertResponseOk = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`DeepSeek request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
};

const parseJson = async (response: Response) => {
  await assertResponseOk(response);
  return response.json();
};

const mapContentParts = (message: ModelMessage) => {
  const textParts = message.parts.filter((part) => part.type === "text");
  return textParts.map((part) => part.text).join("");
};

const mapMessages = (messages: ModelMessage[], prefix?: DeepSeekPrefixOptions) => {
  const mapped = messages.map((message) => {
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

  if (prefix) {
    mapped.push({
      role: "assistant",
      content: prefix.content,
      prefix: true,
      ...(prefix.reasoningContent !== undefined ? { reasoning_content: prefix.reasoningContent } : {})
    });
  }

  return mapped;
};

const mapTools = (tools: ModelGenerateInput["tools"], strict: boolean) =>
  tools
    ? (() => {
        const toolDefinitions = Object.values(tools);
        const callableTools = toolDefinitions.filter(isCallableToolDefinition);
        if (callableTools.length !== toolDefinitions.length) {
          throw new UnsupportedFeatureError('Provider "deepseek" does not support hosted tools.');
        }

        return callableTools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema),
            ...(strict ? { strict: true } : {})
          }
        }));
      })()
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
    type: "json_object"
  };
};

const mapReasoningEffort = (effort: NonNullable<ModelGenerateInput["reasoning"]>["effort"]) => {
  if (effort === "xhigh" || effort === "max") {
    return "max";
  }

  if (!effort || effort === "none") {
    return undefined;
  }

  return "high";
};

const mapReasoning = (input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  if (input.reasoning.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "deepseek" does not support "reasoning.budgetTokens".');
  }
  if (input.reasoning.mode !== undefined || input.reasoning.context !== undefined) {
    throw new UnsupportedFeatureError(
      'Provider "deepseek" does not support "reasoning.mode" or "reasoning.context".'
    );
  }
  if (input.reasoning.effort === "minimal") {
    throw new UnsupportedFeatureError('Provider "deepseek" does not support reasoning effort "minimal".');
  }
  if (input.reasoning.effort === "none" && input.reasoning.includeThoughts) {
    throw new UnsupportedFeatureError(
      'Provider "deepseek" cannot include reasoning content while reasoning effort is "none".'
    );
  }

  const thinking = input.reasoning.effort === "none" ? { type: "disabled" as const } : { type: "enabled" as const };
  const reasoningEffort = mapReasoningEffort(input.reasoning.effort);

  return {
    thinking,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
  };
};

const isBetaBaseURL = (baseURL: string) => {
  try {
    return new URL(baseURL).pathname.split("/").includes("beta");
  } catch {
    return /(?:^|\/)beta(?:\/|$)/.test(baseURL);
  }
};

const validateProviderOptions = (input: ModelGenerateInput<DeepSeekLanguageModelOptions>) => {
  const providerOptions = input.providerOptions;
  const rawOptions = (providerOptions ?? {}) as Record<string, unknown>;

  if (rawOptions.frequency_penalty !== undefined || rawOptions.presence_penalty !== undefined) {
    throw new UnsupportedFeatureError(
      'Provider "deepseek" no longer supports "frequency_penalty" or "presence_penalty".'
    );
  }
  if (rawOptions.user !== undefined) {
    throw new UnsupportedFeatureError('Provider "deepseek" uses "user_id" instead of "user".');
  }
  if (
    providerOptions?.user_id !== undefined &&
    (typeof providerOptions.user_id !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(providerOptions.user_id))
  ) {
    throw new ValidationError(
      'DeepSeek "user_id" must contain 1-512 characters using only letters, numbers, hyphens, or underscores.'
    );
  }
  if (
    providerOptions?.thinking !== undefined &&
    (providerOptions.thinking === null ||
      typeof providerOptions.thinking !== "object" ||
      Array.isArray(providerOptions.thinking) ||
      (providerOptions.thinking.type !== "enabled" && providerOptions.thinking.type !== "disabled"))
  ) {
    throw new ValidationError('DeepSeek "thinking.type" must be "enabled" or "disabled".');
  }
  if (
    providerOptions?.reasoning_effort !== undefined &&
    providerOptions.reasoning_effort !== "high" &&
    providerOptions.reasoning_effort !== "max"
  ) {
    throw new ValidationError('DeepSeek "reasoning_effort" must be "high" or "max".');
  }
  if (
    providerOptions?.top_logprobs !== undefined &&
    (!Number.isInteger(providerOptions.top_logprobs) ||
      providerOptions.top_logprobs < 0 ||
      providerOptions.top_logprobs > 20)
  ) {
    throw new ValidationError('DeepSeek "top_logprobs" must be an integer between 0 and 20.');
  }
  if (providerOptions?.top_logprobs !== undefined && providerOptions.logprobs !== true) {
    throw new ValidationError('DeepSeek "top_logprobs" requires "logprobs: true".');
  }
  if (
    providerOptions?.prefix !== undefined &&
    (providerOptions.prefix === null ||
      typeof providerOptions.prefix !== "object" ||
      Array.isArray(providerOptions.prefix) ||
      typeof providerOptions.prefix.content !== "string" ||
      (providerOptions.prefix.reasoningContent !== undefined &&
        typeof providerOptions.prefix.reasoningContent !== "string"))
  ) {
    throw new ValidationError(
      'DeepSeek "prefix" must include a string "content" and an optional string "reasoningContent".'
    );
  }
  if (
    providerOptions?.prefix !== undefined &&
    providerOptions.prefix.content.length === 0 &&
    !providerOptions.prefix.reasoningContent
  ) {
    throw new ValidationError('DeepSeek "prefix" requires non-empty "content" or "reasoningContent".');
  }

  const mappedReasoning = mapReasoning(input);
  const thinking = mappedReasoning?.thinking ?? providerOptions?.thinking ?? { type: "enabled" as const };
  const reasoningEffort = mappedReasoning ? mappedReasoning.reasoning_effort : providerOptions?.reasoning_effort;
  if (thinking.type === "enabled" && (input.temperature !== undefined || providerOptions?.temperature !== undefined)) {
    throw new UnsupportedFeatureError(
      'Provider "deepseek" does not support "temperature" while thinking mode is enabled.'
    );
  }
  if (thinking.type === "enabled" && providerOptions?.top_p !== undefined) {
    throw new UnsupportedFeatureError('Provider "deepseek" does not support "top_p" while thinking mode is enabled.');
  }
  if (thinking.type === "disabled" && reasoningEffort !== undefined) {
    throw new UnsupportedFeatureError(
      'Provider "deepseek" does not support "reasoning_effort" while thinking mode is disabled.'
    );
  }
};

const mapProviderOptions = (providerOptions: DeepSeekLanguageModelOptions | undefined) => {
  const {
    strictTools: _strictTools,
    prefix: _prefix,
    thinking: _thinking,
    reasoning_effort: _reasoningEffort,
    temperature: _temperature,
    max_tokens: _maxTokens,
    response_format: _responseFormat,
    tool_choice: _toolChoice,
    model: _model,
    messages: _messages,
    tools: _tools,
    stream: _stream,
    stream_options: _streamOptions,
    ...rest
  } = providerOptions ?? {};

  return rest;
};

const resolveRequestOptions = (
  baseURL: string,
  betaBaseURL: string,
  input: ModelGenerateInput<DeepSeekLanguageModelOptions>
) => {
  validateProviderOptions(input);
  const providerOptions = input.providerOptions;
  const reasoning = mapReasoning(input);
  const thinking = reasoning?.thinking ?? providerOptions?.thinking;
  const effectiveThinking = thinking?.type ?? "enabled";
  const requestedToolChoice = input.toolChoice !== undefined ? mapToolChoice(input.toolChoice) : providerOptions?.tool_choice;
  if (
    effectiveThinking === "enabled" &&
    input.tools &&
    Object.keys(input.tools).length > 0 &&
    requestedToolChoice !== undefined &&
    requestedToolChoice !== "auto"
  ) {
    throw new UnsupportedFeatureError(
      'Provider "deepseek" does not support explicit tool choice while thinking mode is enabled. Use "toolChoice=auto" or disable reasoning.'
    );
  }

  return {
    bodyOptions: mapProviderOptions(providerOptions),
    strictTools: providerOptions?.strictTools === true,
    prefix: providerOptions?.prefix,
    requestBaseURL: providerOptions?.strictTools || providerOptions?.prefix ? betaBaseURL : baseURL,
    thinking,
    reasoningEffort: reasoning ? reasoning.reasoning_effort : providerOptions?.reasoning_effort,
    temperature: input.temperature ?? providerOptions?.temperature,
    maxTokens: input.maxTokens ?? providerOptions?.max_tokens,
    responseFormat: mapStructuredOutput(input) ?? providerOptions?.response_format,
    toolChoice: effectiveThinking === "enabled" && requestedToolChoice === "auto" ? undefined : requestedToolChoice
  };
};

const mapUsage = (usage: any) =>
  usage
    ? {
        inputTokens: usage.prompt_tokens,
        cachedInputTokens: usage.prompt_cache_hit_tokens,
        outputTokens: usage.completion_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        totalTokens: usage.total_tokens
      }
    : undefined;

const normalizeDeepSeekFinishReason = (finishReason: string | undefined) =>
  finishReason === "insufficient_system_resource" ? ("error" as const) : normalizeFinishReason(finishReason);

const parseAssistantMessage = (message: any): ModelMessage => ({
  role: "assistant",
  parts: [
    ...(typeof message.reasoning_content === "string" && message.reasoning_content
      ? [providerDataPart("deepseek", { type: "reasoning_content", reasoningContent: message.reasoning_content })]
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

class DeepSeekLanguageModel implements LanguageModel<DeepSeekLanguageModelOptions> {
  readonly provider = "deepseek";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly betaBaseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generate(input: ModelGenerateInput<DeepSeekLanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const options = resolveRequestOptions(this.baseURL, this.betaBaseURL, input);
      const json = await withRetry(
        async () => {
          const response = await this.fetcher(`${options.requestBaseURL}/chat/completions`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...options.bodyOptions,
              model: this.modelId,
              messages: mapMessages(input.messages, options.prefix),
              tools: mapTools(input.tools, options.strictTools),
              tool_choice: options.toolChoice,
              response_format: options.responseFormat,
              temperature: options.temperature,
              max_tokens: options.maxTokens,
              stream: false,
              ...(options.thinking ? { thinking: options.thinking } : {}),
              ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {})
            })
          });
          return parseJson(response);
        },
        input
      );

      const choice = json.choices?.[0];
      const message = choice?.message ?? {};
      const assistantMessage = parseAssistantMessage(message);

      return {
        messages: [assistantMessage],
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        finishReason: normalizeDeepSeekFinishReason(choice?.finish_reason),
        providerFinishReason: choice?.finish_reason,
        usage: mapUsage(json.usage),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput<DeepSeekLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    let response: Response;

    try {
      const options = resolveRequestOptions(this.baseURL, this.betaBaseURL, input);
      response = await withRetry(
        async () => {
          const result = await this.fetcher(`${options.requestBaseURL}/chat/completions`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...options.bodyOptions,
              model: this.modelId,
              messages: mapMessages(input.messages, options.prefix),
              tools: mapTools(input.tools, options.strictTools),
              tool_choice: options.toolChoice,
              response_format: options.responseFormat,
              temperature: options.temperature,
              max_tokens: options.maxTokens,
              stream: true,
              stream_options: { include_usage: true },
              ...(options.thinking ? { thinking: options.thinking } : {}),
              ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {})
            })
          });
          await assertResponseOk(result);
          return result;
        },
        input
      );
    } catch (error) {
      cleanup();
      throw error;
    }

    return (async function* () {
      try {
        const toolBuffers = new Map<number, { id: string; name: string; args: string }>();
        let lastFinishReason: string | undefined;
        let lastUsage: any;
        let finishEmitted = false;

        for await (const event of streamSSE(response)) {
          if (event.data === "[DONE]") {
            break;
          }

          const json = JSON.parse(event.data);
          const choice = json.choices?.[0];
          const delta = choice?.delta;
          const usage = json.usage ?? choice?.usage;

          if (!choice && usage) {
            lastUsage = usage;
            if (lastFinishReason && !finishEmitted) {
              finishEmitted = true;
              yield {
                type: "finish",
                finishReason: normalizeDeepSeekFinishReason(lastFinishReason),
                providerFinishReason: lastFinishReason,
                usage: mapUsage(lastUsage)
              } satisfies StreamEvent;
            }
            continue;
          }

          if (delta?.reasoning_content) {
            yield {
              type: "provider-data",
              provider: "deepseek",
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
            const index = typeof toolCall.index === "number" ? toolCall.index : 0;
            const existing = toolBuffers.get(index) ?? { id: "", name: "", args: "" };
            existing.id ||= toolCall.id ?? "";
            existing.name ||= toolCall.function?.name ?? "";
            existing.args += toolCall.function?.arguments ?? "";
            toolBuffers.set(index, existing);
          }

          if (choice?.finish_reason === "tool_calls") {
            for (const [index, toolCall] of toolBuffers) {
              yield {
                type: "tool-call",
                toolCall: {
                  id: toolCall.id || `${index}`,
                  name: toolCall.name,
                  input: JSON.parse(toolCall.args || "{}")
                }
              } satisfies StreamEvent;
            }
            toolBuffers.clear();
          }

          if (choice?.finish_reason) {
            lastFinishReason = choice.finish_reason;
            lastUsage = usage ?? lastUsage;
          }
        }

        if (lastFinishReason && !finishEmitted) {
          yield {
            type: "finish",
            finishReason: normalizeDeepSeekFinishReason(lastFinishReason),
            providerFinishReason: lastFinishReason,
            usage: mapUsage(lastUsage)
          } satisfies StreamEvent;
        }
      } finally {
        cleanup();
      }
    })();
  }
}

export const createDeepSeek = (
  options: DeepSeekProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & DeepSeekClients & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing DeepSeek API key.");
  }

  const baseURL = (options.baseURL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const betaBaseURL = (
    options.betaBaseURL ?? (isBetaBaseURL(baseURL) ? baseURL : `${baseURL}/beta`)
  ).replace(/\/+$/, "");
  const stableClientBaseURL = baseURL.replace(/\/beta$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const clients = createDeepSeekClients({
    apiKey,
    baseURL: stableClientBaseURL,
    betaBaseURL,
    fetch: fetcher
  });

  return createProviderAdapter({
    name: "deepseek",
    languageModel: (modelId) => new DeepSeekLanguageModel(modelId, apiKey, baseURL, betaBaseURL, fetcher),
    ...clients,
    rawFetch: fetcher
  });
};
