import { ModelResolutionError } from "./model-resolver.js";
import type { LanguageModel, ProviderAdapter } from "./types.js";

const providers = new Map<string, ProviderAdapter>();

const isLanguageModel = (value: unknown): value is LanguageModel =>
  typeof value === "object" && value !== null && typeof (value as LanguageModel).generate === "function" &&
  typeof (value as LanguageModel).provider === "string" && typeof (value as LanguageModel).modelId === "string";

/**
 * Register an explicit provider for `"provider/model"` strings.
 * Nothing is registered by import. The map is process-local; tests should call
 * `clearRegisteredModelProviders()`.
 */
export const registerModelProvider = (adapter: ProviderAdapter): void => {
  if (
    !adapter ||
    (typeof adapter !== "object" && typeof adapter !== "function") ||
    typeof adapter.name !== "string" ||
    adapter.name.length === 0 ||
    typeof adapter.languageModel !== "function"
  ) {
    throw new ModelResolutionError(
      "invalid_configuration",
      "registerModelProvider requires a provider adapter with a name and languageModel factory."
    );
  }
  providers.set(adapter.name, adapter);
};

export const clearRegisteredModelProviders = (): void => {
  providers.clear();
};

/**
 * Resolve a language model object or a `provider/model` string.
 * A call-level `modelResolver` wins over the process registry. Unknown
 * providers throw `ModelResolutionError` and are not replaced with another provider.
 */
export const resolveLanguageModel = (
  model: LanguageModel | string,
  modelResolver?: { model(identifier: string): LanguageModel }
): LanguageModel => {
  if (typeof model !== "string") {
    if (!isLanguageModel(model)) {
      throw new ModelResolutionError(
        "invalid_resolved_model",
        "model must be a language model or a provider/model string."
      );
    }
    return model;
  }
  if (modelResolver) return modelResolver.model(model);
  if (model.length === 0 || model !== model.trim()) {
    throw new ModelResolutionError(
      "invalid_identifier",
      "Model identifiers must be non-empty and must not contain surrounding whitespace.",
      { identifier: model }
    );
  }
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new ModelResolutionError(
      "invalid_identifier",
      'Model identifiers must use the explicit "provider/model" format.',
      { identifier: model }
    );
  }
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  const adapter = providers.get(provider);
  if (!adapter) {
    throw new ModelResolutionError(
      "unknown_provider",
      `No language model provider is registered for "${provider}". Register one with registerModelProvider() or pass modelResolver.`,
      { identifier: model, provider, modelId }
    );
  }
  const resolved = adapter.languageModel(modelId);
  if (!isLanguageModel(resolved)) {
    throw new ModelResolutionError(
      "invalid_resolved_model",
      "The registered provider returned an invalid language model before any model call was made.",
      { identifier: model, provider, modelId }
    );
  }
  return resolved;
};
