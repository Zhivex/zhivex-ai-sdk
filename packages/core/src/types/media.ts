import type {
  ModelCapabilities,
  ProviderOptions,
  ReasoningConfig,
  RetryOptions
} from "./common.js";
import type {
  GenerateInputSource
} from "./messages.js";
import type {
  AudioInput,
  EmbedResult,
  EmbedValue,
  GroundedGenerateResult,
  ImageGenerationResult,
  MediaInput,
  MusicGenerationResult,
  SpeechResult,
  TranscriptionResult,
  VideoGenerationResult
} from "./media-data.js";

export interface TranscriptionModelInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  audio: AudioInput;
  prompt?: string;
  language?: string;
  providerOptions?: TProviderOptions;
}

export interface SpeechModelInput<TProviderOptions extends ProviderOptions = ProviderOptions> extends RetryOptions {
  input: string;
  voice?: string;
  providerOptions?: TProviderOptions;
}

export type GroundedModelGenerateInput<TProviderOptions extends ProviderOptions = ProviderOptions> = RetryOptions &
  GenerateInputSource & {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;
  providerOptions?: TProviderOptions;
};

export interface TranscriptionModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  transcribe(input: TranscriptionModelInput<TProviderOptions>): Promise<TranscriptionResult>;
}

export interface SpeechModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generateSpeech(input: SpeechModelInput<TProviderOptions>): Promise<SpeechResult>;
  streamSpeech?(input: SpeechModelInput<TProviderOptions>): Promise<AsyncIterable<SpeechResult>>;
}

export interface ImageGenerationModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generateImage(input: ImageGenerationModelInput<TProviderOptions>): Promise<ImageGenerationResult>;
}

export interface VideoGenerationModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generateVideo(input: VideoGenerationModelInput<TProviderOptions>): Promise<VideoGenerationResult>;
}

export interface MusicGenerationModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generateMusic(input: MusicGenerationModelInput<TProviderOptions>): Promise<MusicGenerationResult>;
}

export interface GroundedLanguageModel<TProviderOptions extends ProviderOptions = ProviderOptions> {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  generate(input: GroundedModelGenerateInput<TProviderOptions>): Promise<GroundedGenerateResult>;
}

export interface EmbeddingModel {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
  embed(input: EmbedInput & RetryOptions): Promise<EmbedResult>;
}

export type TranscribeAudioOptions<TModel extends TranscriptionModel = TranscriptionModel> = RetryOptions & {
  model: TModel;
  audio: AudioInput;
  prompt?: string;
  language?: string;
  providerOptions?: TModel extends TranscriptionModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions;
};

export interface TranscriptionOutput extends TranscriptionResult {
  audio: AudioInput;
}

export type GenerateSpeechOptions<TModel extends SpeechModel = SpeechModel> = RetryOptions & {
  model: TModel;
  input: string;
  voice?: string;
  providerOptions?: TModel extends SpeechModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions;
};

export type StreamSpeechOptions<TModel extends SpeechModel = SpeechModel> = GenerateSpeechOptions<TModel>;

export interface SpeechOutput extends SpeechResult {
  input: string;
}

export interface ImageGenerationModelInput<TProviderOptions extends ProviderOptions = ProviderOptions>
  extends RetryOptions {
  prompt: string;
  images?: MediaInput[];
  count?: number;
  aspectRatio?: string;
  size?: string;
  negativePrompt?: string;
  outputMimeType?: string;
  providerOptions?: TProviderOptions;
}

export interface VideoGenerationModelInput<TProviderOptions extends ProviderOptions = ProviderOptions>
  extends RetryOptions {
  prompt: string;
  image?: MediaInput;
  count?: number;
  aspectRatio?: string;
  negativePrompt?: string;
  durationSeconds?: number;
  outputStorageUri?: string;
  pollIntervalMs?: number;
  providerOptions?: TProviderOptions;
}

export interface MusicGenerationModelInput<TProviderOptions extends ProviderOptions = ProviderOptions>
  extends RetryOptions {
  prompt: string;
  images?: MediaInput[];
  negativePrompt?: string;
  outputMimeType?: string;
  providerOptions?: TProviderOptions;
}

export type GenerateImageOptions<TModel extends ImageGenerationModel = ImageGenerationModel> =
  ImageGenerationModelInput<TModel extends ImageGenerationModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export interface GenerateImageOutput extends ImageGenerationResult {
  prompt: string;
}

export type GenerateVideoOptions<TModel extends VideoGenerationModel = VideoGenerationModel> =
  VideoGenerationModelInput<TModel extends VideoGenerationModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export interface GenerateVideoOutput extends VideoGenerationResult {
  prompt: string;
}

export type GenerateMusicOptions<TModel extends MusicGenerationModel = MusicGenerationModel> =
  MusicGenerationModelInput<TModel extends MusicGenerationModel<infer TProviderOptions> ? TProviderOptions : ProviderOptions> & {
    model: TModel;
  };

export interface GenerateMusicOutput extends MusicGenerationResult {
  prompt: string;
}

export interface EmbedInput {
  values: EmbedValue[];
  /** Provider-specific embedding configuration. */
  providerOptions?: ProviderOptions;
}

export interface EmbedOptions extends RetryOptions {
  model: EmbeddingModel;
  value: EmbedValue | EmbedValue[];
  /** Provider-specific embedding configuration. */
  providerOptions?: ProviderOptions;
}

export interface EmbedOutput extends EmbedResult {
  values: EmbedValue[];
}
