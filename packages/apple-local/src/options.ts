import type { AppleLocalSampling } from "./protocol.js";

/** Provider options that map onto documented Foundation Models controls. */
export interface AppleLocalLanguageModelOptions {
  /**
   * Omit for the default guardrails. `permissiveContentTransformations` is
   * documented for string generation only, not guided generation.
   */
  guardrails?: "permissiveContentTransformations";
  /**
   * Explicit `GenerationOptions.SamplingMode`. `topP` is the shared alias for
   * `random(probabilityThreshold:)`.
   */
  sampling?: AppleLocalSampling;
  /** Forwarded to `respond(..., includeSchemaInPrompt:)`. Defaults to false. */
  includeSchemaInPrompt?: boolean;
  /** Passed to `supportsLocale`. An unsupported locale fails before generation. */
  locale?: string;
  [key: string]: unknown;
}
