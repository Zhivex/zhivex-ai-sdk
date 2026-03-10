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

export interface GeminiProviderOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Gemini request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return response.json();
};

const mapMessages = (messages: ModelGenerateInput["messages"]) => {
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    if (message.role === "system") {
      contents.push({ role: "user", parts: [{ text: `System: ${message.content}` }] });
      continue;
    }

    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.toolName,
              response: {
                name: message.toolName,
                content: JSON.parse(message.content)
              }
            }
          }
        ]
      });
      continue;
    }

    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    });
  }
  return contents;
};

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? [
        {
          functionDeclarations: Object.values(tools).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.schema
          }))
        }
      ]
    : undefined;

class GeminiLanguageModel implements LanguageModel {
  readonly provider = "gemini";

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(action: string) {
    return `${this.baseURL}/models/${this.modelId}:${action}?key=${this.apiKey}`;
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const response = await this.fetcher(this.url("generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: mapMessages(input.messages),
        generationConfig: {
          temperature: input.temperature,
          maxOutputTokens: input.maxTokens
        },
        tools: mapTools(input.tools),
        ...input.providerOptions
      })
    });

    const json = await parseJson(response);
    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    return {
      text: parts.filter((part: any) => part.text).map((part: any) => part.text).join(""),
      finishReason: candidate?.finishReason,
      toolCalls: parts
        .filter((part: any) => part.functionCall)
        .map((part: any) => ({
          id: `${part.functionCall.name}-0`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {}
        })),
      rawResponse: json
    };
  }

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamChunk>> {
    const response = await this.fetcher(this.url("streamGenerateContent&alt=sse"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: mapMessages(input.messages),
        generationConfig: {
          temperature: input.temperature,
          maxOutputTokens: input.maxTokens
        },
        tools: mapTools(input.tools),
        ...input.providerOptions
      })
    });

    return (async function* () {
      for await (const event of streamSSE(response)) {
        const json = JSON.parse(event.data);
        const candidate = json.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        for (const part of parts) {
          if (part.text) {
            yield { type: "text-delta", textDelta: part.text } satisfies StreamChunk;
          }

          if (part.functionCall) {
            yield {
              type: "tool-call",
              toolCall: {
                id: `${part.functionCall.name}-0`,
                name: part.functionCall.name,
                input: part.functionCall.args ?? {}
              }
            } satisfies StreamChunk;
          }
        }

        if (candidate?.finishReason) {
          yield { type: "finish", finishReason: candidate.finishReason } satisfies StreamChunk;
        }
      }
    })();
  }
}

class GeminiEmbeddingModel implements EmbeddingModel {
  readonly provider = "gemini";

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async embed(input: EmbedInput): Promise<EmbedResult> {
    const embeddings: number[][] = [];
    for (const value of input.values) {
      const response = await this.fetcher(
        `${this.baseURL}/models/${this.modelId}:embedContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: { parts: [{ text: value }] }
          })
        }
      );
      const json = await parseJson(response);
      embeddings.push(json.embedding.values);
    }

    return {
      embeddings
    };
  }
}

export const createGemini = (options: GeminiProviderOptions = {}): ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError("Missing Gemini API key.");
  }

  const baseURL = options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta";
  const fetcher = options.fetch ?? globalThis.fetch;

  return {
    name: "gemini",
    languageModel: (modelId) => new GeminiLanguageModel(modelId, apiKey, baseURL, fetcher),
    embeddingModel: (modelId) => new GeminiEmbeddingModel(modelId, apiKey, baseURL, fetcher),
    rawFetch: fetcher
  };
};
