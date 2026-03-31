import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createProviderAdapter,
  normalizeFinishReason,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  type GenerateResult,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type StreamEvent
} from "@zhivex-ai/core";

export interface AzureOpenAIProviderOptions {
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
}

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
  webSearch: false
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
    ? Object.values(input).map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: toJSONSchema(tool.schema)
        }
      }))
    : undefined;

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

const normalizeEndpoint = (endpoint: string) => endpoint.replace(/\/+$/, "");

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

  const resolveURL = (modelId: string, path: "chat/completions" | "embeddings") =>
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
    rawFetch: fetcher
  });
};
