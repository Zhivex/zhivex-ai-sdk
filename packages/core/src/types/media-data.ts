import type {
  FinishReason,
  TokenUsage
} from "./common.js";

export interface EmbedResult {
  embeddings: number[][];
  usage?: TokenUsage;
  rawResponse?: unknown;
}

export interface AudioInput {
  data: string | Uint8Array | ArrayBuffer;
  mediaType: string;
  filename?: string;
}

export interface MediaInput {
  data?: string | Uint8Array | ArrayBuffer;
  uri?: string;
  mediaType: string;
  filename?: string;
  providerMetadata?: Record<string, unknown>;
}

export type EmbedValue = string | MediaInput;

export interface GeneratedMedia {
  data?: Uint8Array;
  uri?: string;
  mediaType: string;
  text?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface TranscriptionResult {
  text: string;
  rawResponse?: unknown;
}

export interface SpeechResult {
  audio: Uint8Array;
  mediaType: string;
  rawResponse?: unknown;
}

export interface ImageGenerationResult {
  images: GeneratedMedia[];
  text?: string;
  rawResponse?: unknown;
}

export interface VideoGenerationResult {
  videos: GeneratedMedia[];
  operationName?: string;
  rawResponse?: unknown;
}

export interface MusicGenerationResult {
  audio: GeneratedMedia[];
  text?: string;
  rawResponse?: unknown;
}

export interface GroundingSource {
  title?: string;
  url: string;
  snippet?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface GroundedGenerateResult {
  text: string;
  sources: GroundingSource[];
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  rawResponse?: unknown;
}
