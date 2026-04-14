import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  ProviderHTTPError,
  isCallableToolDefinition,
  UnsupportedFeatureError,
  ValidationError,
  createProviderAdapter,
  normalizeFinishReason,
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

export interface OllamaProviderOptions {
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

export interface OllamaLanguageModelOptions {
  format?: "json" | Record<string, unknown> | string;
  keep_alive?: string | number;
  raw?: boolean;
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
  webSearch: false
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
          name: part.toolCall.name,
          arguments: JSON.stringify(part.toolCall.input)
        }
      }));

    return {
      role: message.role,
      content: text,
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
    ...(typeof message?.content === "string" && message.content ? [{ type: "text" as const, text: message.content }] : []),
    ...((message?.tool_calls ?? []).map((call: any, index: number) => ({
      type: "tool-call" as const,
      toolCall: {
        id: call.id ?? `${call.function?.name ?? "tool"}-${index}`,
        name: call.function?.name ?? "tool",
        input: JSON.parse(call.function?.arguments ?? "{}")
      }
    })) ?? [])
  ]
});

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Ollama request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const parseJsonLines = async function* (response: Response): AsyncGenerator<any> {
  if (!response.ok) {
    const body = await response.text();
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

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line) {
          yield JSON.parse(line);
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    const finalLine = buffer.trim();
    if (finalLine) {
      yield JSON.parse(finalLine);
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
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private toRequestBody(input: ModelGenerateInput, stream: boolean) {
    return {
      model: this.modelId,
      messages: mapMessages(input.messages),
      tools: mapTools(input.tools),
      ...input.providerOptions,
      format: mapFormat(input) ?? input.providerOptions?.format,
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
      if (input.reasoning) {
        throw new UnsupportedFeatureError('Provider "ollama" does not support "reasoning".');
      }

      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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
      if (input.reasoning) {
        throw new UnsupportedFeatureError('Provider "ollama" does not support "reasoning".');
      }

      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async embed(input: EmbedInput & { abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<EmbedResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/api/embed`, {
            method: "POST",
            headers: { "content-type": "application/json" },
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
  const baseURL = options.baseURL ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "ollama",
    languageModel: (modelId) => new OllamaLanguageModel(modelId, baseURL, fetcher),
    embeddingModel: (modelId) => new OllamaEmbeddingModel(modelId, baseURL, fetcher)
  });
};
