import { toJSONSchema } from "zod";

import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createMcpToolSet,
  createProviderAdapter,
  isCallableToolDefinition,
  isHostedToolDefinition,
  normalizeFinishReason,
  streamSSE,
  withRetry,
  withTimeoutSignal,
  type AudioInput,
  type CallableProviderAdapter,
  type EmbedInput,
  type EmbeddingModel,
  type EmbedResult,
  type GenerateResult,
  type GroundedGenerateResult,
  type GroundedLanguageModel,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type SpeechModel,
  type SpeechResult,
  type StreamEvent,
  type TranscriptionModel,
  type TranscriptionResult
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
  toolChoice: true,
  parallelToolCalls: false,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: true,
  reasoning: true,
  webSearch: true
};

const transcriptionCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  audioInput: true,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

const speechCapabilities: ModelCapabilities = {
  ...transcriptionCapabilities,
  audioInput: false,
  audioOutput: true
};

const groundedCapabilities: ModelCapabilities = {
  ...capabilities,
  webSearch: true
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

const toBase64 = (data: AudioInput["data"]) => {
  if (typeof data === "string") {
    return data;
  }

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Buffer.from(bytes).toString("base64");
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
    ? (() => {
        const mappedTools: Array<Record<string, unknown>> = [];
        const functionDeclarations = Object.values(tools)
          .filter(isCallableToolDefinition)
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toJSONSchema(tool.schema)
          }));

        if (functionDeclarations.length) {
          mappedTools.push({ functionDeclarations });
        }

        for (const tool of Object.values(tools).filter(isHostedToolDefinition)) {
          if (tool.provider && tool.provider !== "vertex") {
            throw new UnsupportedFeatureError(
              `Provider "vertex" does not support hosted tools declared for provider "${tool.provider}".`
            );
          }

          mappedTools.push({
            [tool.type]: tool.config && typeof tool.config === "object" ? tool.config : {}
          });
        }

        return mappedTools.length ? mappedTools : undefined;
      })()
    : undefined;

const mapToolConfig = (toolChoice: ModelGenerateInput["toolChoice"], tools: ModelGenerateInput["tools"]) => {
  if (!toolChoice || toolChoice === "auto") {
    return undefined;
  }

  if (toolChoice === "none") {
    return {
      functionCallingConfig: {
        mode: "NONE"
      }
    };
  }

  if (toolChoice === "required") {
    return {
      functionCallingConfig: {
        mode: "ANY"
      }
    };
  }

  const selectedTool = tools?.[toolChoice.toolName];
  if (selectedTool && isHostedToolDefinition(selectedTool)) {
    throw new UnsupportedFeatureError('Provider "vertex" does not support selecting a hosted tool by name.');
  }

  return {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: [toolChoice.toolName]
    }
  };
};

const isGemini3Model = (modelId: string) => /^gemini-3([.-]|$)/.test(modelId);

const isGemini3ProModel = (modelId: string) => /^gemini-3([.-].*)?pro([.-]|$)/.test(modelId);

const mapReasoning = (modelId: string, input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  if (isGemini3Model(modelId)) {
    if (input.reasoning.budgetTokens !== undefined) {
      throw new UnsupportedFeatureError(
        'Provider "vertex" uses "reasoning.effort" for Gemini 3 models and does not support "reasoning.budgetTokens".'
      );
    }

    if (input.reasoning.effort === "none") {
      throw new UnsupportedFeatureError('Provider "vertex" does not support "reasoning.effort=none" for Gemini 3 models.');
    }

    if (input.reasoning.effort === "xhigh") {
      throw new UnsupportedFeatureError('Provider "vertex" does not support "reasoning.effort=xhigh".');
    }

    if (input.reasoning.effort === "minimal" && isGemini3ProModel(modelId)) {
      throw new UnsupportedFeatureError(
        'Provider "vertex" does not support "reasoning.effort=minimal" for Gemini 3 Pro models.'
      );
    }

    return input.reasoning.effort !== undefined
      ? {
          thinkingLevel: input.reasoning.effort
        }
      : undefined;
  }

  if (input.reasoning.effort !== undefined) {
    throw new UnsupportedFeatureError(
      'Provider "vertex" does not support "reasoning.effort" for models earlier than Gemini 3.'
    );
  }

  return input.reasoning.budgetTokens !== undefined
    ? {
        thinkingBudget: input.reasoning.budgetTokens
      }
    : undefined;
};

const generationConfig = (modelId: string, input: ModelGenerateInput) => ({
  temperature: input.temperature,
  maxOutputTokens: input.maxTokens,
  ...(input.reasoning
    ? {
        thinkingConfig: mapReasoning(modelId, input)
      }
    : {}),
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
    candidate?.content?.parts?.map((part: any, index: number) => {
      if (part.text) {
        return { type: "text", text: part.text } as const;
      }
      if (part.functionCall) {
        return {
          type: "tool-call" as const,
          toolCall: {
            id: part.functionCall.id ?? `${part.functionCall.name}-${index}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {}
          }
        };
      }
      return { type: "text", text: JSON.stringify(part) } as const;
    }) ?? []
});

const extractGroundingSources = (candidate: any): GroundedGenerateResult["sources"] =>
  (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk: any) => ({
      title: chunk.web?.title,
      url: chunk.web?.uri,
      snippet: chunk.web?.snippet,
      providerMetadata: chunk
    }))
    .filter((source: GroundedGenerateResult["sources"][number]) => typeof source.url === "string");

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
              tools: mapTools(input.tools),
              ...input.providerOptions,
              toolConfig: mapToolConfig(input.toolChoice, input.tools),
              generationConfig: generationConfig(this.modelId, input)
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
            tools: mapTools(input.tools),
            ...input.providerOptions,
            toolConfig: mapToolConfig(input.toolChoice, input.tools),
            generationConfig: generationConfig(this.modelId, input)
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

          for (const [index, part] of parts.entries()) {
            if (part.text) {
              yield { type: "text-delta", textDelta: part.text } satisfies StreamEvent;
            }

            if (part.functionCall) {
              yield {
                type: "tool-call",
                toolCall: {
                  id: part.functionCall.id ?? `${part.functionCall.name}-${index}`,
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

class VertexTranscriptionModel implements TranscriptionModel {
  readonly provider = "vertex";
  readonly capabilities = transcriptionCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url() {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:generateContent`;
  }

  private headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.accessToken}`
    };
  }

  async transcribe(input: {
    audio: AudioInput;
    prompt?: string;
    language?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<TranscriptionResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      inlineData: {
                        mimeType: input.audio.mediaType,
                        data: toBase64(input.audio.data)
                      }
                    },
                    {
                      text:
                        input.prompt ??
                        `Transcribe this audio${input.language ? ` in ${input.language}` : ""}. Return only the transcript.`
                    }
                  ]
                }
              ],
              ...input.providerOptions
            })
          }),
        input
      );

      const json = await parseJson(response);
      const text = json.candidates?.[0]?.content?.parts?.find((part: any) => typeof part.text === "string")?.text ?? "";
      return {
        text,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class VertexSpeechModel implements SpeechModel {
  readonly provider = "vertex";
  readonly capabilities = speechCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url() {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:generateContent`;
  }

  private headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.accessToken}`
    };
  }

  async generateSpeech(input: {
    input: string;
    voice?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<SpeechResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: input.input }] }],
              generationConfig: {
                responseModalities: ["AUDIO"]
              },
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: input.voice ?? "Kore"
                  }
                }
              },
              ...input.providerOptions
            })
          }),
        input
      );

      const json = await parseJson(response);
      const audioPart = json.candidates?.[0]?.content?.parts?.find((part: any) => part.inlineData?.data);
      return {
        audio: Uint8Array.from(Buffer.from(audioPart?.inlineData?.data ?? "", "base64")),
        mediaType: audioPart?.inlineData?.mimeType ?? "audio/wav",
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

class VertexGroundedLanguageModel implements GroundedLanguageModel {
  readonly provider = "vertex";
  readonly capabilities = groundedCapabilities;

  constructor(
    readonly modelId: string,
    private readonly baseURL: string,
    private readonly accessToken: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  private url() {
    return `${this.baseURL}/publishers/google/models/${this.modelId}:generateContent`;
  }

  private headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.accessToken}`
    };
  }

  async generate(input: {
    messages: ModelMessage[];
    temperature?: number;
    maxTokens?: number;
    reasoning?: ModelGenerateInput["reasoning"];
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<GroundedGenerateResult> {
    const { signal, cleanup } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(this.url(), {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              contents: mapMessages(input.messages),
              systemInstruction: systemInstruction(input.messages),
              tools: [{ googleSearch: {} }],
              generationConfig: generationConfig(this.modelId, {
                messages: input.messages,
                temperature: input.temperature,
                maxTokens: input.maxTokens,
                reasoning: input.reasoning
              } as ModelGenerateInput),
              ...input.providerOptions
            })
          }),
        input
      );

      const json = await parseJson(response);
      const candidate = json.candidates?.[0];
      const assistantMessage = parseAssistantMessage(candidate);
      return {
        text: assistantMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        sources: extractGroundingSources(candidate),
        finishReason: normalizeFinishReason(candidate?.finishReason),
        providerFinishReason: candidate?.finishReason,
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
    transcriptionModel: (modelId) => new VertexTranscriptionModel(modelId, baseURL, accessToken, fetcher),
    speechModel: (modelId) => new VertexSpeechModel(modelId, baseURL, accessToken, fetcher),
    groundedLanguageModel: (modelId) => new VertexGroundedLanguageModel(modelId, baseURL, accessToken, fetcher),
    rawFetch: fetcher
  });
};

export const vertexMcpTools = createMcpToolSet;
