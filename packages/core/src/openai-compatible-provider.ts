import { createChatCompletionsModel } from "./chat-completions.js";
import { ModelResolutionError } from "./model-resolver.js";
import { registerModelProvider } from "./model-registry.js";
import { createProviderAdapter } from "./runtime.js";
import { assertTrustedEndpoint, withManualRedirect } from "./url-security.js";
import type { CallableProviderAdapter, LanguageModel, ModelCapabilities } from "./types.js";

export interface OpenAICompatibleProviderOptions {
  /** Provider id used in `"name/model"` strings. */
  name: string;
  /** Origin and prefix, for example `https://api.example.com/v1`. */
  baseURL: string;
  apiKey: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  /** Allow non-HTTPS or private hosts. The caller owns that network boundary. */
  allowUnsafeEndpoints?: boolean;
  /** Add this provider to the process registry so generateText can take `"name/model"`. */
  register?: boolean;
  capabilities?: Partial<ModelCapabilities>;
}

const compatibleCapabilities = (overrides?: Partial<ModelCapabilities>): ModelCapabilities => {
  const { sampling, ...rest } = overrides ?? {};
  return {
    streaming: true,
    tools: true,
    structuredOutput: true,
    jsonMode: true,
    toolChoice: true,
    parallelToolCalls: true,
    vision: false,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false,
    ...rest,
    sampling: { topP: true, seed: true, stopSequences: true, ...sampling }
  };
};

const assertCredentials = (name: string, apiKey: string): string => {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new ModelResolutionError(
      "missing_credentials",
      `Provider "${name}" requires an apiKey. No request was sent.`,
      { provider: name }
    );
  }
  return apiKey;
};

/**
 * Callable provider for any OpenAI-compatible Chat Completions endpoint.
 * Chat, streaming, tools, and native JSON Schema structured output use the
 * shared Chat Completions transport. Pass `register: true` to resolve
 * `"name/model"` strings.
 */
export const openaiCompatible = (
  options: OpenAICompatibleProviderOptions
): CallableProviderAdapter<LanguageModel> => {
  if (!options || typeof options.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.name)) {
    throw new ModelResolutionError(
      "invalid_configuration",
      "openaiCompatible requires a provider name of letters, numbers, dots, underscores, or hyphens."
    );
  }
  const apiKey = assertCredentials(options.name, options.apiKey);
  const endpoint = assertTrustedEndpoint(options.baseURL, {
    label: `${options.name} baseURL`,
    protocols: ["https"],
    allowUnsafe: options.allowUnsafeEndpoints
  });
  const baseURL = endpoint.toString().replace(/\/+$/, "");
  const fetcher = withManualRedirect(options.fetch ?? globalThis.fetch);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    ...options.headers
  };
  const capabilities = compatibleCapabilities(options.capabilities);
  const adapter = createProviderAdapter({
    name: options.name,
    languageModel(modelId: string): LanguageModel {
      if (typeof modelId !== "string" || modelId.trim() === "") {
        throw new ModelResolutionError(
          "invalid_identifier",
          `Provider "${options.name}" requires a non-empty model id.`,
          { provider: options.name }
        );
      }
      return createChatCompletionsModel({
        provider: options.name,
        modelId,
        capabilities,
        async send(body, signal) {
          return fetcher(`${baseURL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal
          });
        }
      });
    }
  });
  if (options.register) registerModelProvider(adapter);
  return adapter;
};

export const OPENAI_COMPATIBLE_PRESETS = Object.freeze({
  mistral: Object.freeze({ name: "mistral", baseURL: "https://api.mistral.ai/v1" }),
  groq: Object.freeze({ name: "groq", baseURL: "https://api.groq.com/openai/v1" })
});

export type OpenAICompatiblePresetOptions = Omit<OpenAICompatibleProviderOptions, "name" | "baseURL"> & {
  baseURL?: string;
};

/** Mistral Chat Completions via `openaiCompatible`. Not a native Mistral adapter. */
export const createMistralCompatible = (options: OpenAICompatiblePresetOptions): CallableProviderAdapter<LanguageModel> =>
  openaiCompatible({
    ...options,
    name: OPENAI_COMPATIBLE_PRESETS.mistral.name,
    baseURL: options.baseURL ?? OPENAI_COMPATIBLE_PRESETS.mistral.baseURL
  });

/** Groq Chat Completions via `openaiCompatible`. Not a native Groq adapter. */
export const createGroqCompatible = (options: OpenAICompatiblePresetOptions): CallableProviderAdapter<LanguageModel> =>
  openaiCompatible({
    ...options,
    name: OPENAI_COMPATIBLE_PRESETS.groq.name,
    baseURL: options.baseURL ?? OPENAI_COMPATIBLE_PRESETS.groq.baseURL
  });
