import {
  ConfigurationError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  decodeBase64WithLimit,
  readBodyWithLimit,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  resolveAudioResponseLimits,
  withRetry,
  withTimeoutSignal,
  type AudioInput,
  type AudioResponseLimits,
  type ImageGenerationModel,
  type ImageGenerationModelInput,
  type ImageGenerationResult,
  type MediaInput,
  type ModelCapabilities,
  type SpeechModel,
  type SpeechModelInput,
  type SpeechResult,
  type TranscriptionModel,
  type TranscriptionModelInput,
  type TranscriptionResult,
  type VideoGenerationModel,
  type VideoGenerationModelInput,
  type VideoGenerationResult
} from "@zhivex-ai/core/provider";

const mediaCapabilities = (kind: "image" | "video" | "speech" | "transcription"): ModelCapabilities => ({
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: kind === "image",
  files: false,
  audioInput: kind === "transcription",
  audioOutput: kind === "speech" || kind === "video",
  embeddings: false,
  imageGeneration: kind === "image",
  videoGeneration: kind === "video",
  fileSearch: false,
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
});

export const XAI_IMAGE_MODELS = [
  "grok-imagine-image",
  "grok-imagine-image-2.0",
  "grok-imagine-image-quality"
] as const;

export const XAI_VIDEO_MODELS = [
  "grok-imagine-video",
  "grok-imagine-video-1.5",
  "grok-imagine-video-1.5-lite"
] as const;

export const XAI_TEXT_TO_SPEECH_MODEL = "grok-tts";
export const XAI_SPEECH_TO_TEXT_MODEL = "grok-voice-transcribe-2.0";
export const XAI_SPEECH_TO_SPEECH_MODEL = "grok-voice-3.0";

/**
 * Deprecated xAI model ids and the migration to use instead.
 * `grok-imagine-image-quality` still resolves until its 2026-11-02 retirement.
 * See https://docs.x.ai/developers/migration/imagine-image-quality-nov-2.
 */
export const XAI_DEPRECATED_MODELS = Object.freeze({
  "grok-voice-2.0": "Deprecated speech-to-speech model. Use grok-voice-3.0.",
  "grok-imagine-image-quality":
    'Deprecated on 2026-09-02 and retired on 2026-11-02. Migrate to "grok-imagine-image-2.0" and set quality to "low", "medium", or "auto". After retirement, xAI serves this slug as "grok-imagine-image-2.0" with quality "low". This adapter keeps sending the slug, and the request shape stays the same.'
});

const IMAGE_ASPECT_RATIOS = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2",
  "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2", "auto"
]);
const VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2"]);
const IMAGE_RESOLUTIONS = new Set(["1k", "2k"]);
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);

export interface XAIImageGenerationOptions {
  resolution?: "1k" | "2k";
  quality?: "low" | "medium" | "auto";
  response_format?: "url" | "b64_json";
  [key: string]: unknown;
}

export interface XAIVideoGenerationOptions {
  resolution?: "480p" | "720p" | "1080p";
  [key: string]: unknown;
}

export interface XAISpeechOptions {
  language?: string;
  output_format?: { codec?: string; sample_rate?: number; bit_rate?: number };
  speed?: number;
  with_timestamps?: boolean;
  [key: string]: unknown;
}

export interface XAITranscriptionOptions {
  url?: string;
  format?: boolean;
  keyterm?: string | string[];
  diarize?: boolean;
  [key: string]: unknown;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const assertKnownModel = (modelId: string, allowed: readonly string[], label: string) => {
  if (!allowed.includes(modelId)) {
    throw new UnsupportedFeatureError(
      `Provider "xai" ${label} model "${modelId}" is not supported. Supported models: ${allowed.join(", ")}.`
    );
  }
};

export const assertXaiMediaRegion = (baseURL: string, feature: string) => {
  if (new URL(baseURL).hostname === "us.api.x.ai") {
    throw new UnsupportedFeatureError(
      `Provider "xai" US regional endpoint currently serves grok-4.7 and grok-4.6 text models only. ${feature} is not available there.`
    );
  }
};

const assertVoiceSelection = (kind: "speech" | "transcription", modelId: string) => {
  const id = modelId.trim().toLowerCase();
  if (id === "grok-voice-2.0") {
    throw new UnsupportedFeatureError(
      'Provider "xai" model "grok-voice-2.0" is deprecated. Speech-to-speech uses "grok-voice-3.0". Text-to-speech uses "grok-tts", and speech-to-text uses "grok-voice-transcribe-2.0".'
    );
  }
  if (kind === "speech" && id !== XAI_TEXT_TO_SPEECH_MODEL) {
    const hint = id === XAI_SPEECH_TO_SPEECH_MODEL
      ? ' "grok-voice-3.0" is the speech-to-speech model, not text-to-speech.'
      : "";
    throw new UnsupportedFeatureError(
      `Provider "xai" text-to-speech model is "${XAI_TEXT_TO_SPEECH_MODEL}".${hint}`
    );
  }
  if (kind === "transcription" && id !== XAI_SPEECH_TO_TEXT_MODEL) {
    const hint = id === XAI_SPEECH_TO_SPEECH_MODEL
      ? ' "grok-voice-3.0" is the speech-to-speech model, not speech-to-text.'
      : "";
    throw new UnsupportedFeatureError(
      `Provider "xai" speech-to-text model is "${XAI_SPEECH_TO_TEXT_MODEL}".${hint}`
    );
  }
};

const jsonHeaders = (apiKey: string) => ({
  "content-type": "application/json",
  authorization: `Bearer ${apiKey}`
});

const readJson = async (response: Response, endpoint: string, maxBytes: number, errorBodyBytes: number) => {
  if (!response.ok && response.status !== 202) {
    const body = await readErrorBodyWithLimit(response, errorBodyBytes);
    throw new ProviderHTTPError(`xAI request failed with status ${response.status}.`, response.status, {
      responseBody: body
    });
  }
  return readJsonWithLimit<any>(response, {
    maxBytes,
    provider: "xai",
    endpoint
  });
};

const mediaUrl = (input: MediaInput) => {
  if (typeof input.uri === "string" && input.uri.trim()) return input.uri;
  if (typeof input.data === "string" && input.data.trim()) {
    return input.data.startsWith("data:") ? input.data : `data:${input.mediaType};base64,${input.data}`;
  }
  if (input.data instanceof Uint8Array || input.data instanceof ArrayBuffer) {
    const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return `data:${input.mediaType};base64,${Buffer.from(copy).toString("base64")}`;
  }
  throw new ConfigurationError('Provider "xai" media input requires uri or data.');
};

const imageReference = (input: MediaInput) => {
  const fileId = input.providerMetadata?.file_id;
  if (typeof fileId === "string" && fileId.trim()) return { file_id: fileId };
  return { url: mediaUrl(input), type: "image_url" as const };
};

const omit = (options: Record<string, unknown>, keys: string[]) => {
  const copy = { ...options };
  for (const key of keys) delete copy[key];
  return copy;
};

const bytesFromAudio = (audio: AudioInput) => {
  if (audio.data instanceof Uint8Array) return audio.data;
  if (audio.data instanceof ArrayBuffer) return new Uint8Array(audio.data);
  if (typeof audio.data !== "string" || !audio.data.trim()) {
    throw new ConfigurationError('Provider "xai" transcription requires audio bytes or providerOptions.url.');
  }
  return Uint8Array.from(Buffer.from(audio.data, "base64"));
};

export class XAIImageGenerationModel implements ImageGenerationModel<XAIImageGenerationOptions> {
  readonly provider = "xai";
  readonly capabilities = mediaCapabilities("image");

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {
    assertKnownModel(modelId, XAI_IMAGE_MODELS, "image");
    assertXaiMediaRegion(baseURL, "Image generation");
  }

  async generateImage(input: ImageGenerationModelInput<XAIImageGenerationOptions>): Promise<ImageGenerationResult> {
    if (input.negativePrompt !== undefined) {
      throw new UnsupportedFeatureError('Provider "xai" image generation does not support negativePrompt.');
    }
    if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1 || input.count > 10)) {
      throw new UnsupportedFeatureError('Provider "xai" image generation count must be an integer from 1 to 10.');
    }
    if (input.aspectRatio !== undefined && !IMAGE_ASPECT_RATIOS.has(input.aspectRatio)) {
      throw new UnsupportedFeatureError(`Provider "xai" does not support image aspect ratio "${input.aspectRatio}".`);
    }
    const options = { ...(input.providerOptions ?? {}) };
    const pollIntervalMs = typeof options.pollIntervalMs === "number" ? options.pollIntervalMs : 1_000;
    const resolution = options.resolution ?? (input.size === "1k" || input.size === "2k" ? input.size : undefined);
    if (input.size !== undefined && resolution === undefined) {
      throw new UnsupportedFeatureError('Provider "xai" image size must be "1k" or "2k". Use resolution for output size.');
    }
    if (resolution !== undefined && !IMAGE_RESOLUTIONS.has(String(resolution))) {
      throw new UnsupportedFeatureError('Provider "xai" image resolution must be "1k" or "2k".');
    }
    if (options.quality !== undefined && this.modelId !== "grok-imagine-image-2.0") {
      throw new UnsupportedFeatureError('Provider "xai" image quality is supported only for "grok-imagine-image-2.0".');
    }
    if (options.quality !== undefined && !["low", "medium", "auto"].includes(String(options.quality))) {
      throw new UnsupportedFeatureError('Provider "xai" image quality must be "low", "medium", or "auto".');
    }
    const images = input.images ?? [];
    const body: Record<string, unknown> = {
      ...omit(options, ["model", "prompt", "n", "aspect_ratio", "resolution", "quality", "response_format", "image", "images", "pollIntervalMs"]),
      model: this.modelId,
      prompt: input.prompt,
      ...(input.count !== undefined ? { n: input.count } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
      ...(options.response_format !== undefined ? { response_format: options.response_format } : {})
    };
    const endpoint = images.length > 0 ? "images/edits" : "images/generations";
    if (images.length === 1) body.image = imageReference(images[0]!);
    if (images.length > 1) body.images = images.map(imageReference);

    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/${endpoint}`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            redirect: "error",
            signal,
            body: JSON.stringify(body)
          }),
        input
      );
      let json = await readJson(response, endpoint, 32 * 1024 * 1024, 64 * 1024);
      if (!Array.isArray(json.data) && typeof json.request_id === "string") {
        json = await this.pollImage(json.request_id, input, signal, pollIntervalMs);
      }
      const data = Array.isArray(json.data) ? json.data : [];
      if (data.length === 0) {
        throw new ProviderHTTPError("xAI image generation returned no images.", response.status || 502, { responseBody: json });
      }
      return {
        images: data.map((item: any) => ({
          uri: typeof item.url === "string" ? item.url : undefined,
          data: typeof item.b64_json === "string"
            ? decodeBase64WithLimit(item.b64_json, { maxBytes: 32 * 1024 * 1024, provider: "xai", endpoint })
            : undefined,
          mediaType: item.mime_type ?? input.outputMimeType ?? "image/jpeg",
          providerMetadata: item
        })),
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }

  private async pollImage(
    requestId: string,
    input: ImageGenerationModelInput<XAIImageGenerationOptions>,
    signal: AbortSignal,
    pollIntervalMs: number
  ) {
    const timeoutMs = input.timeoutMs ?? 120_000;
    const started = Date.now();
    let json: any = { status: "pending", request_id: requestId };
    while (json.status !== "done" && json.status !== "failed") {
      if (Date.now() - started >= timeoutMs) {
        throw new ProviderHTTPError(`xAI image generation timed out after ${timeoutMs}ms.`, 408);
      }
      await sleep(pollIntervalMs, signal);
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/images/${encodeURIComponent(requestId)}`, {
            method: "GET",
            headers: { authorization: `Bearer ${this.apiKey}` },
            redirect: "error",
            signal
          }),
        input
      );
      json = await readJson(response, "images/result", 32 * 1024 * 1024, 64 * 1024);
    }
    if (json.status === "failed") {
      throw new ProviderHTTPError(
        `xAI image generation failed${json.error?.message ? `: ${json.error.message}` : "."}`,
        502,
        { responseBody: json }
      );
    }
    return json;
  }
}

export class XAIVideoGenerationModel implements VideoGenerationModel<XAIVideoGenerationOptions> {
  readonly provider = "xai";
  readonly capabilities = mediaCapabilities("video");

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch
  ) {
    assertKnownModel(modelId, XAI_VIDEO_MODELS, "video");
    assertXaiMediaRegion(baseURL, "Video generation");
  }

  async generateVideo(input: VideoGenerationModelInput<XAIVideoGenerationOptions>): Promise<VideoGenerationResult> {
    if (input.negativePrompt !== undefined) {
      throw new UnsupportedFeatureError('Provider "xai" video generation does not support negativePrompt.');
    }
    if (input.count !== undefined && input.count !== 1) {
      throw new UnsupportedFeatureError('Provider "xai" video generation accepts one video per request.');
    }
    if (input.outputStorageUri !== undefined) {
      throw new UnsupportedFeatureError('Provider "xai" video generation does not support outputStorageUri.');
    }
    if (
      input.durationSeconds !== undefined &&
      (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 15)
    ) {
      throw new UnsupportedFeatureError('Provider "xai" video durationSeconds must be an integer from 1 to 15.');
    }
    if (input.aspectRatio !== undefined && !VIDEO_ASPECT_RATIOS.has(input.aspectRatio)) {
      throw new UnsupportedFeatureError(`Provider "xai" does not support video aspect ratio "${input.aspectRatio}".`);
    }
    const options = { ...(input.providerOptions ?? {}) };
    if (options.resolution !== undefined && !VIDEO_RESOLUTIONS.has(String(options.resolution))) {
      throw new UnsupportedFeatureError('Provider "xai" video resolution must be "480p", "720p", or "1080p".');
    }
    if (this.modelId === "grok-imagine-video" && options.resolution === "1080p") {
      throw new UnsupportedFeatureError('Provider "xai" model "grok-imagine-video" supports video resolutions up to 720p.');
    }
    const body: Record<string, unknown> = {
      ...omit(options, ["model", "prompt", "duration", "aspect_ratio", "image", "resolution"]),
      model: this.modelId,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.durationSeconds !== undefined ? { duration: input.durationSeconds } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(options.resolution !== undefined ? { resolution: options.resolution } : {}),
      ...(input.image ? { image: imageReference(input.image) } : {})
    };
    const timeoutMs = input.timeoutMs ?? 600_000;
    const { signal, cleanup } = withTimeoutSignal({ ...input, timeoutMs });
    const started = Date.now();
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/videos/generations`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            redirect: "error",
            signal,
            body: JSON.stringify(body)
          }),
        { ...input, maxRetries: input.maxRetries ?? 0 }
      );
      let json = await readJson(response, "videos/generations", 1024 * 1024, 64 * 1024);
      const requestId = typeof json.request_id === "string" ? json.request_id : undefined;
      while (json.status !== "done" && json.status !== "failed") {
        if (!requestId) {
          throw new ProviderHTTPError("xAI video generation returned no request id.", response.status || 502, {
            responseBody: json
          });
        }
        if (Date.now() - started >= timeoutMs) {
          throw new ProviderHTTPError(`xAI video generation timed out after ${timeoutMs}ms.`, 408);
        }
        await sleep(input.pollIntervalMs ?? 5_000, signal);
        const poll = await withRetry(
          () =>
            this.fetcher(`${this.baseURL}/videos/${encodeURIComponent(requestId)}`, {
              method: "GET",
              headers: { authorization: `Bearer ${this.apiKey}` },
              redirect: "error",
              signal
            }),
          input
        );
        json = await readJson(poll, "videos/result", 1024 * 1024, 64 * 1024);
      }
      if (json.status === "failed" || typeof json.video?.url !== "string") {
        throw new ProviderHTTPError(
          `xAI video generation failed${json.error?.message ? `: ${json.error.message}` : "."}`,
          502,
          { responseBody: json }
        );
      }
      return {
        videos: [{ uri: json.video.url, mediaType: "video/mp4", providerMetadata: json.video }],
        operationName: requestId,
        rawResponse: json
      };
    } finally {
      cleanup();
    }
  }
}

export class XAISpeechModel implements SpeechModel<XAISpeechOptions> {
  readonly provider = "xai";
  readonly capabilities = mediaCapabilities("speech");

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly responseLimits: ReturnType<typeof resolveAudioResponseLimits>
  ) {
    assertVoiceSelection("speech", modelId);
    assertXaiMediaRegion(baseURL, "Text to speech");
  }

  async generateSpeech(input: SpeechModelInput<XAISpeechOptions>): Promise<SpeechResult> {
    if (!input.input.trim()) {
      throw new ConfigurationError('Provider "xai" text-to-speech requires text.');
    }
    if (input.input.length > 60_000) {
      throw new UnsupportedFeatureError('Provider "xai" text-to-speech accepts at most 60000 characters.');
    }
    const options = { ...(input.providerOptions ?? {}) };
    const language = typeof options.language === "string" ? options.language : "en";
    const { signal, cleanup, abort } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/tts`, {
            method: "POST",
            headers: jsonHeaders(this.apiKey),
            redirect: "error",
            signal,
            body: JSON.stringify({
              ...omit(options, ["model", "text", "voice_id", "language"]),
              text: input.input,
              voice_id: input.voice ?? "eve",
              language
            })
          }),
        input
      );
      if (!response.ok) {
        const body = await readErrorBodyWithLimit(response, this.responseLimits.errorBodyBytes);
        throw new ProviderHTTPError(`xAI request failed with status ${response.status}.`, response.status, {
          responseBody: body
        });
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("json") || options.with_timestamps === true) {
        const json = await readJsonWithLimit<any>(response, {
          maxBytes: this.responseLimits.speechJsonBytes,
          provider: "xai",
          endpoint: "tts",
          abort
        });
        if (typeof json.audio !== "string") {
          throw new ProviderHTTPError("xAI text-to-speech response did not contain audio.", 502, { responseBody: json });
        }
        return {
          audio: decodeBase64WithLimit(json.audio, {
            maxBytes: this.responseLimits.speechBytes,
            provider: "xai",
            endpoint: "tts",
            abort
          }),
          mediaType: contentType.includes("json") ? "audio/mpeg" : contentType,
          rawResponse: { ...json, audio: undefined }
        };
      }
      return {
        audio: await readBodyWithLimit(response, {
          maxBytes: this.responseLimits.speechBytes,
          provider: "xai",
          endpoint: "tts",
          abort
        }),
        mediaType: contentType || "audio/mpeg"
      };
    } finally {
      cleanup();
    }
  }
}

export class XAITranscriptionModel implements TranscriptionModel<XAITranscriptionOptions> {
  readonly provider = "xai";
  readonly capabilities = mediaCapabilities("transcription");

  constructor(
    readonly modelId: string,
    private readonly apiKey: string,
    private readonly baseURL: string,
    private readonly fetcher: typeof globalThis.fetch,
    private readonly responseLimits: ReturnType<typeof resolveAudioResponseLimits>
  ) {
    assertVoiceSelection("transcription", modelId);
    assertXaiMediaRegion(baseURL, "Speech to text");
  }

  async transcribe(input: TranscriptionModelInput<XAITranscriptionOptions>): Promise<TranscriptionResult> {
    if (input.prompt !== undefined) {
      throw new UnsupportedFeatureError(
        'Provider "xai" speech-to-text does not support prompt. Pass key terms through providerOptions.keyterm.'
      );
    }
    const options = { ...(input.providerOptions ?? {}) };
    const remoteUrl = typeof options.url === "string" ? options.url : undefined;
    const form = new FormData();
    form.set("model", this.modelId);
    if (input.language) form.set("language", input.language);
    for (const [key, value] of Object.entries(omit(options, ["model", "file", "url", "language"]))) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) form.append(key, String(item));
      } else if (typeof value === "string") {
        form.set(key, value);
      } else {
        form.set(key, JSON.stringify(value));
      }
    }
    if (remoteUrl) {
      form.set("url", remoteUrl);
    } else {
      const bytes = bytesFromAudio(input.audio);
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      form.set("file", new File([copy], input.audio.filename ?? "audio", { type: input.audio.mediaType }));
    }
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(
        () =>
          this.fetcher(`${this.baseURL}/stt`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}` },
            redirect: "error",
            signal,
            body: form
          }),
        input
      );
      const json = await readJson(response, "stt", this.responseLimits.transcriptionBytes, this.responseLimits.errorBodyBytes);
      return { text: typeof json.text === "string" ? json.text : "", rawResponse: json };
    } finally {
      cleanup();
    }
  }
}

export const createXAIMedia = (config: {
  apiKey: string;
  baseURL: string;
  fetcher: typeof globalThis.fetch;
  responseLimits?: AudioResponseLimits;
}) => {
  const limits = resolveAudioResponseLimits(config.responseLimits);
  return {
    imageGenerationModel: (modelId: string) =>
      new XAIImageGenerationModel(modelId, config.apiKey, config.baseURL, config.fetcher),
    videoGenerationModel: (modelId: string) =>
      new XAIVideoGenerationModel(modelId, config.apiKey, config.baseURL, config.fetcher),
    speechModel: (modelId: string) =>
      new XAISpeechModel(modelId, config.apiKey, config.baseURL, config.fetcher, limits),
    transcriptionModel: (modelId: string) =>
      new XAITranscriptionModel(modelId, config.apiKey, config.baseURL, config.fetcher, limits)
  };
};
