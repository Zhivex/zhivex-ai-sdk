import { toJSONSchema } from "zod";

import {
  CallbackRealtimeSession,
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  createMcpToolSet,
  createProviderAdapter,
  encodeAudioFrame,
  encodeMediaFrame,
  isCallableToolDefinition,
  isHostedToolDefinition,
  normalizeFinishReason,
  openWebSocketConnection,
  streamSSE,
  toToolSet,
  toolResultPayload,
  unsupportedBrowserToken,
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
  type JsonValue,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter,
  type RealtimeConnectOptions,
  type RealtimeConnectionFactory,
  type RealtimeModel,
  type RealtimeSessionConfig,
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
  realtimeURL?: string;
  realtimeConnectionFactory?: RealtimeConnectionFactory;
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
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-b",
    toolChoiceNone: true,
    approvalRequests: false,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: true,
    toolsets: false
  }
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
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: false,
    approvalRequests: false,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false
  }
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

const realtimeCapabilities: ModelCapabilities = {
  ...capabilities,
  streaming: false,
  audioInput: true,
  audioOutput: true,
  realtime: {
    sessions: true,
    audioInput: true,
    audioOutput: true,
    imageInput: true,
    tools: true,
    browserTokens: false
  }
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

const mapRealtimeProviderOptions = (providerOptions: Record<string, unknown> | undefined) =>
  providerOptions
    ? Object.fromEntries(
        Object.entries(providerOptions).filter(([key]) => !["headers", "realtime_url"].includes(key))
      )
    : {};

const vertexRealtimeURL = (
  location: string,
  apiVersion: string,
  providerOptions?: Record<string, unknown>,
  override?: string
) => {
  const candidate = override ?? (typeof providerOptions?.realtime_url === "string" ? providerOptions.realtime_url : undefined);
  return candidate || `wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.${apiVersion}.PredictionService.BidiGenerateContent`;
};

const vertexRealtimeHeaders = (accessToken: string, providerOptions?: Record<string, unknown>) => ({
  authorization: `Bearer ${accessToken}`,
  ...(typeof providerOptions?.headers === "object" && providerOptions.headers && !Array.isArray(providerOptions.headers)
    ? Object.fromEntries(
        Object.entries(providerOptions.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)])
      )
    : {})
});

const vertexRealtimeSetup = (config: RealtimeSessionConfig, modelId: string) => ({
  setup: {
    model: `models/${modelId}`,
    generationConfig: {
      ...(config.voice
        ? {
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: config.voice
                }
              }
            }
          }
        : {}),
      responseModalities: config.outputAudioMediaType ? ["AUDIO"] : ["TEXT"]
    },
    ...(config.instructions
      ? {
          systemInstruction: {
            parts: [{ text: config.instructions }]
          }
        }
      : {}),
    ...(mapTools(toToolSet(config.tools)) ? { tools: mapTools(toToolSet(config.tools)) } : {}),
    ...mapRealtimeProviderOptions(config.providerOptions as Record<string, unknown> | undefined)
  }
});

const parseVertexRealtimeEvent = (payload: Record<string, unknown>) => {
  if ("setupComplete" in payload) {
    return [];
  }

  const serverContent =
    typeof payload.serverContent === "object" && payload.serverContent
      ? (payload.serverContent as Record<string, unknown>)
      : typeof payload.server_content === "object" && payload.server_content
        ? (payload.server_content as Record<string, unknown>)
        : undefined;
  if (serverContent) {
    const modelTurn =
      typeof serverContent.modelTurn === "object" && serverContent.modelTurn
        ? (serverContent.modelTurn as Record<string, unknown>)
        : typeof serverContent.model_turn === "object" && serverContent.model_turn
          ? (serverContent.model_turn as Record<string, unknown>)
          : {};
    const parts = Array.isArray(modelTurn.parts) ? modelTurn.parts : [];
    const events = [];

    for (const part of parts) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const typedPart = part as Record<string, unknown>;
      if (typeof typedPart.text === "string" && typedPart.text) {
        events.push({
          type: "realtime-text-delta" as const,
          textDelta: typedPart.text,
          providerMetadata: payload as Record<string, JsonValue>
        });
      }
      const inline =
        typeof typedPart.inlineData === "object" && typedPart.inlineData
          ? (typedPart.inlineData as Record<string, unknown>)
          : typeof typedPart.inline_data === "object" && typedPart.inline_data
            ? (typedPart.inline_data as Record<string, unknown>)
            : undefined;
      if (inline && typeof inline.data === "string" && inline.data) {
        events.push({
          type: "realtime-audio-output" as const,
          audio: Buffer.from(inline.data, "base64"),
          mediaType: typeof inline.mimeType === "string" ? inline.mimeType : typeof inline.mime_type === "string" ? inline.mime_type : "audio/pcm",
          providerMetadata: payload as Record<string, JsonValue>
        });
      }
      if (typedPart.functionCall && typeof typedPart.functionCall === "object") {
        const call = typedPart.functionCall as Record<string, unknown>;
        events.push({
          type: "realtime-tool-call" as const,
          toolCall: {
            id: typeof call.id === "string" ? call.id : `${String(call.name ?? "")}-0`,
            name: String(call.name ?? ""),
            input: (call.args ?? {}) as JsonValue
          }
        });
      }
    }

    const inputTranscription =
      typeof serverContent.inputTranscription === "object" && serverContent.inputTranscription
        ? (serverContent.inputTranscription as Record<string, unknown>)
        : typeof serverContent.input_transcription === "object" && serverContent.input_transcription
          ? (serverContent.input_transcription as Record<string, unknown>)
          : undefined;
    if (inputTranscription && typeof inputTranscription.text === "string" && inputTranscription.text) {
      events.push({
        type: "realtime-transcript" as const,
        text: inputTranscription.text,
        role: "user" as const,
        isFinal: Boolean(serverContent.turnComplete ?? serverContent.turn_complete),
        providerMetadata: payload as Record<string, JsonValue>
      });
    }

    const outputTranscription =
      typeof serverContent.outputTranscription === "object" && serverContent.outputTranscription
        ? (serverContent.outputTranscription as Record<string, unknown>)
        : typeof serverContent.output_transcription === "object" && serverContent.output_transcription
          ? (serverContent.output_transcription as Record<string, unknown>)
          : undefined;
    if (outputTranscription && typeof outputTranscription.text === "string" && outputTranscription.text) {
      events.push({
        type: "realtime-transcript" as const,
        text: outputTranscription.text,
        role: "assistant" as const,
        isFinal: Boolean(serverContent.turnComplete ?? serverContent.turn_complete),
        providerMetadata: payload as Record<string, JsonValue>
      });
    }

    if (serverContent.generationComplete || serverContent.generation_complete) {
      events.push({
        type: "realtime-response-complete" as const,
        reason: "generation-complete",
        providerMetadata: payload as Record<string, JsonValue>
      });
    }
    if (serverContent.turnComplete || serverContent.turn_complete) {
      events.push({
        type: "realtime-response-complete" as const,
        reason: "turn-complete",
        providerMetadata: payload as Record<string, JsonValue>
      });
    }

    return events;
  }

  const sessionResumption =
    typeof payload.sessionResumptionUpdate === "object" && payload.sessionResumptionUpdate
      ? (payload.sessionResumptionUpdate as Record<string, unknown>)
      : typeof payload.session_resumption_update === "object" && payload.session_resumption_update
        ? (payload.session_resumption_update as Record<string, unknown>)
        : undefined;
  if (sessionResumption) {
    return [
      {
        type: "realtime-session-resumption" as const,
        handle:
          typeof sessionResumption.newHandle === "string"
            ? sessionResumption.newHandle
            : typeof sessionResumption.new_handle === "string"
              ? sessionResumption.new_handle
              : undefined,
        resumable: typeof sessionResumption.resumable === "boolean" ? sessionResumption.resumable : undefined,
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }

  const goAway =
    typeof payload.goAway === "object" && payload.goAway
      ? (payload.goAway as Record<string, unknown>)
      : typeof payload.go_away === "object" && payload.go_away
        ? (payload.go_away as Record<string, unknown>)
        : undefined;
  if (goAway) {
    return [
      {
        type: "realtime-go-away" as const,
        timeLeftMs:
          typeof goAway.timeLeftMs === "number"
            ? goAway.timeLeftMs
            : typeof goAway.time_left_ms === "number"
              ? goAway.time_left_ms
              : undefined,
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }

  if (payload.error && typeof payload.error === "object") {
    return [
      {
        type: "realtime-end" as const,
        reason: "error",
        providerMetadata: payload as Record<string, JsonValue>
      }
    ];
  }

  return [];
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

class VertexRealtimeModel implements RealtimeModel {
  readonly provider = "vertex";
  readonly capabilities = realtimeCapabilities;

  constructor(
    readonly modelId: string,
    private readonly accessToken: string,
    private readonly location: string,
    private readonly apiVersion: string,
    private readonly connectionFactory?: RealtimeConnectionFactory,
    private readonly realtimeURL?: string
  ) {}

  async connect(config: RealtimeSessionConfig = {}, options?: RealtimeConnectOptions) {
    const providerOptions = (config.providerOptions ?? {}) as Record<string, unknown>;
    const connection = await (this.connectionFactory ?? openWebSocketConnection)(
      vertexRealtimeURL(this.location, this.apiVersion, providerOptions, this.realtimeURL),
      vertexRealtimeHeaders(this.accessToken, providerOptions),
      options
    );
    const session = new CallbackRealtimeSession({
      provider: this.provider,
      modelId: this.modelId,
      capabilities: this.capabilities,
      config,
      connection,
      callbacks: {
        parseEvent: parseVertexRealtimeEvent,
        buildAudioPayloads: (frame) => [
          {
            realtimeInput: {
              audio: {
                mimeType: frame.mediaType,
                data: encodeAudioFrame(frame)
              }
            }
          }
        ],
        buildMediaPayloads: (frame) => [
          {
            realtimeInput: {
              media: {
                mimeType: frame.mediaType,
                data: encodeMediaFrame(frame)
              }
            }
          }
        ],
        buildTextPayloads: (text) => [
          {
            clientContent: {
              turns: [
                {
                  role: "user",
                  parts: [{ text }]
                }
              ],
              turnComplete: true
            }
          }
        ],
        buildToolResultPayloads: (result) => [
          {
            toolResponse: {
              functionResponses: [
                {
                  id: result.toolCallId,
                  name: result.toolName,
                  response: toolResultPayload(result)
                }
              ]
            }
          }
        ],
        buildUpdatePayloads: (sessionConfig) => [vertexRealtimeSetup(sessionConfig, this.modelId)],
        buildInitialPayloads: (sessionConfig) => [vertexRealtimeSetup(sessionConfig, this.modelId)]
      }
    });
    await session.initialize();
    return session;
  }

  async createBrowserToken() {
    return unsupportedBrowserToken();
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
    realtimeModel: (modelId) =>
      new VertexRealtimeModel(
        modelId,
        accessToken,
        location,
        apiVersion,
        options.realtimeConnectionFactory,
        options.realtimeURL
      ),
    groundedLanguageModel: (modelId) => new VertexGroundedLanguageModel(modelId, baseURL, accessToken, fetcher),
    rawFetch: fetcher
  });
};

export const vertexMcpTools = createMcpToolSet;
