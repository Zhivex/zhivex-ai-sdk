import { describe, expect, it } from "vitest";
import type { RealtimeSession } from "@zhivex-ai/core";
import { createQwen } from "../src/index.js";

// Paid calls are opt-in. Fixtures contain only synthetic greetings, never microphone recordings.
const enabled = process.env.QWEN_CLOUD_AUDIO_INTEGRATION === "1";
const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
if (enabled && !apiKey) throw new Error("Qwen Cloud audio smoke requires QWEN_API_KEY or DASHSCOPE_API_KEY.");
const provider = () => createQwen({
  apiKey,
  baseURL: process.env.QWEN_BASE_URL ?? "https://maas.qwencloudapi.com/compatible-mode/v1",
});
const budget = () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Audio live smoke exceeded its 30-second budget.")), 30_000);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
};

describe.skipIf(!enabled)("Qwen Cloud inexpensive audio live routes", () => {
  it("synthesizes one greeting with TTS Flash and reuses it for ASR Flash Streaming", async () => {
    const deadline = budget();
    try {
      const qwen = provider();
      const speech = await qwen.speechModel!("qwen-audio-3.0-tts-flash").generateSpeech({
        input: "Hello.", voice: "longanhuan_v3.6",
        providerOptions: { format: "pcm", sample_rate: 16000 },
        abortSignal: deadline.signal, timeoutMs: 30_000, maxRetries: 0,
      });
      expect(speech.mediaType).toBe("audio/pcm");
      expect(speech.audio.byteLength).toBeGreaterThan(0);
      expect(speech.audio.byteLength).toBeLessThan(320_000); // At most ten seconds of PCM16 mono.
      const transcript = await qwen.streamingASRModel("qwen-audio-3.0-asr-flash-streaming").transcribe({
        audio: { data: speech.audio, mediaType: "audio/pcm" }, language: "en",
        abortSignal: deadline.signal, timeoutMs: 30_000, maxRetries: 0,
      });
      expect(transcript.text.toLowerCase()).toContain("hello");
    } finally { deadline.cleanup(); }
  }, 35_000);

  for (const [modelId, voice] of [
    ["qwen-audio-3.0-realtime-flash", "longanqian"],
    ["qwen3.8-omni-flash-realtime", "Tina"],
  ] as const) {
    it(`${modelId}: completes a one-word voice response`, async () => {
      const deadline = budget();
      let session: RealtimeSession | undefined;
      try {
        session = await provider().realtimeModel(modelId).connect({
          voice, instructions: "Reply with exactly: Hi.", outputAudioMediaType: "audio/pcm",
          turnDetection: null,
        }, { signal: deadline.signal, timeoutMs: 30_000 });
        await session.sendText("Say hi.");
        let audioBytes = 0;
        let transcript = "";
        let completed = false;
        for await (const event of session.eventStream()) {
          if (event.type === "realtime-error") throw new Error(event.message);
          if (event.type === "realtime-audio-output") {
            audioBytes += event.audio.byteLength;
            expect(event.mediaType).toBe("audio/pcm");
            expect(event.sampleRateHz).toBe(24000);
            expect(audioBytes).toBeLessThan(480_000); // Fail and close if the short response exceeds ten seconds.
          }
          if (event.type === "realtime-text-delta") transcript += event.textDelta;
          if (event.type === "realtime-transcript") transcript += event.text;
          if (event.type === "realtime-response-complete") { completed = true; break; }
        }
        expect(completed).toBe(true);
        expect(audioBytes).toBeGreaterThan(0);
        expect(transcript.trim()).not.toBe("");
      } finally { deadline.cleanup(); await session?.close(); }
    }, 35_000);
  }
});
