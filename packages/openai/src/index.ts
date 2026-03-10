import {
  ConfigurationError,
  ProviderHTTPError,
  streamSSE,
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  type GenerateResult,
  type LanguageModel,
  type ModelGenerateInput,
  type ProviderAdapter,
  type StreamChunk
} from "@zhivex-ai/core";

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`OpenAI request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const mapMessages = (messages: ModelGenerateInput["messages"]) =>
  messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content
      };
    }

    return {
      role: message.role,
      content: message.content
    };
  });

const mapTools = (input: ModelGenerateInput["tools"]) =>
  input
    ? Object.values(input).map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema
        }
      }))
    : undefined;

class OpenAILanguageModel implements LanguageModel {
  readonly provider = "openai";

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const response = await this.fetcher(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: jsonHeaders(this.apiKey),
      body: JSON.stringify({
        model: this.modelId,
        messages: mapMessages(input.messages),
        tools: mapTools(input.tools),
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        stream: false,
        ...input.providerOptions
      })
    });

    const json = await parseJson(response);
    const choice = json.choices?.[0];
    const message = choice?.message ?? {};

    return {
      text: message.content ?? "",
      finishReason: choice?.finish_reason,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens
      },
      toolCalls: message.tool_calls?.map((call: any) => ({
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments ?? "{}")
      })),
      rawResponse: json
    };
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamChunk>> {
    const response = await this.fetcher(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: jsonHeaders(this.apiKey),
      body: JSON.stringify({
        model: this.modelId,
        messages: mapMessages(input.messages),
        tools: mapTools(input.tools),
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...input.providerOptions
      })
    });

    return (async function* () {
      const toolBuffers = new Map<string, { name: string; args: string }>();

      for await (const event of streamSSE(response)) {
        if (event.data === "[DONE]") {
          yield { type: "finish", finishReason: "stop" } satisfies StreamChunk;
          return;
        }

        const json = JSON.parse(event.data);
        const choice = json.choices?.[0];
        const delta = choice?.delta;

        if (delta?.content) {
          yield { type: "text-delta", textDelta: delta.content } satisfies StreamChunk;
        }

        for (const toolCall of delta?.tool_calls ?? []) {
          const existing = toolBuffers.get(toolCall.id ?? `${toolCall.index}`) ?? {
            name: toolCall.function?.name ?? "",
            args: ""
          };
          existing.name ||= toolCall.function?.name ?? "";
          existing.args += toolCall.function?.arguments ?? "";
          toolBuffers.set(toolCall.id ?? `${toolCall.index}`, existing);

          if (choice?.finish_reason === "tool_calls") {
            yield {
              type: "tool-call",
              toolCall: {
                id: toolCall.id ?? `${toolCall.index}`,
                name: existing.name,
                input: JSON.parse(existing.args || "{}")
              }
            } satisfies StreamChunk;
          }
        }

        if (choice?.finish_reason && choice.finish_reason !== "tool_calls") {
          yield {
            type: "finish",
            finishReason: choice.finish_reason,
            usage: json.usage
              ? {
                  inputTokens: json.usage.prompt_tokens,
                  outputTokens: json.usage.completion_tokens,
                  totalTokens: json.usage.total_tokens
                }
              : undefined
          } satisfies StreamChunk;
        }
      }
    })();
  }
}

class OpenAIEmbeddingModel implements EmbeddingModel {
  readonly provider = "openai";

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async embed(input: EmbedInput): Promise<EmbedResult> {
    const response = await this.fetcher(`${this.baseURL}/embeddings`, {
      method: "POST",
      headers: jsonHeaders(this.apiKey),
      body: JSON.stringify({
        model: this.modelId,
        input: input.values
      })
    });

    const json = await parseJson(response);
    return {
      embeddings: json.data.map((entry: any) => entry.embedding),
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        totalTokens: json.usage?.total_tokens
      },
      rawResponse: json
    };
  }
}

export const createOpenAI = (options: OpenAIProviderOptions = {}): ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing OpenAI API key.");
  }

  const baseURL = options.baseURL ?? "https://api.openai.com/v1";
  const fetcher = options.fetch ?? globalThis.fetch;

  return {
    name: "openai",
    languageModel: (modelId) => new OpenAILanguageModel(modelId, apiKey, baseURL, fetcher),
    embeddingModel: (modelId) => new OpenAIEmbeddingModel(modelId, apiKey, baseURL, fetcher),
    rawFetch: fetcher
  };
};
