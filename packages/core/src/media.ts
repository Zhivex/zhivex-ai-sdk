import { UnsupportedFeatureError, ValidationError } from "./errors.js";
import type {
  GenerateImageOptions,
  GenerateImageOutput,
  GenerateMusicOptions,
  GenerateMusicOutput,
  GenerateVideoOptions,
  GenerateVideoOutput,
  ImageGenerationModel,
  MusicGenerationModel,
  VideoGenerationModel
} from "./types.js";

const validatePrompt = (prompt: string) => {
  if (!prompt.trim()) {
    throw new ValidationError('The "prompt" field is required.');
  }
};

export const generateImage = async <TModel extends ImageGenerationModel>(
  options: GenerateImageOptions<TModel>
): Promise<GenerateImageOutput> => {
  if (!options.model.capabilities.imageGeneration) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support image generation.`
    );
  }

  validatePrompt(options.prompt);
  const result = await options.model.generateImage({
    prompt: options.prompt,
    images: options.images,
    count: options.count,
    aspectRatio: options.aspectRatio,
    size: options.size,
    negativePrompt: options.negativePrompt,
    outputMimeType: options.outputMimeType,
    providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs
  });

  return {
    ...result,
    prompt: options.prompt
  };
};

export const generateVideo = async <TModel extends VideoGenerationModel>(
  options: GenerateVideoOptions<TModel>
): Promise<GenerateVideoOutput> => {
  if (!options.model.capabilities.videoGeneration) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support video generation.`
    );
  }

  validatePrompt(options.prompt);
  const result = await options.model.generateVideo({
    prompt: options.prompt,
    image: options.image,
    count: options.count,
    aspectRatio: options.aspectRatio,
    negativePrompt: options.negativePrompt,
    durationSeconds: options.durationSeconds,
    outputStorageUri: options.outputStorageUri,
    pollIntervalMs: options.pollIntervalMs,
    providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs
  });

  return {
    ...result,
    prompt: options.prompt
  };
};

export const generateMusic = async <TModel extends MusicGenerationModel>(
  options: GenerateMusicOptions<TModel>
): Promise<GenerateMusicOutput> => {
  if (!options.model.capabilities.musicGeneration) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support music generation.`
    );
  }

  validatePrompt(options.prompt);
  const result = await options.model.generateMusic({
    prompt: options.prompt,
    images: options.images,
    negativePrompt: options.negativePrompt,
    outputMimeType: options.outputMimeType,
    providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs
  });

  return {
    ...result,
    prompt: options.prompt
  };
};
