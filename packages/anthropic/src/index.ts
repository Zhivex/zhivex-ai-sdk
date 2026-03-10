import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
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

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  anthropicVersion?: string;
  fetch?: typeof globalThis.fetch;
}

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Anthropic request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const mapMessages = (messages: ModelGenerateInput["messages"]) =>
  messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: message.content
            }
          ]
        };
      }

      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      };
    });

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? Object.values(tools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema
      }))
    : undefined;

class AnthropicLanguageModel implements LanguageModel {
  readonly provider = "anthropic";

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
    const system = input.messages.find((message) => message.role === "system")?.content;
    const response = await this.fetcher(`${this.baseURL}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.modelId,
        system,
        messages: mapMessages(input.messages),
        tools: mapTools(input.tools),
        temperature: input.temperature,
        max_tokens: input.maxTokens ?? 1024,
        ...input.providerOptions
      })
    });

    const json = await parseJson(response);
    const textBlocks = json.content?.filter((block: any) => block.type === "text") ?? [];
    const toolCalls =
      json.content
        ?.filter((block: any) => block.type === "tool_use")
        .map((block: any) => ({
          id: block.id,
          name: block.name,
          input: block.input
        })) ?? [];

    return {
      text: textBlocks.map((block: any) => block.text).join(""),
      finishReason: json.stop_reason,
      usage: {
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
        totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0)
      },
      toolCalls,
      rawResponse: json
    };
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamChunk>> {
    const system = input.messages.find((message) => message.role === "system")?.content;
    const response = await this.fetcher(`${this.baseURL}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.modelId,
        system,
        messages: mapMessages(input.messages),
        tools: mapTools(input.tools),
        temperature: input.temperature,
        max_tokens: input.maxTokens ?? 1024,
        stream: true,
        ...input.providerOptions
      })
    });

    return (async function* () {
      const toolBuffers = new Map<number, { id: string; name: string; input: string }>();

      for await (const event of streamSSE(response)) {
        const json = JSON.parse(event.data);

        if (event.event === "content_block_delta" && json.delta?.type === "text_delta") {
          yield { type: "text-delta", textDelta: json.delta.text } satisfies StreamChunk;
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
            } satisfies StreamChunk;
          }
        }

        if (event.event === "message_stop") {
          yield {
            type: "finish",
            finishReason: json.stop_reason
          } satisfies StreamChunk;
        }
      }
    })();
  }
}

class AnthropicEmbeddingModel implements EmbeddingModel {
  readonly provider = "anthropic";

  constructor(readonly modelId: string) {}

  async embed(_input: EmbedInput): Promise<EmbedResult> {
    throw new UnsupportedFeatureError(`Anthropic does not expose embeddings via this adapter for model "${this.modelId}".`);
  }
}

export const createAnthropic = (
  options: AnthropicProviderOptions = {}
): ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Anthropic API key.");
  }

  const baseURL = options.baseURL ?? "https://api.anthropic.com/v1";
  const anthropicVersion = options.anthropicVersion ?? "2023-06-01";
  const fetcher = options.fetch ?? globalThis.fetch;

  return {
    name: "anthropic",
    languageModel: (modelId) => new AnthropicLanguageModel(modelId, apiKey, baseURL, anthropicVersion, fetcher),
    embeddingModel: (modelId) => new AnthropicEmbeddingModel(modelId),
    rawFetch: fetcher
  };
};
