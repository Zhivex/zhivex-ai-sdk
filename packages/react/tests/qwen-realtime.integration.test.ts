import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createQwen, type QwenRegion } from "../../qwen/src/index.js";
import { createRealtimeRelay } from "../src/realtime-server.js";

const enabled = process.env.QWEN_REACT_INTEGRATION === "1";
(enabled ? describe : describe.skip)("Qwen React relay live certification", () => {
  it("streams real PCM and transcripts, interrupts an active response and reuses the session", async () => {
    const qwen = createQwen({ baseURL: process.env.QWEN_BASE_URL, realtimeURL: process.env.QWEN_REALTIME_URL, region: process.env.QWEN_REGION as QwenRegion | undefined });
    const controller = new AbortController();
    const session = await qwen.realtimeModel(process.env.QWEN_REALTIME_MODEL ?? "qwen3.5-omni-flash-realtime").connect({
      inputAudioMediaType: "audio/pcm", outputAudioMediaType: "audio/pcm", inputSampleRateHz: 16000, outputSampleRateHz: 24000, channels: 1, inputAudioTranscription: true,
      instructions: "Follow the user's instructions. Speak in English.", turnDetection: { type: "server_vad" }
    }, { timeoutMs: 20000, signal: controller.signal });
    const frames: any[] = [];
    let closed = false;
    const relay = createRealtimeRelay({ session, maxSessionMs: 80000, send: data => { frames.push(JSON.parse(data)); }, close: () => { closed = true; } });
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 25000;
      while (!predicate()) {
        const error = frames.find(f => f.event?.type === "realtime-error");
        if (error) throw new Error(JSON.stringify(error));
        if (closed || Date.now() > deadline) throw new Error(`Timed out. Events: ${frames.map(f => f.event?.type ?? f.type).join(",")}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    try {
      await relay.receive(JSON.stringify({ type: "text", id: 1, payload: "Count slowly from one to one hundred, spelling out each number." }));
      await waitFor(() => frames.some(f => f.event?.type === "realtime-audio-output"));
      await relay.receive(JSON.stringify({ type: "interrupt", id: 2 }));
      await waitFor(() => frames.some(f => f.event?.type === "realtime-response-complete"));
      expect(frames.find(f => f.type === "ack" && f.id === 2)?.error).toBeUndefined();
      const firstTurn = frames.splice(0);
      await relay.receive(JSON.stringify({ type: "audio", id: 3, payload: { data: Buffer.alloc(3200).toString("base64"), mediaType: "audio/pcm", sampleRateHz: 16000, channels: 1 } }));
      await relay.receive(JSON.stringify({ type: "text", id: 4, payload: "Say exactly: Voice certification complete." }));
      await waitFor(() => frames.some(f => f.event?.type === "realtime-response-complete"));
      expect(frames.find(f => f.type === "ack" && f.id === 3)?.error).toBeUndefined();
      const audio = frames.filter(f => f.event?.type === "realtime-audio-output");
      expect(audio.length).toBeGreaterThan(0);
      const text = frames.filter(f => f.event?.type === "realtime-transcript" || f.event?.type === "realtime-text-delta").map(f => f.event.text ?? f.event.textDelta).join(" ");
      expect(text.toLowerCase()).toContain("certification");
      expect([...firstTurn, ...frames].filter(f => f.event?.type === "realtime-error")).toEqual([]);
      let pcmSpeechVerified = false;
      if (process.env.QWEN_LIVE_PCM_PATH) {
        const pcm = await readFile(process.env.QWEN_LIVE_PCM_PATH);
        if (!pcm.length || pcm.length % 2 || pcm.length > 960000) throw new Error("Expected at most 30 seconds of PCM16LE, 16 kHz mono.");
        const speechFrames = frames.length;
        const padded = Buffer.concat([pcm, Buffer.alloc(64000)]);
        for (let offset = 0; offset < padded.length; offset += 3200) {
          await relay.receive(JSON.stringify({ type: "audio", id: 5 + offset / 3200, payload: { data: padded.subarray(offset, offset + 3200).toString("base64"), mediaType: "audio/pcm", sampleRateHz: 16000, channels: 1 } }));
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await waitFor(() => frames.slice(speechFrames).some(f => f.event?.type === "realtime-response-complete"));
        const speech = frames.slice(speechFrames);
        expect(speech.some(f => f.event?.type === "realtime-audio-output")).toBe(true);
        const transcript = speech.filter(f => f.event?.type === "realtime-transcript").map(f => f.event.text).join(" ");
        expect(transcript.toLowerCase()).toContain("audio input verified");
        expect(speech.some(f => f.event?.type === "realtime-error" || f.type === "ack" && f.error)).toBe(false);
        pcmSpeechVerified = true;
      }
      console.log(JSON.stringify({ model: session.modelId, interruptedAudioFrames: firstTurn.filter(f => f.event?.type === "realtime-audio-output").length, completedAudioFrames: audio.length, pcmInputAcknowledged: true, pcmSpeechVerified }));
    } finally { await relay.close(); controller.abort(); await relay.done; }
    expect(closed).toBe(true);
  }, 90000);
});
