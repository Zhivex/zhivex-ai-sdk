import type {
  LanguageModel,
  RealtimeModel
} from "./model-tools.js";
import type {
  BatchesClient,
  ContextCachesClient,
  FileSearchStoresClient,
  FilesClient,
  InteractionsClient,
  PredictionModel
} from "./provider-resources.js";
import type {
  EmbeddingModel,
  GroundedLanguageModel,
  ImageGenerationModel,
  MusicGenerationModel,
  SpeechModel,
  TranscriptionModel,
  VideoGenerationModel
} from "./media.js";

export interface ProviderAdapter<TLanguageModel extends LanguageModel = LanguageModel> {
  readonly name: string;
  languageModel(modelId: string): TLanguageModel;
  embeddingModel?: (modelId: string) => EmbeddingModel;
  transcriptionModel?: (modelId: string) => TranscriptionModel;
  speechModel?: (modelId: string) => SpeechModel;
  imageGenerationModel?: (modelId: string) => ImageGenerationModel;
  videoGenerationModel?: (modelId: string) => VideoGenerationModel;
  musicGenerationModel?: (modelId: string) => MusicGenerationModel;
  realtimeModel?: (modelId: string) => RealtimeModel;
  groundedLanguageModel?: (modelId: string) => GroundedLanguageModel;
  files?: FilesClient;
  fileSearchStores?: FileSearchStoresClient;
  caches?: ContextCachesClient;
  batches?: BatchesClient;
  interactions?: InteractionsClient;
  predictionModel?: (modelId: string) => PredictionModel;
}

export type CallableProviderAdapter<TLanguageModel extends LanguageModel = LanguageModel> =
  ProviderAdapter<TLanguageModel> & ((modelId: string) => TLanguageModel);
