import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ParseError,
  assertTrustedEndpoint,
  isLoopbackHostname,
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  ProviderHTTPError,
  isCallableToolDefinition,
  UnsupportedFeatureError,
  ValidationError,
  createProviderAdapter,
  normalizeFinishReason,
  providerDataPart,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  serializeJsonValue,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type GenerateResult,
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent
} from "@zhivex-ai/core";

export interface OllamaProviderOptions {
  baseURL?: string;
  apiKey?: string;
  headers?: HeadersInit;
  fetch?: typeof globalThis.fetch;
  allowUnsafeEndpoints?: boolean;
}

export interface OllamaLanguageModelOptions {
  format?: "json" | Record<string, unknown>;
  keep_alive?: string | number;
  think?: boolean | "low" | "medium" | "high" | "max";
  logprobs?: boolean;
  top_logprobs?: number;
  /** @deprecated Ollama exposes `raw` only on `/api/generate`; this adapter uses `/api/chat`. */
  raw?: boolean;
  /** @deprecated Ollama exposes `template` only on `/api/generate`; this adapter uses `/api/chat`. */
  template?: string;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: false,
  parallelToolCalls: true,
  vision: true,
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

const embeddingCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  parallelToolCalls: false,
  vision: false,
  embeddings: true
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseToolArguments = (value: unknown): Record<string, JsonValue> => {
  let parsed: unknown = value === undefined ? {} : value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch (error) {
      throw new ParseError("Ollama tool call arguments contained invalid JSON.", { cause: error });
    }
  }

  if (!isJsonObject(parsed)) {
    throw new ValidationError("Ollama tool call arguments must be a JSON object.");
  }

  try {
    return serializeJsonValue(parsed) as Record<string, JsonValue>;
  } catch (error) {
    throw new ValidationError("Ollama tool call arguments must be JSON-compatible.", { cause: error });
  }
};

const thinkingFromMessage = (message: ModelMessage) =>
  message.parts
    .filter((part) => {
      if (part.type !== "provider-data" || part.provider !== "ollama") {
        return false;
      }
      if (!isJsonObject(part.data)) {
        return false;
      }
      const data = part.data;
      return data.type === "thinking" && typeof data.thinking === "string";
    })
    .map((part) =>
      part.type === "provider-data" && isJsonObject(part.data) ? String(part.data.thinking) : ""
    )
    .join("");

const isGptOssModel = (modelId: string) => /(?:^|[/:-])gpt-oss(?=$|[/:-])/i.test(modelId);

const isMuseGlimmerModel = (modelId: string) =>
  /(?:^|[/:-])muse-glimmer(?=$|[/:-])/i.test(modelId);

const isKnownThinkingModel = (modelId: string) =>
  /(?:^|[/:-])(?:qwen3(?:\.5)?|gpt-oss|deepseek-(?:r1|v3\.1)|gemma4|muse-glimmer)(?=$|[/:-])/i.test(
    modelId
  );

const isCloudModel = (modelId: string) => /(?:^|:)(?:cloud|[^:]+-cloud)$/i.test(modelId);

const capabilitiesForModel = (modelId: string, directCloud: boolean): ModelCapabilities => ({
  ...capabilities,
  embeddings: directCloud ? false : capabilities.embeddings,
  structuredOutput: directCloud || isCloudModel(modelId) ? false : capabilities.structuredOutput,
  jsonMode: directCloud || isCloudModel(modelId) ? false : capabilities.jsonMode,
  reasoning: isKnownThinkingModel(modelId),
  reasoningEfforts: isKnownThinkingModel(modelId)
    ? isGptOssModel(modelId)
      ? ["low", "medium", "high"]
      : isMuseGlimmerModel(modelId)
        ? ["none", "low", "medium", "high"]
      : ["none", "low", "medium", "high", "max"]
    : undefined
});

const apiEndpoint = (baseURL: string, endpoint: "chat" | "embed") => {
  const url = new URL(baseURL);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/api") ? path : `${path}/api`}/${endpoint}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
};

const jsonHeaders = (configuredHeaders: Headers, apiKey: string | undefined) => {
  const headers = new Headers(configuredHeaders);
  headers.set("content-type", "application/json");
  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
};

const providerErrorFromPayload = (payload: Record<string, unknown>, fallbackStatus: number, streaming: boolean) => {
  const status =
    typeof payload.status === "number" && payload.status >= 400 && payload.status <= 599
      ? payload.status
      : fallbackStatus >= 400 && fallbackStatus <= 599
        ? fallbackStatus
        : 500;
  return new ProviderHTTPError(
    streaming ? "Ollama streaming request failed." : "Ollama request failed.",
    status,
    { responseBody: JSON.stringify(payload) }
  );
};

const validateNativeThink = (value: unknown) => {
  if (
    value !== undefined &&
    typeof value !== "boolean" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "max"
  ) {
    throw new ValidationError('Ollama "think" must be a boolean or "low", "medium", "high", or "max".');
  }
};

const mapReasoning = (modelId: string, input: ModelGenerateInput) => {
  const reasoning = input.reasoning;
  const nativeThink = input.providerOptions?.think;
  validateNativeThink(nativeThink);

  if (!reasoning) {
    if (isGptOssModel(modelId) && (typeof nativeThink === "boolean" || nativeThink === "max")) {
      throw new UnsupportedFeatureError(
        'Ollama GPT-OSS models require "think" to be "low", "medium", or "high".'
      );
    }
    if (isMuseGlimmerModel(modelId) && nativeThink === "max") {
      throw new UnsupportedFeatureError(
        'Ollama Muse Glimmer models support "think" as a boolean or "low", "medium", or "high".'
      );
    }
    return nativeThink as boolean | "low" | "medium" | "high" | "max" | undefined;
  }
  if (nativeThink !== undefined) {
    throw new ValidationError('Do not combine shared "reasoning" with Ollama "providerOptions.think".');
  }
  if (!isKnownThinkingModel(modelId)) {
    throw new UnsupportedFeatureError(
      `Provider "ollama" model "${modelId}" is not a recognized thinking model; use "providerOptions.think" for custom models.`
    );
  }
  if (reasoning.budgetTokens !== undefined) {
    throw new UnsupportedFeatureError('Provider "ollama" does not support "reasoning.budgetTokens".');
  }
  if (reasoning.mode !== undefined || reasoning.context !== undefined) {
    throw new UnsupportedFeatureError('Provider "ollama" does not support "reasoning.mode" or "reasoning.context".');
  }

  const effort = reasoning.effort;
  if (effort === "minimal" || effort === "xhigh") {
    throw new UnsupportedFeatureError(`Provider "ollama" does not support reasoning effort "${effort}".`);
  }
  if (effort === "none" && reasoning.includeThoughts) {
    throw new UnsupportedFeatureError(
      'Provider "ollama" cannot include thinking when reasoning effort is "none".'
    );
  }
  if (effort && effort !== "none" && reasoning.includeThoughts === false) {
    throw new UnsupportedFeatureError(
      'Provider "ollama" cannot hide thinking while an explicit reasoning effort is enabled.'
    );
  }

  const think =
    effort === "none"
      ? false
      : effort
        ? effort
        : reasoning.includeThoughts;
  if (think === undefined) {
    throw new ValidationError('The Ollama "reasoning" config must include "effort" or "includeThoughts".');
  }
  if (isGptOssModel(modelId) && (typeof think === "boolean" || think === "max")) {
    throw new UnsupportedFeatureError(
      'Ollama GPT-OSS models require reasoning effort "low", "medium", or "high".'
    );
  }
  if (isMuseGlimmerModel(modelId) && think === "max") {
    throw new UnsupportedFeatureError(
      'Ollama Muse Glimmer models support reasoning effort "none", "low", "medium", or "high".'
    );
  }
  return think;
};

const parseDataUrl = (value: string) => {
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new ValidationError("Ollama image inputs must be provided as data URLs.");
  }
  return match[2];
};

const mapMessages = (messages: ModelMessage[]) =>
  messages.map((message) => {
    if (message.role === "tool") {
      const toolResult = message.parts.find((part) => part.type === "tool-result");
      return {
        role: "tool",
        tool_name: toolResult?.type === "tool-result" ? toolResult.toolResult.toolName : undefined,
        tool_call_id: toolResult?.type === "tool-result" ? toolResult.toolResult.toolCallId : undefined,
        content:
          toolResult?.type === "tool-result"
            ? JSON.stringify(toolResult.toolResult.isError ? toolResult.toolResult.error : toolResult.toolResult.output)
            : ""
      };
    }

    const text = message.parts
      .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const images = message.parts
      .filter((part): part is Extract<ModelMessage["parts"][number], { type: "image" }> => part.type === "image")
      .map((part) => parseDataUrl(part.image));
    const toolCalls = message.parts
      .filter((part): part is Extract<ModelMessage["parts"][number], { type: "tool-call" }> => part.type === "tool-call")
      .map((part, index) => ({
        id: part.toolCall.id ?? `${part.toolCall.name}-${index}`,
        type: "function",
        function: {
          index,
          name: part.toolCall.name,
          arguments: parseToolArguments(part.toolCall.input)
        }
      }));
    const thinking = message.role === "assistant" ? thinkingFromMessage(message) : "";

    return {
      role: message.role,
      content: text,
      ...(thinking ? { thinking } : {}),
      ...(images.length ? { images } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    };
  });

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? (() => {
        const toolDefinitions = Object.values(tools);
        const callableTools = toolDefinitions.filter(isCallableToolDefinition);
        if (callableTools.length !== toolDefinitions.length) {
          throw new UnsupportedFeatureError('Provider "ollama" does not support hosted tools.');
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

const mapFormat = (input: ModelGenerateInput) => {
  if (input.structuredOutput?.mode === "native") {
    return toJSONSchema(input.structuredOutput.schema);
  }

  return undefined;
};

const parseAssistantMessage = (message: any) => ({
  role: "assistant" as const,
  parts: [
    ...(typeof message?.thinking === "string" && message.thinking
      ? [providerDataPart("ollama", { type: "thinking", thinking: message.thinking })]
      : []),
    ...(typeof message?.content === "string" && message.content ? [{ type: "text" as const, text: message.content }] : []),
    ...((Array.isArray(message?.tool_calls) ? message.tool_calls : []).map((call: any, index: number) => ({
      type: "tool-call" as const,
      toolCall: {
        id:
          call.id ??
          `${call.function?.name ?? "tool"}-${
            typeof call.function?.index === "number" ? call.function.index : index
          }`,
        name: call.function?.name ?? "tool",
        input: parseToolArguments(call.function?.arguments)
      }
    })))
  ]
});

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await readErrorBodyWithLimit(response);
    throw new ProviderHTTPError(`Ollama request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  const json = await readJsonWithLimit<any>(response, {
    maxBytes: 128 * 1024 * 1024,
    provider: "ollama",
    endpoint: response.url || undefined
  });
  if (isJsonObject(json) && typeof json.error === "string") {
    throw providerErrorFromPayload(json, response.status, false);
  }
  return json;
};

const parseJsonLines = async function* (response: Response): AsyncGenerator<any> {
  if (!response.ok) {
    const body = await readErrorBodyWithLimit(response);
    throw new ProviderHTTPError(`Ollama request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  if (!response.body) {
    throw new ValidationError("Ollama streaming response did not include a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) {
        await reader.cancel("Ollama JSON line exceeded 1048576 characters.").catch(() => {});
        throw new ValidationError("Ollama streaming response line exceeded 1048576 characters.");
      }

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line) {
          const json = JSON.parse(line) as unknown;
          if (isJsonObject(json) && typeof json.error === "string") {
            await reader.cancel("Ollama streaming request failed.").catch(() => {});
            throw providerErrorFromPayload(json, response.status, true);
          }
          yield json;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    const finalLine = buffer.trim();
    if (finalLine) {
      const json = JSON.parse(finalLine) as unknown;
      if (isJsonObject(json) && typeof json.error === "string") {
        throw providerErrorFromPayload(json, response.status, true);
      }
      yield json;
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError("Ollama streaming response contained invalid JSON.", { cause: error });
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
};

const normalizeOllamaError = (error: unknown) => {
  if (error instanceof ProviderHTTPError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Ollama request failed.";
  if (message.toLowerCase().includes("model") && message.toLowerCase().includes("not found")) {
    return new ValidationError(message, { cause: error });
  }
  if (message.toLowerCase().includes("connect") || message.toLowerCase().includes("econnrefused")) {
    return new ConfigurationError(message, { cause: error });
  }

  return error instanceof Error ? error : new Error(message);
};

class OllamaLanguageModel implements LanguageModel<OllamaLanguageModelOptions> {
  readonly provider = "ollama";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly apiKey: string | undefined,
    private readonly configuredHeaders: Headers,
    private readonly fetcher: typeof globalThis.fetch,
    directCloud: boolean
  ) {
    this.capabilities = capabilitiesForModel(modelId, directCloud);
  }

  private toRequestBody(input: ModelGenerateInput, stream: boolean) {
    if (input.providerOptions?.raw !== undefined || input.providerOptions?.template !== undefined) {
      throw new UnsupportedFeatureError(
        'Ollama "raw" and "template" options belong to `/api/generate`; this adapter uses `/api/chat`.'
      );
    }
    const providerFormat = input.providerOptions?.format;
    if (typeof providerFormat === "string" && providerFormat !== "json") {
      throw new ValidationError('Ollama chat "format" must be "json" or a JSON Schema object.');
    }
    const topLogprobs = input.providerOptions?.top_logprobs;
    if (
      topLogprobs !== undefined &&
      (typeof topLogprobs !== "number" || !Number.isInteger(topLogprobs) || topLogprobs < 0 || topLogprobs > 20)
    ) {
      throw new ValidationError('Ollama "top_logprobs" must be an integer between 0 and 20.');
    }

    return {
      ...input.providerOptions,
      model: this.modelId,
      messages: mapMessages(input.messages),
      tools: mapTools(input.tools),
      format: mapFormat(input) ?? input.providerOptions?.format,
      think: mapReasoning(this.modelId, input),
      options: {
        ...(typeof input.providerOptions?.options === "object" && input.providerOptions?.options
          ? input.providerOptions.options
          : {}),
        num_predict: input.maxTokens,
        temperature: input.temperature
      },
      stream
    };
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(apiEndpoint(this.baseURL, "chat"), {
            method: "POST",
            headers: jsonHeaders(this.configuredHeaders, this.apiKey),
            signal,
            body: JSON.stringify(this.toRequestBody(input, false))
          }),
        input
      );

      const json = await parseJson(response);
      const assistantMessage = parseAssistantMessage(json.message);
      const text = assistantMessage.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

      return {
        messages: [assistantMessage],
        text,
        finishReason: normalizeFinishReason(json.done_reason),
        providerFinishReason: json.done_reason,
        usage: {
          inputTokens: json.prompt_eval_count,
          outputTokens: json.eval_count,
          totalTokens: (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0)
        },
        rawResponse: json
      };
    } catch (error) {
      throw normalizeOllamaError(error);
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(apiEndpoint(this.baseURL, "chat"), {
            method: "POST",
            headers: jsonHeaders(this.configuredHeaders, this.apiKey),
            signal,
            body: JSON.stringify(this.toRequestBody(input, true))
          }),
        input
      );

      return (async function* () {
        try {
          for await (const json of parseJsonLines(response)) {
            const assistantMessage = parseAssistantMessage(json.message);

            for (const part of assistantMessage.parts) {
              if (part.type === "text" && part.text) {
                yield {
                  type: "text-delta",
                  textDelta: part.text
                } satisfies StreamEvent;
              }

              if (part.type === "tool-call") {
                yield {
                  type: "tool-call",
                  toolCall: part.toolCall
                } satisfies StreamEvent;
              }

              if (part.type === "provider-data") {
                yield {
                  type: "provider-data",
                  provider: part.provider,
                  data: part.data
                } satisfies StreamEvent;
              }
            }

            if (json.done) {
              yield {
                type: "finish",
                finishReason: normalizeFinishReason(json.done_reason),
                providerFinishReason: json.done_reason,
                usage: {
                  inputTokens: json.prompt_eval_count,
                  outputTokens: json.eval_count,
                  totalTokens: (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0)
                }
              } satisfies StreamEvent;
            }
          }
        } finally {
          cleanup();
        }
      })();
    } catch (error) {
      cleanup();
      throw normalizeOllamaError(error);
    }
  }
}

class OllamaEmbeddingModel implements EmbeddingModel {
  readonly provider = "ollama";
  readonly capabilities: ModelCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly apiKey: string | undefined,
    private readonly configuredHeaders: Headers,
    private readonly fetcher: typeof globalThis.fetch,
    directCloud: boolean
  ) {
    this.capabilities = {
      ...embeddingCapabilities,
      embeddings: !directCloud
    };
  }

  async embed(input: EmbedInput & { abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<EmbedResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const values = input.values.map((value) => {
      if (typeof value !== "string") {
        throw new UnsupportedFeatureError('Provider "ollama" does not support multimodal embedding values.');
      }
      return value;
    });

    try {
      const response = await withRetry(
        () =>
          this.fetcher(apiEndpoint(this.baseURL, "embed"), {
            method: "POST",
            headers: jsonHeaders(this.configuredHeaders, this.apiKey),
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
        embeddings: json.embeddings ?? [],
        usage: {
          inputTokens: json.prompt_eval_count,
          totalTokens: json.prompt_eval_count
        },
        rawResponse: json
      };
    } catch (error) {
      throw normalizeOllamaError(error);
    } finally {
      cleanup();
    }
  }
}

export const createOllama = (options: OllamaProviderOptions = {}): CallableProviderAdapter & ProviderAdapter => {
  const configuredBaseURL = options.baseURL ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  let candidate: URL;
  try {
    candidate = new URL(configuredBaseURL);
  } catch (error) {
    throw new ConfigurationError("Ollama baseURL must be an absolute URL.", { cause: error });
  }
  const baseURL = assertTrustedEndpoint(configuredBaseURL, {
    label: "Ollama baseURL",
    protocols:
      options.allowUnsafeEndpoints || candidate.protocol === "https:" || isLoopbackHostname(candidate.hostname)
        ? ["http", "https"]
        : ["https"],
    allowLoopback: true,
    allowUnsafe: options.allowUnsafeEndpoints
  }).toString().replace(/\/+$/, "");
  if (options.apiKey !== undefined && !options.apiKey.trim()) {
    throw new ConfigurationError("Ollama apiKey must be a non-empty string when provided.");
  }
  const directCloud = candidate.hostname === "ollama.com";
  const configuredHeaders = new Headers(options.headers);
  const cloudEnvironmentKey =
    directCloud && !configuredHeaders.has("authorization")
      ? process.env.OLLAMA_API_KEY?.trim() || undefined
      : undefined;
  const apiKey = options.apiKey?.trim() ?? cloudEnvironmentKey;
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "ollama",
    languageModel: (modelId) =>
      new OllamaLanguageModel(modelId, baseURL, apiKey, configuredHeaders, fetcher, directCloud),
    embeddingModel: (modelId) =>
      new OllamaEmbeddingModel(modelId, baseURL, apiKey, configuredHeaders, fetcher, directCloud)
  });
};
