import {
  ConfigurationError,
  ProviderHTTPError,
  ValidationError,
  createProviderAdapter,
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
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
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

const mapPrompt = (messages: ModelMessage[]) =>
  messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const text = message.parts
        .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");

      return `${message.role.toUpperCase()}: ${text}`;
    })
    .join("\n\n");

const systemPrompt = (messages: ModelMessage[]) =>
  messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const lastUserImages = (messages: ModelMessage[]) => {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return (
    lastUser?.parts
      .filter((part): part is Extract<ModelMessage["parts"][number], { type: "image" }> => part.type === "image")
      .map((part) => parseDataUrl(part.image)) ?? []
  );
};

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
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/api/generate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
              model: this.modelId,
              system: systemPrompt(input.messages) || undefined,
              prompt: mapPrompt(input.messages),
              images: lastUserImages(input.messages),
              options: {
                num_predict: input.maxTokens,
                temperature: input.temperature
              },
              stream: false,
              ...input.providerOptions
            })
          }),
        input
      );

      const json = await parseJson(response);
      const text = json.response || "";

      return {
        messages: text
          ? [
              {
                role: "assistant",
                parts: [{ type: "text", text }]
              }
            ]
          : [],
        text,
        finishReason: "stop",
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
