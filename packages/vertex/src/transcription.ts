import { ConfigurationError, UnsupportedFeatureError, type TranscriptionModel, type TranscriptionModelInput, type TranscriptionResult } from "@zhivex-ai/core/provider";

export interface VertexAudioTranscriptionConfig {
  languageCodes?: string[];
  customVocabulary?: string[];
  wordTimestamp?: boolean;
  diarization?: boolean;
  mode?: "VERBATIM" | "SMART";
}
export interface VertexTranscriptionOptions extends Record<string, unknown> {
  audioTranscriptionConfig?: VertexAudioTranscriptionConfig;
}
export interface VertexAudioTranscription {
  text?: string;
  finished?: boolean;
  languageCode?: string;
  speakerLabel?: string;
  words?: { word?: string; startOffset?: string; endOffset?: string }[];
}
export interface VertexTranscriptionResult extends TranscriptionResult {
  transcriptions: VertexAudioTranscription[];
}
export interface VertexTranscriptionModel extends TranscriptionModel<VertexTranscriptionOptions> {
  transcribe(input: TranscriptionModelInput<VertexTranscriptionOptions>): Promise<VertexTranscriptionResult>;
}
export const isVertexTranscribeModel = (model: string) => model === "gemini-3.5-transcribe-preview";

export function normalizeVertexTranscriptionConfig(supplied: unknown, language?: string): VertexAudioTranscriptionConfig {
  if (supplied !== undefined && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) throw new ConfigurationError("audioTranscriptionConfig must be an object.");
  const config = { ...(supplied as VertexAudioTranscriptionConfig | undefined) };
  const allowed = ["languageCodes", "customVocabulary", "wordTimestamp", "diarization", "mode"];
  for (const key of Object.keys(config)) if (!allowed.includes(key)) throw new ConfigurationError(`Unsupported audioTranscriptionConfig field: ${key}.`);
  if (language !== undefined) {
    if (typeof language !== "string" || !language.trim()) throw new ConfigurationError("Transcription language must be nonempty.");
    if (config.languageCodes !== undefined && (config.languageCodes.length !== 1 || config.languageCodes[0] !== language)) throw new ConfigurationError("language conflicts with audioTranscriptionConfig.languageCodes.");
    config.languageCodes = [language];
  }
  for (const key of ["languageCodes", "customVocabulary"] as const) {
    const list = config[key];
    if (list !== undefined && (!Array.isArray(list) || list.some(value => typeof value !== "string" || !value.trim()))) throw new ConfigurationError(`${key} must contain nonempty strings.`);
  }
  if ((config.customVocabulary?.length ?? 0) > 1000) throw new ConfigurationError("customVocabulary accepts at most 1000 terms.");
  for (const key of ["wordTimestamp", "diarization"] as const) if (config[key] !== undefined && typeof config[key] !== "boolean") throw new ConfigurationError(`${key} must be a boolean.`);
  if (config.mode !== undefined && !["SMART", "VERBATIM"].includes(config.mode)) throw new ConfigurationError("Transcription mode must be SMART or VERBATIM.");
  if (config.mode === "SMART" && (config.wordTimestamp || config.diarization)) throw new ConfigurationError("SMART mode cannot combine with timestamps or diarization.");
  return config;
}

export function transcriptionRequest(model: string, input: TranscriptionModelInput, data: string) {
  const options = { ...input.providerOptions };
  const native = isVertexTranscribeModel(model);
  if (!native) {
    if (options.audioTranscriptionConfig !== undefined) throw new UnsupportedFeatureError("audioTranscriptionConfig requires Gemini 3.5 Transcribe.");
    return { contents: [{ role: "user", parts: [{ inlineData: { mimeType: input.audio.mediaType, data } }, { text: input.prompt ?? `Transcribe this audio${input.language ? ` in ${input.language}` : ""}. Return only the transcript.` }] }], ...options };
  }
  if (input.prompt !== undefined) throw new UnsupportedFeatureError("Gemini 3.5 Transcribe accepts audio and transcription configuration, not a text prompt.");
  for (const key of ["contents", "systemInstruction", "system_instruction", "tools", "toolConfig", "audio_transcription_config"]) {
    if (options[key] !== undefined) throw new ConfigurationError(`Gemini 3.5 Transcribe does not accept providerOptions.${key}.`);
  }
  const config = normalizeVertexTranscriptionConfig(options.audioTranscriptionConfig, input.language);
  delete options.audioTranscriptionConfig;
  const generation = options.generationConfig;
  if (generation !== undefined && (!generation || typeof generation !== "object" || Array.isArray(generation))) throw new ConfigurationError("generationConfig must be an object.");
  if (generation && ("audioTranscriptionConfig" in generation || "audio_transcription_config" in generation)) throw new ConfigurationError("Use the dedicated audioTranscriptionConfig option, not a generationConfig override.");
  return { ...options, contents: [{ role: "user", parts: [{ inlineData: { mimeType: input.audio.mediaType, data } }] }], generationConfig: { ...generation as object, audioTranscriptionConfig: config } };
}

export function transcriptionResponse(json: any): VertexTranscriptionResult {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  if (!Array.isArray(parts)) throw new ConfigurationError("Invalid Vertex transcription parts.");
  const transcriptions: VertexAudioTranscription[] = [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") throw new ConfigurationError("Invalid Vertex transcription part.");
    const value = part.audioTranscription;
    if (value !== undefined) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError("Invalid audioTranscription response.");
      for (const key of ["text", "languageCode", "speakerLabel"]) if (value[key] !== undefined && typeof value[key] !== "string") throw new ConfigurationError(`Invalid transcription ${key}.`);
      if (value.finished !== undefined && typeof value.finished !== "boolean") throw new ConfigurationError("Invalid transcription finished flag.");
      if (value.words !== undefined && (!Array.isArray(value.words) || value.words.some((word: any) => !word || typeof word !== "object" || Array.isArray(word) || ["word", "startOffset", "endOffset"].some(key => word[key] !== undefined && typeof word[key] !== "string")))) throw new ConfigurationError("Invalid transcription word information.");
      transcriptions.push(value);
    }
    if (part.thought !== true) {
      if (typeof part.text === "string" && part.text) texts.push(part.text);
      else if (typeof value?.text === "string") texts.push(value.text);
    }
  }
  return { text: texts.join(""), transcriptions, rawResponse: json };
}
