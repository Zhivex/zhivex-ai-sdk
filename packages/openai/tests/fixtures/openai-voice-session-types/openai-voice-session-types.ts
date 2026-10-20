import { expectTypeOf } from "vitest";
import type { RealtimeSession, RealtimeSessionConfig } from "@zhivex-ai/core";
import {
  createOpenAI,
  type OpenAICustomVoice,
  type OpenAIRealtimeSession,
  type OpenAIRealtimeSessionConfig,
  type OpenAIVoice
} from "@zhivex-ai/openai";

const openai = createOpenAI({ apiKey: "test" });
const custom = { id: "voice_123" } satisfies OpenAICustomVoice;

const realtime = await openai.realtimeModel("gpt-realtime").connect({ voice: custom });
expectTypeOf(realtime).toMatchTypeOf<OpenAIRealtimeSession>();
expectTypeOf(realtime.config).toEqualTypeOf<OpenAIRealtimeSessionConfig>();
expectTypeOf(realtime.config.voice).toEqualTypeOf<OpenAIVoice | undefined>();
expectTypeOf(realtime.update).parameter(0).toEqualTypeOf<Partial<OpenAIRealtimeSessionConfig>>();
await realtime.update({ voice: { id: "voice_456" } });
// @ts-expect-error a custom voice object does not have string methods
realtime.config.voice.toUpperCase();
// @ts-expect-error custom-voice sessions are not shared string-voice sessions
const realtimeAsShared: RealtimeSession = realtime;

const live = await openai.realtimeModel("gpt-live-1").connect({ voice: { id: "voice_123" } });
expectTypeOf(live).toMatchTypeOf<OpenAIRealtimeSession>();
expectTypeOf(live.update).parameter(0).toEqualTypeOf<Partial<OpenAIRealtimeSessionConfig>>();
await live.update({ voice: custom });
// @ts-expect-error a custom voice object does not have string methods
live.config.voice.toUpperCase();

const named = await openai.realtimeModel("gpt-realtime").connect({ voice: "marin" });
const namedAsShared: RealtimeSession = named;
named.config.voice?.toUpperCase();
await named.update({ voice: custom });

const plain = await openai.realtimeModel("gpt-live-1").connect();
const plainAsShared: RealtimeSession = plain;
await plain.update({ voice: { id: "voice_123" } });

const variable: OpenAIRealtimeSessionConfig = { voice: custom };
const fromVariable = await openai.realtimeModel("gpt-realtime").connect(variable);
expectTypeOf(fromVariable).toMatchTypeOf<OpenAIRealtimeSession>();
await fromVariable.update({ voice: custom });

// @ts-expect-error shared realtime voice stays a string
const sharedConfig: RealtimeSessionConfig = { voice: { id: "voice_123" } };
// @ts-expect-error update rejects a voice object that is not a saved custom voice
await realtime.update({ voice: { name: "marin" } });

void namedAsShared;
void plainAsShared;
void realtimeAsShared;
void sharedConfig;
