import { describe, expect, it, vi } from "vitest";
import { createVertex } from "../src/index.js";
import type { RealtimeSessionConfig } from "@zhivex-ai/core";
const modelId = "gemini-3.5-transcribe-live-preview";
function setup(events: Record<string, unknown>[] = []) {
  const sent: Record<string, unknown>[] = [];
  const queue = [{ setupComplete: {} }, ...events];
  let end!: () => void;
  const closed = new Promise<undefined>(resolve => { end = () => resolve(undefined); });
  const factory = vi.fn(async () => ({
    async sendJson(payload: Record<string, unknown>) { sent.push(payload); },
    async recvJson() { return queue.length ? queue.shift() : closed; },
    async close() { end(); }
  }));
  const vertex = createVertex({ projectId: "p", accessToken: "synthetic", realtimeConnectionFactory: factory });
  return { vertex, factory, sent };
}
describe("Vertex Live transcription", () => {
  it("configures text-only recognition and flushes input when muted", async () => {
    const { vertex, sent } = setup();
    const model = vertex.realtimeModel!(modelId);
    expect(model.capabilities).toMatchObject({ audioInput: true, audioOutput: false, tools: false, vision: false, reasoning: false, realtime: { audioOutput: false, tools: false, imageInput: false } });
    const session = await model.connect({ mode: "transcription", inputTranscription: { language: "en-US" }, inputAudioTranscription: { customVocabulary: ["Zhivex"], mode: "SMART" } });
    try {
      expect(sent[0]).toEqual({ setup: { model: `projects/p/locations/global/publishers/google/models/${modelId}`, generationConfig: { responseModalities: ["TEXT"] }, inputAudioTranscription: { languageCodes: ["en-US"], customVocabulary: ["Zhivex"], mode: "SMART" } } });
      await session.sendAudio({ data: "AQID", mediaType: "audio/pcm;rate=16000" });
      await session.setInputMuted(true);
      expect(sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
      await session.sendAudio({ data: "AQID", mediaType: "audio/pcm;rate=16000" });
      await session.setInputMuted(true);
      expect(sent).toHaveLength(3);
      await session.setInputMuted(false);
      await session.sendAudio({ data: "AQID", mediaType: "audio/pcm;rate=16000" });
      expect(sent).toHaveLength(4);
      await expect(session.sendToolResult({ toolCallId: "id", toolName: "lookup", output: {}, isError: false })).rejects.toThrow("tool results");
      await expect(session.sendText("hello")).rejects.toThrow("audio input");
      await expect(session.sendMedia({ data: "AQID", mediaType: "image/png" })).rejects.toThrow();
    } finally { await session.close(); }
  });
  it("preserves revisable interim hypotheses and emits completed input transcripts", async () => {
    const { vertex } = setup([
      { serverContent: { interimInputTranscription: { text: "hello word" } } },
      { server_content: { interim_input_transcription: { text: "hello world" } } },
      { serverContent: { inputTranscription: { text: "hello world", languageCode: "en-US" } } }
    ]);
    const session = await vertex.realtimeModel!(modelId).connect();
    const seen = [];
    try {
      for await (const event of session.eventStream()) {
        seen.push(event);
        if (event.type === "realtime-transcript") {
          expect(event).toMatchObject({ role: "user", text: "hello world", isFinal: true });
          break;
        }
      }
      const interim = seen.filter(event => event.type === "realtime-provider-data");
      expect(interim).toMatchObject([
        { provider: "vertex", data: { type: "vertex_transcription_interim", transcription: { text: "hello word" } } },
        { provider: "vertex", data: { type: "vertex_transcription_interim", transcription: { text: "hello world" } } }
      ]);
      expect(seen.filter(event => event.type === "realtime-transcript")).toHaveLength(1);
    } finally { await session.close(); }
  });
  it.each<RealtimeSessionConfig>([
    { mode: "conversation" }, { instructions: "answer" }, { voice: "Kore" },
    { inputAudioTranscription: false }, { inputAudioTranscription: { wordTimestamp: true } },
    { inputAudioTranscription: { diarization: true } }, { inputTranscription: { prompt: "answer" } },
    { providerOptions: { generationConfig: { responseModalities: ["AUDIO"] } } }
  ])("rejects incompatible configuration before opening a connection: %j", async config => {
    const { vertex, factory } = setup();
    await expect(vertex.realtimeModel!(modelId).connect(config)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
});
