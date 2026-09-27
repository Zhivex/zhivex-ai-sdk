import {
  ProviderHTTPError,
  UnsupportedFeatureError,
  readBodyWithLimit,
  readErrorBodyWithLimit,
  resolveAudioResponseLimits,
  withRetry,
  withTimeoutSignal,
  type AudioInput,
  type EmbedInput,
  type EmbedResult,
  type EmbeddingModel,
  type SpeechModel,
  type SpeechResult,
  type TranscriptionModel,
  type TranscriptionResult
} from "@zhivex-ai/core/provider";
import { capabilities, speechCapabilities, transcriptionCapabilities } from "./capabilities.js";
import { jsonHeaders, parseJson } from "./http.js";

export const toUint8Array = (data: AudioInput["data"]) => {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return Uint8Array.from(Buffer.from(data, "base64"));
};

const createAudioFile = (audio: AudioInput) => {
  const bytes = toUint8Array(audio.data);
  return new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], audio.filename ?? "audio", {
    type: audio.mediaType
  });
};

export class OpenAIEmbeddingModel implements EmbeddingModel {
  readonly provider = "openai";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {}

  async embed(input: EmbedInput & { abortSignal?: AbortSignal; timeoutMs?: number; maxRetries?: number; retryBackoffMs?: number }): Promise<EmbedResult> {
    const { signal, cleanup } = withTimeoutSignal(input);
    const values = input.values.map((value) => {
      if (typeof value !== "string") {
        throw new UnsupportedFeatureError('Provider "openai" does not support multimodal embedding values.');
      }
      return value;
    });

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/embeddings`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              model: this.modelId,
              input: values
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

export class OpenAITranscriptionModel implements TranscriptionModel {
  readonly provider = "openai";
  readonly capabilities = transcriptionCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly responseLimits: ReturnType<typeof resolveAudioResponseLimits> = resolveAudioResponseLimits()
  ) {}

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
    const { signal, cleanup, abort } = withTimeoutSignal(input);
    const form = new FormData();
    for (const [key, value] of Object.entries(input.providerOptions ?? {})) {
      if (["model", "file", "prompt", "language"].includes(key)) {
        continue;
      }
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    form.set("model", this.modelId);
    form.set("file", createAudioFile(input.audio));
    if (input.prompt) {
      form.set("prompt", input.prompt);
    }
    if (input.language) {
      form.set("language", input.language);
    }

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/audio/transcriptions`, {
            method: "POST",
            redirect: "error",
            headers: { authorization: `Bearer ${this.apiKey}` },
            signal,
            body: form
          }),
        input
      );

      const json = await parseJson(response, {
        maxBytes: this.responseLimits.transcriptionBytes,
        errorBodyBytes: this.responseLimits.errorBodyBytes,
        endpoint: "audio/transcriptions",
        abort
      });
      return {
        text: json.text ?? "",
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

export class OpenAISpeechModel implements SpeechModel {
  readonly provider = "openai";
  readonly capabilities = speechCapabilities;

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly responseLimits: ReturnType<typeof resolveAudioResponseLimits> = resolveAudioResponseLimits()
  ) {}

  async generateSpeech(input: {
    input: string;
    voice?: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number;
    providerOptions?: Record<string, unknown>;
  }): Promise<SpeechResult> {
    const { signal, cleanup, abort } = withTimeoutSignal(input);

    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/audio/speech`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            signal,
            body: JSON.stringify({
              ...input.providerOptions,
              model: this.modelId,
              input: input.input,
              voice: input.voice ?? "alloy"
            })
          }),
        input
      );

      if (!response.ok) {
        const body = await readErrorBodyWithLimit(response, this.responseLimits.errorBodyBytes);
        throw new ProviderHTTPError(`OpenAI request failed with status ${response.status}.`, response.status, {
          responseBody: body
        });
      }

      return {
        audio: await readBodyWithLimit(response, {
          maxBytes: this.responseLimits.speechBytes,
          provider: "openai",
          endpoint: "audio/speech",
          abort
        }),
        mediaType: response.headers.get("content-type") ?? "audio/mpeg",
        rawResponse: undefined
      };
    } finally {
      cleanup();
    }
  }
}

