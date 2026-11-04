import { describe, expect, it, vi } from "vitest";
import { createQwen } from "../src/index.js";
import { isQwenCloudSpeech } from "../src/inference-audio.js";
describe("Qwen TTS 3.1", () => {
  it.each(["qwen-audio-3.1-tts-flash", "qwen-audio-3.1-tts-plus"])("keeps %s on native inference", model => expect(isQwenCloudSpeech(model)).toBe(true));
  it("routes Next to AudioGen and downloads with the existing URL policy", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ output: { audio: { data: "", url: "https://example.com/audio.wav" } } })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/wav" } }));
    const model = createQwen({ apiKey: "test", fetch: fetcher, speechAudioURLValidator: url => url.hostname === "example.com" }).speechModel!("qwen-audio-3.1-tts-next");
    const result = await model.generateSpeech({ input: "A calm voice says hello", providerOptions: { input: { format: "wav", channels: 2, references: [{ audio_url: "https://example.com/ref.wav" }] } } });
    expect(fetcher.mock.calls[0][0]).toContain("/services/audio/tts/SpeechSynthesizer");
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.input).toEqual({ text_prompt: "A calm voice says hello", format: "wav", channels: 2, references: [{ audio_url: "https://example.com/ref.wav" }] });
    expect(result.audio).toEqual(new Uint8Array([1, 2]));
    expect(result.mediaType).toBe("audio/wav");
  });
  it("rejects voice IDs and does not retry paid generations", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ message: "temporary failure" }, { status: 500 }));
    const model = createQwen({ apiKey: "test", fetch: fetcher, speechAudioURLValidator: url => url.hostname === "example.com" }).speechModel!("qwen-audio-3.1-tts-next");
    await expect(model.generateSpeech({ input: "Hello", voice: "Cherry" })).rejects.toThrow("reference audio");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(model.generateSpeech({ input: "Hello", maxRetries: 2, retryBackoffMs: 0 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
