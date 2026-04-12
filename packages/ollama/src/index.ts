import { toJSONSchema } from "zod";

import {
  ConfigurationError,
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
  type ProviderAdapter
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
  streaming: false,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: false,
  parallelToolCalls: true,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
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

class OllamaLanguageModel implements LanguageModel<OllamaLanguageModelOptions> {
  readonly provider = "ollama";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

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
            body: JSON.stringify({
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
              stream: false
            })
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
      if (error instanceof ProviderHTTPError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Ollama request failed.";
      if (message.toLowerCase().includes("model") && message.toLowerCase().includes("not found")) {
        throw new ValidationError(message, { cause: error });
      }
      if (message.toLowerCase().includes("connect") || message.toLowerCase().includes("econnrefused")) {
        throw new ConfigurationError(message, { cause: error });
      }
      throw error instanceof Error ? error : new Error(message);
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
    languageModel: (modelId) => new OllamaLanguageModel(modelId, baseURL, fetcher)
  });
};
