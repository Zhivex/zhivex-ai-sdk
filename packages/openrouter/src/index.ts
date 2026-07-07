import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createProviderAdapter,
  hostedTool,
  isCallableToolDefinition,
  isHostedToolDefinition,
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

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseURL?: string;
  appName?: string;
  appURL?: string;
  fetch?: typeof globalThis.fetch;
}

export interface OpenRouterLanguageModelOptions {
  provider?: Record<string, unknown>;
  plugins?: Array<Record<string, unknown>>;
  models?: Array<{ model: string }>;
  route?: "fallback";
  transforms?: string[];
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  reasoning?: Record<string, unknown>;
  parallel_tool_calls?: boolean;
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  [key: string]: unknown;
}

export interface OpenRouterWebSearchToolConfig {
  engine?: "auto" | "native" | "exa" | "firecrawl" | "parallel";
  max_results?: number;
  max_total_results?: number;
  search_context_size?: "low" | "medium" | "high";
  user_location?: {
    type: "approximate";
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
  allowed_domains?: string[];
  excluded_domains?: string[];
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
  embeddings: false,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false
  }
};

const jsonHeaders = (apiKey: string, appName?: string, appURL?: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`,
  ...(appURL ? { "http-referer": appURL } : {}),
  ...(appName ? { "x-title": appName } : {})
});

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`OpenRouter request failed with status ${response.status}.`, response.status, {
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

    if (toolCalls.length) {
      payload.tool_calls = toolCalls;
    }

    return payload;
  });

const mapTools = (input: ModelGenerateInput["tools"]) =>
  input
    ? (() => {
        return Object.values(input).map((tool) => {
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

          if (tool.provider && tool.provider !== "openrouter") {
            throw new UnsupportedFeatureError(
              `Provider "openrouter" does not support hosted tools declared for provider "${tool.provider}".`
            );
          }

          return {
            type: tool.type,
            ...(tool.config && typeof tool.config === "object" ? tool.config : {})
          };
        });
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
    type: "json_schema",
    json_schema: {
      name: input.structuredOutput.name ?? "response",
      strict: true,
      schema: toJSONSchema(input.structuredOutput.schema)
    }
  };
};

const mapReasoning = (input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  return {
    effort: input.reasoning.effort,
    ...(input.reasoning.budgetTokens !== undefined ? { max_tokens: input.reasoning.budgetTokens } : {})
  };
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

class OpenRouterLanguageModel implements LanguageModel<OpenRouterLanguageModelOptions> {
  readonly provider = "openrouter";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly appName: string | undefined,
    private readonly appURL: string | undefined,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generate(input: ModelGenerateInput<OpenRouterLanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey, this.appName, this.appURL),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              model: this.modelId,
              messages: mapMessages(input.messages),
              tools: mapTools(input.tools),
              tool_choice: mapToolChoice(input.toolChoice),
              response_format: mapStructuredOutput(input),
              temperature: input.temperature,
              max_tokens: input.maxTokens,
              stream: false,
              reasoning: mapReasoning(input)
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

  async stream(input: ModelGenerateInput<OpenRouterLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(`${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: jsonHeaders(this.apiKey, this.appName, this.appURL),
          signal,
          body: JSON.stringify({
            ...input.providerOptions,
            model: this.modelId,
            messages: mapMessages(input.messages),
            tools: mapTools(input.tools),
            tool_choice: mapToolChoice(input.toolChoice),
            response_format: mapStructuredOutput(input),
            temperature: input.temperature,
            max_tokens: input.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            reasoning: mapReasoning(input)
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

export const createOpenRouter = (
  options: OpenRouterProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing OpenRouter API key.");
  }

  const baseURL = options.baseURL ?? "https://openrouter.ai/api/v1";
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "openrouter",
    languageModel: (modelId) => new OpenRouterLanguageModel(modelId, apiKey, baseURL, options.appName, options.appURL, fetcher),
    rawFetch: fetcher
  });
};

export const openRouterWebSearchTool = (config: OpenRouterWebSearchToolConfig = {}) =>
  hostedTool({
    name: "web_search",
    provider: "openrouter",
    type: "openrouter:web_search",
    toolClass: "web-search",
    config: (Object.keys(config).length ? { parameters: config } : {}) as unknown as JsonValue
  });
