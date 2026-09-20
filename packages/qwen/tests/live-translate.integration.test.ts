import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RealtimeEvent } from "@zhivex-ai/core";
import { createQwen, type QwenRegion } from "../src/index.js";
const enabled = process.env.QWEN_LIVETRANSLATE_INTEGRATION === "1";
const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
const path = process.env.QWEN_LIVETRANSLATE_PCM_FILE;
if (enabled && (!apiKey || !path)) throw new Error("LiveTranslate integration requires an API key and QWEN_LIVETRANSLATE_PCM_FILE (mono 16 kHz PCM16LE).");
describe.skipIf(!enabled)("Qwen 3.8 LiveTranslate live", () => {
  it.each(process.env.QWEN_LIVETRANSLATE_CLONE ? [true] : [false, true])("translates speech and drains the final response (audio=%s)", async audioOutput => {
    const pcm = await readFile(path!);
    if (!pcm.length || pcm.length > 16000 * 2 * 30 || pcm.length % 2) throw new Error("Use a nonempty PCM16 fixture of at most 30 seconds.");
    const clone = process.env.QWEN_LIVETRANSLATE_CLONE;
    const session = await createQwen({ apiKey, workspaceId: process.env.QWEN_WORKSPACE_ID,
      region: process.env.QWEN_REGION as QwenRegion | undefined, realtimeURL: process.env.QWEN_REALTIME_URL
    }).realtimeModel!("qwen3.8-livetranslate-flash-realtime").connect({
      mode: "translation", translation: { targetLanguage: "es" }, ...(audioOutput ? { outputAudioMediaType: "audio/pcm" } : {}),
      ...(clone ? { voice: "default", providerOptions: { enable_voice_clone: true, voice_clone_options: { frequency: clone } } } : {})
    }, { timeoutMs: 20000 });
    const events: RealtimeEvent[] = [];
    const collect = (async () => { for await (const event of session.eventStream()) events.push(event); })();
    let failure: unknown;
    try {
      for (let offset = 0; offset < pcm.length; offset += 3200) {
        await session.sendAudio({ data: pcm.subarray(offset, offset + 3200), mediaType: "audio/pcm", sampleRateHz: 16000, channels: 1 });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) { failure = error; } finally { await session.close(); await collect; }
    const providerError = events.find(e => e.type === "realtime-error");
    if (providerError?.type === "realtime-error") throw new Error(providerError.message);
    if (failure) throw failure;
    expect(events.filter(e => e.type === "realtime-error")).toEqual([]);
    if (clone) {
      const configured = events.find(e => e.type === "realtime-provider-data" && e.data && typeof e.data === "object" && !Array.isArray(e.data) && e.data.type === "session.updated");
      expect(configured).toMatchObject({ data: { session: { enable_voice_clone: true, voice_clone_options: { frequency: clone } } } });
    }
    expect(events.some(e => e.type === "realtime-transcript" && e.role === "user" && e.text.length > 0)).toBe(true);
    const translation = events.map(e => e.type === "realtime-transcript" && e.role === "assistant" ? e.text : e.type === "realtime-text-delta" ? e.textDelta : "").join("");
    expect(translation.length).toBeGreaterThan(0);
    if (process.env.QWEN_LIVETRANSLATE_EXPECT_TEXT) expect(translation.toLowerCase()).toContain(process.env.QWEN_LIVETRANSLATE_EXPECT_TEXT.toLowerCase());
    expect(events.some(e => e.type === "realtime-audio-output" && e.audio.length > 0)).toBe(audioOutput);
    expect(events.some(e => e.type === "realtime-end" && e.reason === "finished")).toBe(true);
  }, 60000);
});
