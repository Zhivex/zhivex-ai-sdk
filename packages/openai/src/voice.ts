import { ConfigurationError, type RealtimeSessionConfig } from "@zhivex-ai/core/provider";

/** Saved custom voice. Named voices such as "marin" stay strings. */
export interface OpenAICustomVoice {
  id: string;
}

/** String names and custom voice objects accepted by OpenAI speech, Realtime, and GPT-Live. */
export type OpenAIVoice = string | OpenAICustomVoice;

/** Realtime/GPT-Live session config whose `voice` may be a custom voice object. */
export type OpenAIRealtimeSessionConfig = Omit<RealtimeSessionConfig, "voice"> & {
  voice?: OpenAIVoice;
};

const isOpenAICustomVoice = (voice: object): voice is OpenAICustomVoice => {
  const id = (voice as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0;
};

/** Reject malformed voices. Valid strings and `{ id }` objects pass through unchanged. */
export function assertOpenAIVoice(voice: unknown): asserts voice is OpenAIVoice | undefined {
  if (voice === undefined || typeof voice === "string") return;
  if (voice !== null && typeof voice === "object" && !Array.isArray(voice) && isOpenAICustomVoice(voice)) return;
  throw new ConfigurationError("OpenAI voice must be a string name or a custom voice object with a non-empty string id.");
}

/** Preserve string voices and defaults. Return a custom voice object unchanged. */
export const openAIWireVoice = (voice: unknown, fallback: string): OpenAIVoice => {
  assertOpenAIVoice(voice);
  return voice ?? fallback;
};
