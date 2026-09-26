import { describe, expect, it, vi } from "vitest";
import { QwenCloudSpeechModel, QwenCloudStreamingASRModel } from "../src/inference-audio.js";
import { mapQwenCloudRealtimeSession, qwenCloudAudioEvent, validateQwenCloudAudioFrame } from "../src/cloud-realtime.js";
import type { RealtimeConnectionFactory } from "@zhivex-ai/core";

const inference = (kind: "tts" | "asr", failure?: string) => {
  const sent: any[] = [];
  const binary: Uint8Array[] = [];
  const queue: any[] = [];
  let reader: ((value: any) => void) | undefined;
  const push = (value: any) => { if (reader) { const read = reader; reader = undefined; read(value); } else queue.push(value); };
  const close = vi.fn(async () => {});
  const factory: RealtimeConnectionFactory = async () => ({
    async sendJson(payload: any) {
      sent.push(payload);
      const task_id = payload.header.task_id;
      if (payload.header.action === "run-task") push({ header: { task_id, event: failure ? "task-failed" : "task-started", error_message: failure } });
      if (payload.header.action === "finish-task") {
        if (kind === "tts") { push(new Uint8Array([1, 2])); push(new Uint8Array([3, 4])); }
        else push({ header: { task_id, event: "result-generated" }, payload: { output: { sentence: { text: "Hello", sentence_end: true, begin_time: 0, end_time: 100 } } } });
        push({ header: { task_id, event: "task-finished" } });
      }
    },
    async sendBinary(data) { binary.push(data); },
    async recvJson() { throw new Error("binary transport required"); },
    async recvFrame() { return queue.length ? queue.shift() : new Promise(resolve => { reader = resolve; }); },
    close
  });
  return { factory, sent, binary, close };
};
describe("Qwen Cloud inference audio", () => {
  it("runs duplex TTS, aggregates binary frames and closes", async () => {
    const fixture = inference("tts");
    const model = new QwenCloudSpeechModel("qwen-audio-3.0-tts-flash", "fake", "wss://example.test/inference", fixture.factory);
    const result = await model.generateSpeech({ input: "Hi", providerOptions: { format: "wav", sample_rate: 24000 } });
    expect(result.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.mediaType).toBe("audio/wav");
    expect(fixture.sent.map(value => value.header.action)).toEqual(["run-task", "continue-task", "finish-task"]);
    expect(fixture.sent[0].payload).toMatchObject({ model: model.modelId, task: "tts", parameters: { voice: "longanhuan_v3.6", format: "wav" } });
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("surfaces task failure without retry and closes", async () => {
    const fixture = inference("tts", "Model access denied");
    await expect(new QwenCloudSpeechModel("qwen-audio-3.0-tts-flash", "fake", "wss://example.test", fixture.factory).generateSpeech({ input: "Hi" })).rejects.toThrow("Model access denied");
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("rejects invalid parameters before opening a paid task", async () => {
    const fixture = inference("tts");
    await expect(new QwenCloudSpeechModel("qwen-audio-3.0-tts-flash", "fake", "wss://example.test", fixture.factory).generateSpeech({ input: "Hi", providerOptions: { rate: 100 } })).rejects.toThrow("rate");
    expect(fixture.sent).toHaveLength(0);
  });
  it("closes stalled TTS when the operation deadline expires", async () => {
    const close = vi.fn(async () => {});
    const factory: RealtimeConnectionFactory = async () => ({
      async sendJson() {}, async sendBinary() {}, async recvJson() {},
      async recvFrame() { return new Promise(() => {}); }, close
    });
    const model = new QwenCloudSpeechModel("qwen-audio-3.0-tts-flash", "fake", "wss://example.test", factory);
    await expect(model.generateSpeech({ input: "Hi", timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(close).toHaveBeenCalledOnce();
  });
  it("releases inference transport when a speech consumer stops early", async () => {
    const f = inference("tts");
    const model = new QwenCloudSpeechModel("qwen-audio-3.0-tts-flash", "fake", "wss://example.test", f.factory);
    for await (const chunk of await model.streamSpeech({ input: "Hi" })) { expect(chunk.audio.length).toBe(2); break; }
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("streams binary ASR in bounded chunks with prompt context and language", async () => {
    const fixture = inference("asr");
    const model = new QwenCloudStreamingASRModel("qwen-audio-3.1-asr-flash-streaming", "fake", "wss://example.test", fixture.factory);
    const result = await model.transcribe({ audio: { data: new Uint8Array(6400), mediaType: "audio/pcm" }, prompt: "Hello", language: "en" });
    expect(result.text).toBe("Hello");
    expect(fixture.binary).toHaveLength(2);
    expect(fixture.sent[0].payload).toMatchObject({ task: "asr", function: "recognition", parameters: { language_hints: ["en"] }, input: { context: [{ role: "user" }] } });
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});
describe("Qwen Cloud realtime profiles", () => {
  it("maps multichannel audio, compact video, and MCP with safe default approval", () => {
    const config = { channels: 4, outputSampleRateHz: 48000, providerOptions: { mcpServers: [{ type: "mcp", server_label: "weather", server_url: "https://example.com/mcp" }], video: { input: { representation_compact: "normal" } } } };
    const mapped = mapQwenCloudRealtimeSession("qwen3.8-omni-flash-realtime", config, { ...config.providerOptions });
    expect(mapped.audio.input.format).toMatchObject({ channels: 4, channel_layout: "foa_ambix" });
    expect(mapped.audio.output.format.sample_rate).toBe(48000);
    expect(mapped.tools[0].require_approval).toBe("always");
    expect(mapped.mcpServers).toBeUndefined();
  });
  it("rejects MCP plus search and non-Omni MCP", () => {
    const providerOptions = { mcpServers: [{ type: "mcp", server_label: "weather", server_url: "https://example.com/mcp" }], enable_search: true };
    expect(() => mapQwenCloudRealtimeSession("qwen3.8-omni-flash-realtime", { providerOptions }, {})).toThrow("mutually exclusive");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-plus", { providerOptions }, {})).toThrow("MCP requires");
  });
  it("rejects incomplete multichannel samples and preserves output metadata", () => {
    expect(() => validateQwenCloudAudioFrame({ data: new Uint8Array(6), mediaType: "audio/pcm", channels: 4 }, { channels: 4 })).toThrow("complete interleaved");
    const [event] = qwenCloudAudioEvent({ type: "response.audio.delta", delta: "AQI=" }, { outputAudioMediaType: "audio/wav", outputSampleRateHz: 48000 })!;
    expect(event).toMatchObject({ mediaType: "audio/wav", sampleRateHz: 48000 });
  });
});

describe("Qwen Cloud realtime integration", () => {
  const fixture = async (modelId = "qwen3.8-omni-flash-realtime", config: any = {}) => {
    const { createQwen } = await import("../src/index.js");
    const sent: any[] = [];
    const queue: unknown[] = [];
    let waiter: ((value: unknown) => void) | undefined;
    const push = (value: unknown) => { if (waiter) { const read = waiter; waiter = undefined; read(value); } else queue.push(value); };
    const factory: RealtimeConnectionFactory = async () => ({
      async sendJson(payload) { sent.push(payload); if (payload.type === "session.update") push({ type: "session.updated" }); },
      async recvJson() { return queue.length ? queue.shift() : new Promise(resolve => { waiter = resolve; }); },
      async close() { push(undefined); }
    });
    const session = await createQwen({ apiKey: "fake", realtimeConnectionFactory: factory }).realtimeModel!(modelId).connect(config);
    return { session, sent, push };
  };
  it("uses manual commits only and rejects immutable format changes after audio", async () => {
    const f = await fixture(undefined, { channels: 2 });
    await f.session.sendAudio({ data: new Uint8Array(4), mediaType: "audio/pcm", channels: 2, isFinal: true });
    expect(f.sent.map(event => event.type)).toEqual(["session.update", "input_audio_buffer.append"]);
    await expect(f.session.update({ channels: 4 })).rejects.toThrow("before audio");
    expect(f.session.config.channels).toBe(2);
    await f.session.close();
  });
  it("emits MCP approval responses and supports manual continuation", async () => {
    const f = await fixture();
    const session = f.session as import("../src/cloud-realtime.js").QwenCloudRealtimeSession;
    f.push({ type: "conversation.item.created", item: { type: "mcp_approval_request", id: "opaque-request" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.respondToMcpApproval("opaque-request", false);
    await expect(session.respondToMcpApproval("opaque-request", true)).rejects.toThrow("already handled");
    await session.createResponse();
    expect(f.sent.at(-2)).toEqual({ type: "conversation.item.create", item: { type: "mcp_approval_response", approval_request_id: "opaque-request", approve: false } });
    expect(f.sent.at(-1)).toEqual({ type: "response.create" });
    await session.close();
  });
  it("Audio 3.1 supports manual speech turns and rejects vision/voice updates", async () => {
    const f = await fixture("qwen-audio-3.1-realtime-plus", { turnDetection: null, voice: "beth_v3.1" });
    await f.session.sendAudio({ data: new Uint8Array(4), mediaType: "audio/pcm", isFinal: true });
    expect(f.sent.map(event => event.type)).toEqual(["session.update", "input_audio_buffer.append", "input_audio_buffer.commit", "response.create"]);
    await expect(f.session.sendMedia({ data: new Uint8Array(2), mediaType: "image/jpeg" })).rejects.toThrow();
    await expect(f.session.update({ voice: "cally_v3.1" })).rejects.toThrow("voice is fixed");
    expect(f.session.capabilities.realtime?.imageInput).toBe(false);
    await f.session.close();
  });
});
