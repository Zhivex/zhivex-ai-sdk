import { toJSONSchema } from "zod";
import { UnsupportedFeatureError, isHostedToolDefinition } from "@zhivex-ai/core/provider";
import type { ModelCapabilities, ModelGenerateInput, ModelMessage } from "@zhivex-ai/core/contracts";
import { capabilities } from "./capabilities.js";
import { toGeminiSchema } from "./messages.js";

const isGemini3Model = (modelId: string) => /^gemini-3([.-]|$)/.test(modelId);

const isGemini3ProModel = (modelId: string) => /^gemini-3([.-].*)?pro([.-]|$)/.test(modelId);

interface GeminiTextProfile {
  readonly reasoningEfforts: readonly NonNullable<ModelCapabilities["reasoningEfforts"]>[number][];
  readonly providerManagedSampling: boolean;
  readonly assistantPrefill: boolean;
}

// These are serving policies for the direct Gemini host, not a model inventory.
// A new model with this protocol needs one profile entry; request validators and
// advertised capabilities consume the same declaration. Unknown IDs retain the
// previous request behavior rather than inheriting a new family's restrictions.
const profile = (efforts: GeminiTextProfile["reasoningEfforts"]): GeminiTextProfile => Object.freeze({
  reasoningEfforts: Object.freeze([...efforts]),
  providerManagedSampling: true,
  assistantPrefill: false
});

export const geminiTextProfiles: Readonly<Record<string, GeminiTextProfile>> = Object.freeze({
  "gemini-3.8-flash": profile(["low", "medium", "high"]),
  "gemini-3.7-flash": profile(["low", "medium", "high"]),
  "gemini-3.6-flash": profile(["minimal", "low", "medium", "high"]),
  "gemini-3.5-flash-lite": profile(["minimal", "low", "medium", "high"])
});

const textProfile = (modelId: string): GeminiTextProfile | undefined =>
  Object.hasOwn(geminiTextProfiles, modelId) ? geminiTextProfiles[modelId] : undefined;

const reasoningEffortsForModel = (modelId: string) => textProfile(modelId)!.reasoningEfforts;

export const modelCapabilities = (
  modelId: string,
  baseCapabilities: ModelCapabilities = capabilities
): ModelCapabilities =>
  textProfile(modelId)
    ? {
        ...baseCapabilities,
        reasoningEfforts: [...reasoningEffortsForModel(modelId)]
      }
    : baseCapabilities;

const currentGeminiGenerationControlKeys = [
  "temperature",
  "topP",
  "top_p",
  "topK",
  "top_k",
  "candidateCount",
  "candidate_count",
  "frequencyPenalty",
  "frequency_penalty",
  "presencePenalty",
  "presence_penalty"
] as const;

const firstUnsupportedGenerationControl = (...sources: unknown[]) => {
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    for (const key of currentGeminiGenerationControlKeys) {
      if ((source as Record<string, unknown>)[key] !== undefined) {
        return key;
      }
    }
  }
  return undefined;
};

const hasAssistantPrefill = (messages: ModelMessage[]) =>
  messages
    .slice()
    .reverse()
    .find((message) => message.role !== "system" && message.parts.length > 0)?.role === "assistant";

export const assertCurrentGeminiGenerateInput = (
  provider: "gemini" | "vertex",
  modelId: string,
  input: ModelGenerateInput
) => {
  if (input.providerOptions?.max_tool_calls !== undefined) throw new UnsupportedFeatureError("Gemini max_tool_calls is not verified as an effective hosted-tool limit.");

  for (const tool of Object.values(input.tools ?? {})) {
    if (isHostedToolDefinition(tool) && ["googleSearch", "google_search"].includes(tool.type) && tool.config && typeof tool.config === "object" &&
      ("max_tool_calls" in tool.config || "max_uses" in tool.config)) throw new UnsupportedFeatureError("Gemini Google Search tool-call limits are not verified.");
  }
  const currentProfile = textProfile(modelId);
  if (!currentProfile) {
    return;
  }

  if (input.reasoning?.effort !== undefined && !reasoningEffortsForModel(modelId).includes(input.reasoning.effort)) {
    throw new UnsupportedFeatureError(`Provider "${provider}" does not support reasoning effort "${input.reasoning.effort}" for model "${modelId}".`);
  }
  const providerOptions = input.providerOptions as Record<string, unknown> | undefined;
  const rawConfig = providerOptions?.generationConfig ?? providerOptions?.generation_config;
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig as Record<string, unknown> : {};
  const rawThinking = config.thinkingConfig ?? config.thinking_config ?? providerOptions?.thinkingConfig ?? providerOptions?.thinking_config;
  if (rawThinking && typeof rawThinking === "object") {
    const thinking = rawThinking as Record<string, unknown>;
    const effort = thinking.thinkingLevel ?? thinking.thinking_level;
    if (effort !== undefined && !reasoningEffortsForModel(modelId).some((supported) => supported === String(effort).toLowerCase())) {
      throw new UnsupportedFeatureError(`Provider "${provider}" does not support thinking level "${effort}" for model "${modelId}".`);
    }
    if (thinking.thinkingBudget !== undefined || thinking.thinking_budget !== undefined) {
      throw new UnsupportedFeatureError(`Provider "${provider}" requires thinking levels instead of budgets for model "${modelId}".`);
    }
  }
  const unsupportedControl = firstUnsupportedGenerationControl(
    input.temperature === undefined ? undefined : { temperature: input.temperature },
    providerOptions,
    providerOptions?.generationConfig,
    providerOptions?.generation_config
  );
  if (currentProfile.providerManagedSampling && unsupportedControl) {
    throw new UnsupportedFeatureError(
      `Provider "${provider}" does not support generation control "${unsupportedControl}" for model "${modelId}". ` +
        "Remove temperature, topP/top_p, topK/top_k, candidateCount/candidate_count, and frequency/presence penalties; " +
        "these models use provider-managed sampling."
    );
  }

  if (!currentProfile.assistantPrefill && hasAssistantPrefill(input.messages)) {
    throw new UnsupportedFeatureError(
      `Provider "${provider}" does not support assistant prefill for model "${modelId}".`
    );
  }
};

export const assertCurrentGeminiInteractionBody = (body: Record<string, unknown>) => {
  const modelId = typeof body.model === "string" ? body.model : undefined;
  const currentProfile = modelId ? textProfile(modelId) : undefined;
  if (!currentProfile) {
    return;
  }

  const unsupportedControl = firstUnsupportedGenerationControl(
    body,
    body.generationConfig,
    body.generation_config
  );
  if (currentProfile.providerManagedSampling && unsupportedControl) {
    throw new UnsupportedFeatureError(
      `Provider "gemini" does not support generation control "${unsupportedControl}" for model "${modelId}". ` +
        "Remove temperature, topP/top_p, topK/top_k, candidateCount/candidate_count, and frequency/presence penalties; " +
        "these models use provider-managed sampling."
    );
  }

  if (!currentProfile.assistantPrefill && Array.isArray(body.input)) {
    const latestInput = body.input
      .slice()
      .reverse()
      .find(
        (value) =>
          value !== null &&
          value !== undefined &&
          (typeof value !== "object" || Array.isArray(value) || Object.keys(value as Record<string, unknown>).length > 0)
      );
    if (
      latestInput &&
      typeof latestInput === "object" &&
      !Array.isArray(latestInput) &&
      ((latestInput as Record<string, unknown>).type === "model_output" ||
        (latestInput as Record<string, unknown>).role === "model")
    ) {
      throw new UnsupportedFeatureError(
        `Provider "gemini" does not support model-output prefill for model "${modelId}". Use previousInteractionId for continuation.`
      );
    }
  }
};

const mapReasoning = (modelId: string, input: ModelGenerateInput) => {
  if (!input.reasoning) {
    return undefined;
  }

  if (isGemini3Model(modelId)) {
    if (input.reasoning.budgetTokens !== undefined) {
      throw new UnsupportedFeatureError(
        'Provider "gemini" uses "reasoning.effort" for Gemini 3 models and does not support "reasoning.budgetTokens".'
      );
    }

    if (input.reasoning.effort === "none") {
      throw new UnsupportedFeatureError('Provider "gemini" does not support "reasoning.effort=none" for Gemini 3 models.');
    }

    if (input.reasoning.effort === "xhigh") {
      throw new UnsupportedFeatureError('Provider "gemini" does not support "reasoning.effort=xhigh".');
    }

    if (input.reasoning.effort === "minimal" && isGemini3ProModel(modelId)) {
      throw new UnsupportedFeatureError(
        'Provider "gemini" does not support "reasoning.effort=minimal" for Gemini 3 Pro models.'
      );
    }

    return input.reasoning.effort !== undefined
      ? {
          thinkingLevel: input.reasoning.effort
        }
      : undefined;
  }

  if (input.reasoning.effort !== undefined) {
    throw new UnsupportedFeatureError(
      'Provider "gemini" does not support "reasoning.effort" for models earlier than Gemini 3.'
    );
  }

  return input.reasoning.budgetTokens !== undefined
    ? {
        thinkingBudget: input.reasoning.budgetTokens
      }
    : undefined;
};

export const generationConfig = (modelId: string, input: ModelGenerateInput) => ({
  temperature: input.temperature,
  maxOutputTokens: input.maxTokens,
  ...(input.reasoning
    ? {
        thinkingConfig: mapReasoning(modelId, input)
      }
    : {}),
  ...(input.structuredOutput?.mode === "native"
    ? {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(toJSONSchema(input.structuredOutput.schema))
      }
    : {})
});
