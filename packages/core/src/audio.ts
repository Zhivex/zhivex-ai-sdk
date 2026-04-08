import { UnsupportedFeatureError, ValidationError } from "./errors.js";
import type {
  GenerateSpeechOptions,
  SpeechModel,
  SpeechOutput,
  TranscribeAudioOptions,
  TranscriptionModel,
  TranscriptionOutput
} from "./types.js";

const validateAudioInput = (mediaType: string) => {
  if (!mediaType.trim()) {
    throw new ValidationError('The "audio.mediaType" field is required.');
  }
};

export const transcribeAudio = async <TModel extends TranscriptionModel>(
  options: TranscribeAudioOptions<TModel>
): Promise<TranscriptionOutput> => {
  if (!options.model.capabilities.audioInput) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support audio input.`
    );
  }

  validateAudioInput(options.audio.mediaType);
  const result = await options.model.transcribe({
    audio: options.audio,
    prompt: options.prompt,
    language: options.language,
    providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs
  });

  return {
    ...result,
    audio: options.audio
  };
};

export const generateSpeech = async <TModel extends SpeechModel>(
  options: GenerateSpeechOptions<TModel>
): Promise<SpeechOutput> => {
  if (!options.model.capabilities.audioOutput) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support audio output.`
    );
  }

  const result = await options.model.generateSpeech({
    input: options.input,
    voice: options.voice,
    providerOptions: options.providerOptions,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs
  });

  return {
    ...result,
    input: options.input
  };
};
