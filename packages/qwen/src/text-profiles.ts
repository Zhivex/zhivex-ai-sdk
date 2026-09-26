import { ConfigurationError, UnsupportedFeatureError, toToolSet, type ModelGenerateInput } from "@zhivex-ai/core/provider";

export const isQwenTranslation = (id: string) => /^qwen-mt-(?:plus|turbo|flash|lite)$/.test(id);
export const isQwenCharacter = (id: string) => /^qwen-(?:plus|flash)-character(?:-ja)?$/.test(id);
export const isQwen38Open = (id: string) => ["qwen3.8-27b", "qwen3.8-2.4t-a95b"].includes(id);

export function assertQwenLanguageModel(id: string) {
  if (id === "decision-model-preview") throw new UnsupportedFeatureError("Use decisionModel() for Qwen decisions.");
  if (/realtime$/.test(id)) throw new UnsupportedFeatureError(`Use realtimeModel() for Qwen ${id}.`);
  if (/^(?:qwen-audio-|qwen-image-|wan\d|happyhorse-|happyoyster-|vidu\/|qwen-mt-image)|(?:embedding|rerank)|realtime$/.test(id)) {
    throw new UnsupportedFeatureError(`Qwen ${id} requires its dedicated audio, image, video, world, embedding or rerank model factory.`);
  }
}

export function validateQwenSpecializedText(id: string, input: ModelGenerateInput) {
  const search = input.providerOptions?.search_options;
  if ((isQwen38Open(id) || isQwenCharacter(id)) && search && typeof search === "object" && (search as Record<string, unknown>).search_strategy === "agent") {
    throw new UnsupportedFeatureError(`${id} does not support search_strategy agent; use a supported Responses web_search tool for agent-style retrieval.`);
  }
  if (isQwen38Open(id)) {
    for (const message of input.messages) for (const part of message.parts) {
      if (part.type === "audio" || part.type === "file" && !part.mediaType.startsWith("video/")) {
        throw new UnsupportedFeatureError(`${id} accepts images and video, not audio or document files.`);
      }
      if ((part.type === "image" || part.type === "file") && message.role !== "user") throw new UnsupportedFeatureError("Qwen visual inputs require user messages.");
    }
  }
  if (!isQwenTranslation(id) && !isQwenCharacter(id)) return;
  const options = input.providerOptions ?? {};
  if (Object.keys(toToolSet(input.tools) ?? {}).length || input.toolChoice !== undefined && input.toolChoice !== "none" ||
    options.tools !== undefined || isQwenTranslation(id) && options.enable_search === true) throw new UnsupportedFeatureError(`${id} does not support tools.`);
  if (input.reasoning || options.enable_thinking !== undefined || options.reasoning_effort !== undefined || options.thinking_budget !== undefined) {
    throw new UnsupportedFeatureError(`${id} does not support reasoning controls.`);
  }
  if (input.structuredOutput?.mode === "native" || options.response_format !== undefined) throw new UnsupportedFeatureError(`${id} does not support native structured output.`);
  if (input.messages.some(m => m.parts.some(p => p.type !== "text"))) throw new UnsupportedFeatureError(`${id} only accepts text messages.`);
  if (options.apiMode === "responses") throw new UnsupportedFeatureError("Qwen translation and character models require Chat Completions.");
  if (isQwenTranslation(id)) {
    if (input.messages.length !== 1 || input.messages[0]?.role !== "user") throw new ConfigurationError("Qwen translation requires a single user message.");
    const translation = options.translation_options as Record<string, unknown> | undefined;
    if (translation !== undefined && (!translation || typeof translation !== "object" ||
      typeof translation.target_lang !== "string" || !translation.target_lang.trim() ||
      typeof translation.source_lang !== "string" || !translation.source_lang.trim())) {
      throw new ConfigurationError("translation_options requires source_lang and target_lang.");
    }
  }
}
