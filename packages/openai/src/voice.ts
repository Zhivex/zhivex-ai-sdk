import {
  ConfigurationError,
  type RealtimeSession,
  type RealtimeSessionConfig
} from "@zhivex-ai/core/provider";

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

/** OpenAI realtime session whose config and updates preserve a custom voice object. */
export interface OpenAIRealtimeSession extends Omit<RealtimeSession, "config" | "update"> {
  readonly config: OpenAIRealtimeSessionConfig;
  update(config: Partial<OpenAIRealtimeSessionConfig>): Promise<void>;
}

/** Named-string sessions stay assignable to the shared session. Updates still accept a custom voice. */
type OpenAIStringVoiceSession = Omit<RealtimeSession, "update"> & {
  update(config: Partial<OpenAIRealtimeSessionConfig>): Promise<void>;
};

/** Object voices select OpenAIRealtimeSession. String and omitted voices stay shared-session compatible. */
export type OpenAIRealtimeSessionFor<TConfig> = [TConfig] extends [undefined]
  ? OpenAIStringVoiceSession
  : Extract<
      NonNullable<TConfig> extends OpenAIRealtimeSessionConfig ? NonNullable<TConfig>["voice"] : never,
      OpenAICustomVoice
    > extends never
    ? OpenAIStringVoiceSession
    : OpenAIRealtimeSession;

/** Drop a custom voice object so the value satisfies the shared string-voice session config. */
export const sharedRealtimeConfig = (config: OpenAIRealtimeSessionConfig): RealtimeSessionConfig => {
  const { voice, ...rest } = config;
  return typeof voice === "string" ? { ...rest, voice } : rest;
};

/** Put the OpenAI config back on the session so a custom voice object stays the runtime value. */
export const retainOpenAIRealtimeConfig = <T extends { config: RealtimeSessionConfig }>(
  session: T,
  config: OpenAIRealtimeSessionConfig
): T => {
  Object.assign(session, { config });
  return session;
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
