import { describe, it, expect, vi } from "vitest";
import type { RealtimeEvent, RealtimeSessionConfig } from "@zhivex-ai/core";
import { createQwen } from "../src/index.js";
import { liveTranslateSession } from "../src/live-translate.js";
const id = "qwen3.8-livetranslate-flash-realtime";
function fixture(ack = true) {
  const sent: Record<string, unknown>[] = [];
  const queue: unknown[] = [];
  let waiter: ((value: unknown) => void) | undefined;
  const push = (value: unknown) => { if (waiter) { const resolve = waiter; waiter = undefined; resolve(value); } else queue.push(value); };
  const connection = {
    async sendJson(payload: Record<string, unknown>) { sent.push(payload); if (payload.type === "session.update" && ack) push({ type: "session.updated" }); },
    async recvJson(): Promise<unknown> { return queue.length ? queue.shift() : new Promise(resolve => { waiter = resolve; }); },
    close: vi.fn(async () => { push(undefined); })
  };
  const factory = vi.fn(async () => connection);
  const model = createQwen({ apiKey: "test", workspaceId: "testworkspace", realtimeConnectionFactory: factory }).realtimeModel!(id);
  return { sent, push, connection, factory, model };
}
const frame = { data: new Uint8Array([0, 0]), mediaType: "audio/pcm", sampleRateHz: 16000, channels: 1 };
describe("Qwen 3.8 LiveTranslate", () => {
  it("rejects using the realtime model through HTTP generation", () => {
    expect(() => createQwen({ apiKey: "test" })(id)).toThrow(/realtimeModel/);
  });
  it("maps translation, glossary, speaker detection and nested audio without legacy fields", () => {
    const body = liveTranslateSession({ mode: "translation", translation: { targetLanguage: "es" }, outputAudioMediaType: "audio/pcm", voice: "Tina", providerOptions: { translation: { corpus: { phrases: { SDK: "SDK" } } } } });
    expect(body).toMatchObject({ output_modalities: ["text", "audio"], translation: { language: "es", corpus: { phrases: { SDK: "SDK" } } }, audio: { input: { format: { sample_rate: 16000 }, turn_detection: { type: "speaker_detection" } }, output: { voice: "Tina", format: { sample_rate: 24000 } } } });
    for (const field of ["modalities", "voice", "input_audio_format", "turn_detection"]) expect(body).not.toHaveProperty(field);
  });
  it.each(["once", "always", "never"])("forwards explicitly requested clone mode %s", frequency => {
    const body = liveTranslateSession({ voice: frequency === "never" ? "qwen-translate-vc-test" : "default", providerOptions: { enable_voice_clone: true, voice_clone_options: { frequency } } });
    expect(body).toMatchObject({ enable_voice_clone: true, voice_clone_options: { frequency } });
  });
  it.each([
    { mode: "conversation" }, { inputAudioTranscription: false }, { tools: {} }, { autoResponse: false },
    { turnDetection: null }, { turnDetection: { type: "server_vad" } }, { inputSampleRateHz: 24000 },
    { translation: { targetLanguage: "xx" } }, { translation: { targetLanguage: "el" }, outputAudioMediaType: "audio/pcm" },
    { providerOptions: { modalities: ["text"] } }, { providerOptions: { translation: { same_language_skip_options: {} } } },
    { voice: "Tina", providerOptions: { enable_voice_clone: true, voice_clone_options: { frequency: "always" } } },
    { providerOptions: { audio: { input: { format: { sample_rate: 8000 } } } } }
  ] as RealtimeSessionConfig[])("rejects incompatible config before connecting: %j", async config => {
    const f = fixture(); await expect(f.model.connect(config)).rejects.toThrow(); expect(f.factory).not.toHaveBeenCalled();
  });
  it("selects the documented Tina voice rather than the server's incompatible default", () => {
    expect(liveTranslateSession({ outputAudioMediaType: "audio/pcm" })).toMatchObject({ audio: { output: { voice: "Tina" } } });
  });
  it("validates updates before sending and maps the replacement language", async () => {
    const f = fixture(); const session = await f.model.connect();
    await session.update({ translation: { targetLanguage: "es" } });
    expect(f.sent.at(-1)).toMatchObject({ session: { translation: { language: "es" } } });
    const count = f.sent.length;
    await expect(session.update({ turnDetection: null })).rejects.toThrow();
    expect(f.sent).toHaveLength(count);
    expect(session.config.turnDetection).toBeUndefined();
    f.push({ type: "session.finished" }); await session.close();
  });
  it("times out setup and closes the transport when the server never acknowledges", async () => {
    const f = fixture(false);
    await expect(f.model.connect({}, { timeoutMs: 20 })).rejects.toThrow();
    expect(f.connection.close).toHaveBeenCalledOnce();
  });
  it("accepts opaque enrolled voice IDs without assuming a provider naming prefix", () => {
    expect(liveTranslateSession({ voice: "enrolled_voice_123", providerOptions: { enable_voice_clone: true, voice_clone_options: { frequency: "never" } } })).toMatchObject({ audio: { output: { voice: "enrolled_voice_123" } } });
    expect(() => liveTranslateSession({ outputAudioMediaType: "audio/pcm", providerOptions: { enable_voice_clone: true, voice_clone_options: { frequency: "never" } } })).toThrow();
  });
  it("accepts text-only languages", () => expect(liveTranslateSession({ translation: { targetLanguage: "el" } })).toMatchObject({ output_modalities: ["text"] }));
  it("waits for server setup and drains final transcripts/audio before close acknowledgement", async () => {
    const f = fixture(false);
    let ready = false;
    const connecting = f.model.connect().then(session => { ready = true; return session; });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(ready).toBe(false);
    f.push({ type: "session.updated" });
    const session = await connecting;
    expect(session.capabilities.realtime?.tools).toBe(false);
    const events: RealtimeEvent[] = [];
    const collecting = (async () => { for await (const event of session.eventStream()) events.push(event); })();
    await session.sendAudio({ ...frame, isFinal: true });
    expect(f.sent.map(p => p.type)).toEqual(["session.update", "input_audio_buffer.append"]);
    const closing = session.close();
    await vi.waitFor(() => expect(f.sent.at(-1)?.type).toBe("session.finish"));
    expect(f.connection.close).not.toHaveBeenCalled();
    f.push({ type: "conversation.item.input_audio_transcription.delta", delta: "Hola", item_id: "i1", speaker_id: "s1" });
    f.push({ type: "response.text.delta", delta: "Hello", response_id: "r1" });
    f.push({ type: "response.text.done", text: "Hello", response_id: "r1" });
    f.push({ type: "response.audio.delta", delta: "AAA=" });
    f.push({ type: "input_audio_buffer.speech_started", speaker_id: "s1" });
    f.push({ type: "session.finished" });
    await closing; await collecting;
    expect(events).toContainEqual(expect.objectContaining({ type: "realtime-transcript", text: "Hola", providerMetadata: expect.objectContaining({ speaker_id: "s1" }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: "realtime-transcript", text: "Hello", isFinal: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "realtime-audio-output", sampleRateHz: 24000 }));
    expect(events).toContainEqual(expect.objectContaining({ type: "realtime-provider-data", data: expect.objectContaining({ speaker_id: "s1" }) }));
    expect(f.connection.close).toHaveBeenCalledOnce();
  });
  it("rejects conversation commands, invalid audio and image ordering/size/rate", async () => {
    const f = fixture(); const session = await f.model.connect();
    await expect(session.sendText("hello")).rejects.toThrow();
    await expect(session.sendAudio({ ...frame, sampleRateHz: 48000 })).rejects.toThrow();
    const image = { data: new Uint8Array([1, 2]), mediaType: "image/jpeg" };
    await expect(session.sendMedia(image)).rejects.toThrow(/before/);
    await session.sendAudio(frame);
    await expect(session.sendMedia({ ...image, data: new Uint8Array(512001) })).rejects.toThrow();
    await session.sendMedia(image); await session.sendMedia(image);
    await expect(session.sendMedia(image)).rejects.toThrow(/two images/);
    f.push({ type: "session.finished" }); await session.close();
  });
  it("rejects an unacknowledged close instead of silently losing final results", async () => {
    const f = fixture(); const session = await f.model.connect();
    vi.useFakeTimers();
    try {
      const closing = expect(session.close()).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(15001);
      await closing;
      expect(f.connection.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("surfaces setup errors instead of reporting a connected session", async () => {
    const f = fixture(false); const pending = f.model.connect();
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.push({ type: "error", error: { message: "model unavailable" } });
    await expect(pending).rejects.toThrow();
    expect(f.connection.close).toHaveBeenCalled();
  });
});
