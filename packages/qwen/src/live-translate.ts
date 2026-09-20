import { ConfigurationError, UnsupportedFeatureError, type RealtimeSessionConfig } from "@zhivex-ai/core";

/** Native session controls for Qwen 3.8 LiveTranslate; use with RealtimeSessionConfig.providerOptions. */
export interface QwenLiveTranslateProviderOptions extends Record<string, unknown> {
  output_modalities?: ["text"] | ["text", "audio"];
  translation?: {
    language?: string;
    corpus?: { phrases: Record<string, string> };
  };
  enable_voice_clone?: boolean;
  voice_clone_options?: { frequency: "once" | "always" | "never" };
  audio?: {
    input?: {
      format?: { type: "pcm"; sample_rate: 16000 };
      turn_detection?: { type: "speaker_detection"; threshold?: number; silence_duration_ms?: number };
    };
    output?: { format?: { type: "pcm"; sample_rate: 24000 }; voice?: string };
  };
}

export const isLiveTranslate38 = (id: string) => id === "qwen3.8-livetranslate-flash-realtime";
const spoken = new Set("zh en ar de fr es pt id it ko ru th vi ja tr hi ms nl ur nb sv da he fi pl is cs fil fa".split(" "));
const languages = new Set([...spoken, ..."yue el af ast be bg bn bs ca ceb et gl gu hr hu jv kk kn ky lv mk ml mr pa ro sk sl sw tg az uk".split(" ")]);
const object = (value: unknown, name: string): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError(`${name} must be an object.`);
  return value as Record<string, unknown>;
};

/** Qwen-specific options use the documented session.update field names. */
export function liveTranslateSession(config: RealtimeSessionConfig): Record<string, unknown> {
  const extra = config.providerOptions ?? {};
  for (const key of ["modalities", "input_audio_format", "output_audio_format", "sample_rate", "turn_detection", "input_audio_transcription", "tools", "enable_search", "instructions", "voice"]) {
    if (extra[key] !== undefined) throw new UnsupportedFeatureError(`LiveTranslate 3.8 does not accept legacy session field ${key}.`);
  }
  if ((config.mode && config.mode !== "translation") || config.tools || (config.toolChoice && config.toolChoice !== "none") || config.instructions || config.reasoning || config.delegation || config.autoResponse === false || config.inputAudioTranscription === false || typeof config.inputAudioTranscription === "object" || config.inputTranscription || config.translation?.sourceLanguage || config.translation?.instructions || config.noiseReduction || config.affectiveDialog || config.proactiveAudio) {
    throw new UnsupportedFeatureError("LiveTranslate 3.8 uses automatic speech translation and source transcription; conversation, tools, manual responses and source-language controls are unsupported.");
  }
  const translation: Record<string, unknown> = { ...object(extra.translation, "translation"), ...(config.translation ? { language: config.translation.targetLanguage } : {}) };
  if (translation.same_language_skip_options !== undefined) throw new UnsupportedFeatureError("LiveTranslate 3.8 does not support same_language_skip_options.");
  const language = translation.language ?? "en";
  if (typeof language !== "string" || !languages.has(language)) throw new ConfigurationError("Unsupported LiveTranslate target language.");
  const corpus = object(translation.corpus, "translation.corpus");
  const phrases = object(corpus.phrases, "translation.corpus.phrases");
  if (Object.keys(phrases).length > 1000 || Object.entries(phrases).some(([key, value]) => !key || typeof value !== "string" || !value)) throw new ConfigurationError("LiveTranslate glossary requires at most 1000 nonempty string pairs.");
  const modalities = extra.output_modalities ?? (config.voice || config.outputAudioMediaType ? ["text", "audio"] : ["text"]);
  if (!Array.isArray(modalities) || !["text", "text,audio", "audio,text"].includes(modalities.join(","))) throw new ConfigurationError("LiveTranslate output_modalities must contain text, optionally with audio.");
  if (modalities.includes("audio") && !spoken.has(language)) throw new ConfigurationError(`LiveTranslate supports only text output for ${language}.`);
  for (const mediaType of [config.inputAudioMediaType, config.outputAudioMediaType]) {
    if (mediaType !== undefined && mediaType !== "audio/pcm") throw new UnsupportedFeatureError("LiveTranslate 3.8 requires PCM audio.");
  }
  if ((config.inputSampleRateHz !== undefined && config.inputSampleRateHz !== 16000) || (config.outputSampleRateHz !== undefined && config.outputSampleRateHz !== 24000) || (config.channels !== undefined && config.channels !== 1)) throw new ConfigurationError("LiveTranslate uses mono PCM16, 16000 Hz input and 24000 Hz output.");
  const audio = object(extra.audio, "audio");
  const input = object(audio.input, "audio.input");
  const output = object(audio.output, "audio.output");
  for (const [format, rate] of [[input.format, 16000], [output.format, 24000]] as const) {
    const value = object(format, "audio format");
    if ((value.type !== undefined && value.type !== "pcm") || (value.sample_rate !== undefined && value.sample_rate !== rate)) throw new ConfigurationError("Unsupported LiveTranslate audio format.");
  }
  const turn = config.turnDetection === undefined ? object(input.turn_detection, "audio.input.turn_detection") : object(config.turnDetection, "turnDetection");
  if (turn.type !== undefined && turn.type !== "speaker_detection") throw new UnsupportedFeatureError("LiveTranslate 3.8 requires speaker_detection.");
  if (turn.threshold !== undefined && (typeof turn.threshold !== "number" || !Number.isFinite(turn.threshold) || turn.threshold < 0 || turn.threshold > 1)) throw new ConfigurationError("speaker_detection threshold must be between 0 and 1.");
  if (turn.silence_duration_ms !== undefined && (typeof turn.silence_duration_ms !== "number" || !Number.isSafeInteger(turn.silence_duration_ms) || turn.silence_duration_ms <= 0)) throw new ConfigurationError("speaker_detection silence_duration_ms must be a positive integer.");
  const clone = extra.enable_voice_clone;
  if (clone !== undefined && typeof clone !== "boolean") throw new ConfigurationError("enable_voice_clone must be boolean.");
  const cloneOptions = object(extra.voice_clone_options, "voice_clone_options");
  const voice = config.voice ?? output.voice ?? "Tina";
  if (clone === true) {
    if (!modalities.includes("audio")) throw new ConfigurationError("Voice cloning requires audio output.");
    if (!["once", "always", "never"].includes(String(cloneOptions.frequency))) throw new ConfigurationError("Voice cloning requires frequency once, always or never.");
    if (cloneOptions.frequency === "never" ? typeof (config.voice ?? output.voice) !== "string" || !String(config.voice ?? output.voice).trim() || voice === "default" : voice !== "default") throw new ConfigurationError("Voice cloning requires default for once/always or a cloned voice ID for never.");
  } else if (extra.voice_clone_options !== undefined) throw new ConfigurationError("voice_clone_options requires enable_voice_clone.");
  return {
    ...extra, output_modalities: modalities, translation: { ...translation, language },
    audio: {
      ...audio,
      input: { ...input, format: { type: "pcm", sample_rate: 16000 }, turn_detection: { ...turn, type: "speaker_detection" } },
      output: { ...output, format: { type: "pcm", sample_rate: 24000 }, ...(voice === undefined ? {} : { voice }) }
    }
  };
}
