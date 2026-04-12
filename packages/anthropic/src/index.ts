import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createProviderAdapter,
  isCallableToolDefinition,
  hostedTool,
  normalizeFinishReason,
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
  type ProviderAdapter,
  type StreamEvent
} from "@zhivex-ai/core";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  anthropicVersion?: string;
  fetch?: typeof globalThis.fetch;
}

export interface AnthropicLanguageModelOptions {
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: Record<string, unknown>;
  tool_choice?: { type: "auto" | "none" | "any" | "tool"; name?: string };
  [key: string]: unknown;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: true,
  parallelToolCalls: true,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: true,
  webSearch: true
};

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Anthropic request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const mapBlockParts = (message: ModelMessage) =>
  message.parts.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        return {
          type: "image",
          source: {
            type: "url",
            url: part.image
          }
        };
      case "tool-call":
        return {
          type: "tool_use",
          id: part.toolCall.id,
          name: part.toolCall.name,
          input: part.toolCall.input
        };
      case "tool-result":
        return {
          type: "tool_result",
          tool_use_id: part.toolResult.toolCallId,
          content: JSON.stringify(part.toolResult.isError ? part.toolResult.error : part.toolResult.output),
          is_error: part.toolResult.isError
        };
      default:
        return {
          type: "text",
          text: JSON.stringify(part)
        };
    }
  });

const systemPromptFromMessages = (messages: ModelMessage[]) =>
  messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const mapMessages = (messages: ModelMessage[]) =>
  messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          role: "user",
          content: mapBlockParts(message)
        };
      }

      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: mapBlockParts(message)
      };
    });

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? Object.values(tools).map((tool) => {
        if (isCallableToolDefinition(tool)) {
          return {
            name: tool.name,
            description: tool.description,
            input_schema: toJSONSchema(tool.schema)
          };
        }

        if (tool.provider && tool.provider !== "anthropic") {
          throw new UnsupportedFeatureError(
            `Provider "anthropic" does not support hosted tools declared for provider "${tool.provider}".`
          );
        }

        return {
          type: tool.type,
          name: tool.name,
          ...(tool.config && typeof tool.config === "object" ? tool.config : {})
        };
      })
    : undefined;

const mapToolChoice = (toolChoice: ModelGenerateInput["toolChoice"]) => {
  if (!toolChoice || toolChoice === "auto") {
    return undefined;
  }

  if (toolChoice === "none") {
    return {
      type: "none"
    };
  }

  if (toolChoice === "required") {
    return {
      type: "any"
    };
  }

  return {
    type: "tool",
    name: toolChoice.toolName
  };
};

const mapReasoning = (input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  if (input.reasoning.effort !== undefined) {
    throw new UnsupportedFeatureError('Provider "anthropic" does not support "reasoning.effort".');
  }

  if (input.reasoning.budgetTokens === undefined) {
    return undefined;
  }

  return {
    type: "enabled",
    budget_tokens: input.reasoning.budgetTokens
  };
};

const parseAssistantMessage = (json: any): ModelMessage => ({
  role: "assistant",
  parts:
    json.content?.map((block: any) => {
      if (block.type === "text") {
        return { type: "text", text: block.text } as const;
      }

      if (block.type === "tool_use") {
        return {
          type: "tool-call" as const,
          toolCall: {
            id: block.id,
            name: block.name,
            input: block.input
          }
        };
      }

      return { type: "text", text: JSON.stringify(block) } as const;
    }) ?? []
});

class AnthropicLanguageModel implements LanguageModel<AnthropicLanguageModelOptions> {
  readonly provider = "anthropic";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly anthropicVersion: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private headers() {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.anthropicVersion
    };
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/messages`, {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              system: systemPromptFromMessages(input.messages),
              messages: mapMessages(input.messages),
              tools: mapTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              temperature: input.temperature,
              max_tokens: input.maxTokens ?? 1024,
              ...input.providerOptions,
              thinking: mapReasoning(input)
            })
          }),
        input
      );

      const json = await parseJson(response);
      const assistantMessage = parseAssistantMessage(json);

      return {
        messages: [assistantMessage],
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        finishReason: normalizeFinishReason(json.stop_reason),
        providerFinishReason: json.stop_reason,
        usage: {
          inputTokens: json.usage?.input_tokens,
          outputTokens: json.usage?.output_tokens,
          totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0)
        },
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/messages`, {
          method: "POST",
          headers: this.headers(),
          signal,
          body: JSON.stringify({
            model: this.modelId,
            system: systemPromptFromMessages(input.messages),
            messages: mapMessages(input.messages),
            tools: mapTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            temperature: input.temperature,
            max_tokens: input.maxTokens ?? 1024,
            stream: true,
            ...input.providerOptions
          })
        }),
      input
    );

    return (async function* () {
      try {
        const toolBuffers = new Map<number, { id: string; name: string; input: string }>();

        for await (const event of streamSSE(response)) {
          const json = JSON.parse(event.data);

          if (event.event === "content_block_delta" && json.delta?.type === "text_delta") {
            yield { type: "text-delta", textDelta: json.delta.text } satisfies StreamEvent;
          }

          if (event.event === "content_block_start" && json.content_block?.type === "tool_use") {
            toolBuffers.set(json.index, {
              id: json.content_block.id,
              name: json.content_block.name,
              input: ""
            });
          }

          if (event.event === "content_block_delta" && json.delta?.type === "input_json_delta") {
            const current = toolBuffers.get(json.index);
            if (current) {
              current.input += json.delta.partial_json;
            }
          }

          if (event.event === "content_block_stop") {
            const current = toolBuffers.get(json.index);
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
          }

          if (event.event === "message_stop") {
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(json.stop_reason),
              providerFinishReason: json.stop_reason
            } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
  }
}

export const createAnthropic = (
  options: AnthropicProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Anthropic API key.");
  }

  const baseURL = options.baseURL ?? "https://api.anthropic.com/v1";
  const anthropicVersion = options.anthropicVersion ?? "2023-06-01";
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "anthropic",
    languageModel: (modelId) => new AnthropicLanguageModel(modelId, apiKey, baseURL, anthropicVersion, fetcher),
    rawFetch: fetcher
  });
};

export interface AnthropicWebSearchToolConfig {
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: {
    type: "approximate";
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
}

export const anthropicWebSearchTool = (config: AnthropicWebSearchToolConfig = {}) =>
  hostedTool({
    name: "web_search",
    provider: "anthropic",
    type: "web_search_20250305",
    config: config as unknown as JsonValue
  });
