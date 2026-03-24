import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
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

export interface VertexProviderOptions {
  accessToken?: string;
  projectId?: string;
  location?: string;
  apiVersion?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

export interface VertexLanguageModelOptions {
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  candidateCount?: number;
  responseMimeType?: string;
  [key: string]: unknown;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: false,
  parallelToolCalls: false,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: true,
  reasoning: true,
  webSearch: false
};

const parseJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderHTTPError(`Vertex request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }

  return response.json();
};

const systemInstruction = (messages: ModelMessage[]) => {
  const text = messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return text ? { parts: [{ text }] } : undefined;
};

const mapPart = (part: ModelMessage["parts"][number]) => {
  switch (part.type) {
    case "text":
      return { text: part.text };
    case "image":
      return {
        inlineData: {
          mimeType: part.mediaType ?? "image/jpeg",
          data: part.image
        }
      };
    case "tool-call":
      return {
        functionCall: {
          name: part.toolCall.name,
          args: part.toolCall.input
        }
      };
    case "tool-result":
      return {
        functionResponse: {
          name: part.toolResult.toolName,
          response: {
            name: part.toolResult.toolName,
            content: part.toolResult.isError ? part.toolResult.error : part.toolResult.output
          }
        }
      };
    default:
      return { text: JSON.stringify(part) };
  }
};

const mapMessages = (messages: ModelMessage[]) =>
  messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: message.parts.map(mapPart)
    }));

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? [
        {
          functionDeclarations: Object.values(tools).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema)
          }))
        }
      ]
    : undefined;

const generationConfig = (input: ModelGenerateInput) => ({
  temperature: input.temperature,
  maxOutputTokens: input.maxTokens,
  ...(input.structuredOutput?.mode === "native"
    ? {
        responseMimeType: "application/json",
        responseSchema: toJSONSchema(input.structuredOutput.schema)
      }
    : {})
});

const parseAssistantMessage = (candidate: any): ModelMessage => ({
  role: "assistant",
  parts:
    candidate?.content?.parts?.map((part: any) => {
      if (part.text) {
        return { type: "text", text: part.text } as const;
      }
      if (part.functionCall) {
        return {
          type: "tool-call" as const,
          toolCall: {
            id: `${part.functionCall.name}-0`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {}
          }
        };
      }
      return { type: "text", text: JSON.stringify(part) } as const;
    }) ?? []
});

class VertexLanguageModel implements LanguageModel<VertexLanguageModelOptions> {
  readonly provider = "vertex";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url(action: string) {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:${action}`;
  }

  private headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.accessToken}`
    };
  }

  async generate(input: ModelGenerateInput<VertexLanguageModelOptions>): Promise<GenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url("generateContent"), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: mapMessages(input.messages),
              systemInstruction: systemInstruction(input.messages),
              generationConfig: generationConfig(input),
              tools: mapTools(input.tools),
              ...input.providerOptions
            })
          }),
        input
      );

      const json = await parseJson(response);
      const candidate = json.candidates?.[0];
      const assistantMessage = parseAssistantMessage(candidate);

      return {
        messages: [assistantMessage],
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        finishReason: normalizeFinishReason(candidate?.finishReason),
        providerFinishReason: candidate?.finishReason,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  async stream(input: ModelGenerateInput<VertexLanguageModelOptions>): Promise<AsyncIterable<StreamEvent>> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const response = await withRetry(
      () =>
        this.fetcher(this.url("streamGenerateContent?alt=sse"), {
          method: "POST",
          headers: this.headers(),
          signal,
          body: JSON.stringify({
            contents: mapMessages(input.messages),
            systemInstruction: systemInstruction(input.messages),
            generationConfig: generationConfig(input),
            tools: mapTools(input.tools),
            ...input.providerOptions
          })
        }),
      input
    );

    return (async function* () {
      try {
        for await (const event of streamSSE(response)) {
          const json = JSON.parse(event.data);
          const candidate = json.candidates?.[0];
          const parts = candidate?.content?.parts ?? [];

          for (const part of parts) {
            if (part.text) {
              yield { type: "text-delta", textDelta: part.text } satisfies StreamEvent;
            }

            if (part.functionCall) {
              yield {
                type: "tool-call",
                toolCall: {
                  id: `${part.functionCall.name}-0`,
                  name: part.functionCall.name,
                  input: part.functionCall.args ?? {}
                }
              } satisfies StreamEvent;
            }
          }

          if (candidate?.finishReason) {
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(candidate.finishReason),
              providerFinishReason: candidate.finishReason
            } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
  }
}

class VertexEmbeddingModel implements EmbeddingModel {
  readonly provider = "vertex";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url() {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:predict`;
  }

  private headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.accessToken}`
    };
  }

  async embed(input: EmbedInput & { abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<EmbedResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              instances: input.values.map((value) => ({
                content: value
              }))
            })
          }),
        input
      );

      const json = await parseJson(response);
      return {
        embeddings: (json.predictions ?? []).map((prediction: any) => prediction.embeddings?.values ?? []),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

export const createVertex = (
  options: VertexProviderOptions = {}
): CallableProviderAdapter & ProviderAdapter & { rawFetch: typeof globalThis.fetch } => {
  const accessToken = options.accessToken ?? process.env.VERTEX_ACCESS_TOKEN ?? process.env.GOOGLE_ACCESS_TOKEN;
  if (!accessToken) {
    throw new ConfigurationError("Missing Vertex access token.");
  }

  const projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (!projectId && !options.baseURL) {
    throw new ConfigurationError("Missing Vertex project ID.");
  }

  const location = options.location ?? process.env.VERTEX_LOCATION ?? "us-central1";
  const apiVersion = options.apiVersion ?? "v1beta1";
  const baseURL =
    options.baseURL ??
    `https://${location}-aiplatform.googleapis.com/${apiVersion}/projects/${projectId}/locations/${location}`;
  const fetcher = options.fetch ?? globalThis.fetch;

  return createProviderAdapter({
    name: "vertex",
    languageModel: (modelId) => new VertexLanguageModel(modelId, baseURL, accessToken, fetcher),
    embeddingModel: (modelId) => new VertexEmbeddingModel(modelId, baseURL, accessToken, fetcher),
    rawFetch: fetcher
  });
};
