import type {
  AgentCapabilities,
  ModelCapabilities,
  ReasoningConfig
} from "./types.js";

/**
 * Describes how a model exposes a capability.
 *
 * `prompted` means that the SDK can provide the behavior through prompting
 * rather than a provider-native API. `model-dependent` preserves conditional
 * support that the legacy boolean contract cannot represent.
 */
export const MODEL_CAPABILITY_SUPPORT_LEVELS = [
  "unsupported",
  "native",
  "prompted",
  "model-dependent"
] as const;

export type ModelCapabilitySupportLevel =
  (typeof MODEL_CAPABILITY_SUPPORT_LEVELS)[number];

export type ModelCapabilityKind =
  | "language"
  | "embedding"
  | "transcription"
  | "speech"
  | "image-generation"
  | "video-generation"
  | "music-generation"
  | "realtime";

export type LanguageModelCapabilityFeature =
  | "streaming"
  | "tools"
  | "structuredOutput"
  | "jsonMode"
  | "toolChoice"
  | "parallelToolCalls"
  | "vision"
  | "files"
  | "audioInput"
  | "audioOutput"
  | "fileSearch"
  | "urlContext"
  | "contextCaching"
  | "explicitPromptCaching"
  | "batch"
  | "interactions"
  | "rawPrediction"
  | "computerUse"
  | "reasoning"
  | "webSearch";

export type EmbeddingModelCapabilityFeature = "embeddings" | "batch";

export type TranscriptionModelCapabilityFeature =
  | "streaming"
  | "audioInput"
  | "batch";

export type SpeechModelCapabilityFeature =
  | "streaming"
  | "audioOutput"
  | "batch";

export type ImageGenerationModelCapabilityFeature =
  | "streaming"
  | "imageGeneration"
  | "imageInput"
  | "batch";

export type VideoGenerationModelCapabilityFeature =
  | "streaming"
  | "videoGeneration"
  | "imageInput"
  | "audioOutput"
  | "batch";

export type MusicGenerationModelCapabilityFeature =
  | "streaming"
  | "musicGeneration"
  | "imageInput"
  | "audioInput"
  | "audioOutput"
  | "batch";

export type RealtimeModelCapabilityFeature =
  | "sessions"
  | "streaming"
  | "audioInput"
  | "audioOutput"
  | "imageInput"
  | "tools"
  | "browserTokens";

export interface ReasoningCapabilityDetails {
  readonly efforts?: ReadonlyArray<NonNullable<ReasoningConfig["effort"]>>;
  readonly modes?: ReadonlyArray<NonNullable<ReasoningConfig["mode"]>>;
  readonly contexts?: ReadonlyArray<NonNullable<ReasoningConfig["context"]>>;
}

export interface AgentCapabilityDetails {
  readonly support: ModelCapabilitySupportLevel;
  readonly capabilities: AgentCapabilities;
}

interface ModelCapabilityProfileBase<
  TKind extends ModelCapabilityKind,
  TFeature extends string
> {
  readonly kind: TKind;
  /** Omitted features are treated as `unsupported`. */
  readonly capabilities: Readonly<
    Partial<Record<TFeature, ModelCapabilitySupportLevel>>
  >;
}

export interface LanguageModelCapabilityProfile
  extends ModelCapabilityProfileBase<
    "language",
    LanguageModelCapabilityFeature
  > {
  readonly reasoningDetails?: ReasoningCapabilityDetails;
  readonly agent?: AgentCapabilityDetails;
}

export interface EmbeddingModelCapabilityProfile
  extends ModelCapabilityProfileBase<
    "embedding",
    EmbeddingModelCapabilityFeature
  > {}

export interface TranscriptionModelCapabilityProfile
  extends ModelCapabilityProfileBase<
    "transcription",
    TranscriptionModelCapabilityFeature
  > {}

export interface SpeechModelCapabilityProfile
  extends ModelCapabilityProfileBase<"speech", SpeechModelCapabilityFeature> {}

export interface ImageGenerationModelCapabilityProfile
  extends ModelCapabilityProfileBase<
    "image-generation",
    ImageGenerationModelCapabilityFeature
  > {}

export interface VideoGenerationModelCapabilityProfile
  extends ModelCapabilityProfileBase<
    "video-generation",
    VideoGenerationModelCapabilityFeature
  > {}

export interface MusicGenerationModelCapabilityProfile
  extends ModelCapabilityProfileBase<
    "music-generation",
    MusicGenerationModelCapabilityFeature
  > {}

export interface RealtimeModelCapabilityProfile
  extends ModelCapabilityProfileBase<
    "realtime",
    RealtimeModelCapabilityFeature
  > {
  readonly agent?: AgentCapabilityDetails;
}

export type ModelCapabilityProfile =
  | LanguageModelCapabilityProfile
  | EmbeddingModelCapabilityProfile
  | TranscriptionModelCapabilityProfile
  | SpeechModelCapabilityProfile
  | ImageGenerationModelCapabilityProfile
  | VideoGenerationModelCapabilityProfile
  | MusicGenerationModelCapabilityProfile
  | RealtimeModelCapabilityProfile;

type ModelCapabilityFeature =
  | LanguageModelCapabilityFeature
  | EmbeddingModelCapabilityFeature
  | TranscriptionModelCapabilityFeature
  | SpeechModelCapabilityFeature
  | ImageGenerationModelCapabilityFeature
  | VideoGenerationModelCapabilityFeature
  | MusicGenerationModelCapabilityFeature
  | RealtimeModelCapabilityFeature;

/**
 * Returns whether a support level is representable as `true` in the legacy
 * boolean contract. Consumers that need to distinguish native, prompted, and
 * conditional support should use the v2 profile directly.
 */
export const isModelCapabilitySupported = (
  support: ModelCapabilitySupportLevel | undefined
): boolean => support !== undefined && support !== "unsupported";

/**
 * Converts a kind-specific v2 capability profile to the existing flat
 * `ModelCapabilities` contract.
 */
export const deriveLegacyModelCapabilities = (
  profile: ModelCapabilityProfile
): ModelCapabilities => {
  const features = profile.capabilities as Readonly<
    Partial<Record<ModelCapabilityFeature, ModelCapabilitySupportLevel>>
  >;
  const supported = (feature: ModelCapabilityFeature): boolean =>
    isModelCapabilitySupported(features[feature]);

  const legacy: ModelCapabilities = {
    streaming: supported("streaming"),
    tools: false,
    structuredOutput: false,
    jsonMode: false,
    toolChoice: false,
    parallelToolCalls: false,
    vision: false,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false
  };

  if (supported("batch")) {
    legacy.batch = true;
  }

  switch (profile.kind) {
    case "language": {
      legacy.tools = supported("tools");
      legacy.structuredOutput = supported("structuredOutput");
      legacy.jsonMode = supported("jsonMode");
      legacy.toolChoice = supported("toolChoice");
      legacy.parallelToolCalls = supported("parallelToolCalls");
      legacy.vision = supported("vision");
      legacy.files = supported("files");
      legacy.audioInput = supported("audioInput");
      legacy.audioOutput = supported("audioOutput");
      legacy.reasoning = supported("reasoning");
      legacy.webSearch = supported("webSearch");

      if (supported("fileSearch")) legacy.fileSearch = true;
      if (supported("urlContext")) legacy.urlContext = true;
      if (supported("contextCaching")) legacy.contextCaching = true;
      if (supported("explicitPromptCaching")) {
        legacy.explicitPromptCaching = true;
      }
      if (supported("interactions")) legacy.interactions = true;
      if (supported("rawPrediction")) legacy.rawPrediction = true;
      if (supported("computerUse")) legacy.computerUse = true;

      if (legacy.reasoning && profile.reasoningDetails) {
        legacy.reasoningEfforts = profile.reasoningDetails.efforts
          ? [...profile.reasoningDetails.efforts]
          : undefined;
        legacy.reasoningModes = profile.reasoningDetails.modes
          ? [...profile.reasoningDetails.modes]
          : undefined;
        legacy.reasoningContexts = profile.reasoningDetails.contexts
          ? [...profile.reasoningDetails.contexts]
          : undefined;
      }

      if (profile.agent && isModelCapabilitySupported(profile.agent.support)) {
        legacy.agentCapabilities = { ...profile.agent.capabilities };
      }
      break;
    }
    case "embedding":
      legacy.embeddings = supported("embeddings");
      break;
    case "transcription":
      legacy.audioInput = supported("audioInput");
      break;
    case "speech":
      legacy.audioOutput = supported("audioOutput");
      break;
    case "image-generation":
      legacy.imageGeneration = supported("imageGeneration");
      legacy.vision = supported("imageInput");
      break;
    case "video-generation":
      legacy.videoGeneration = supported("videoGeneration");
      legacy.vision = supported("imageInput");
      legacy.audioOutput = supported("audioOutput");
      break;
    case "music-generation":
      legacy.musicGeneration = supported("musicGeneration");
      legacy.vision = supported("imageInput");
      legacy.audioInput = supported("audioInput");
      legacy.audioOutput = supported("audioOutput");
      break;
    case "realtime": {
      const tools = supported("tools");
      const imageInput = supported("imageInput");

      legacy.tools = tools;
      legacy.vision = imageInput;
      legacy.audioInput = supported("audioInput");
      legacy.audioOutput = supported("audioOutput");
      legacy.realtime = {
        sessions: supported("sessions"),
        audioInput: legacy.audioInput,
        audioOutput: legacy.audioOutput,
        imageInput,
        tools,
        browserTokens: supported("browserTokens")
      };

      if (profile.agent && isModelCapabilitySupported(profile.agent.support)) {
        legacy.agentCapabilities = { ...profile.agent.capabilities };
      }
      break;
    }
  }

  return legacy;
};
