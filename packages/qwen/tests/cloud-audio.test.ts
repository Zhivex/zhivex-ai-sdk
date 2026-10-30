import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { QwenCloudSpeechModel, QwenCloudStreamingASRModel } from "../src/inference-audio.js";
import { mapQwenCloudRealtimeSession, qwenCloudAudioEvent, validateQwenCloudAudioFrame } from "../src/cloud-realtime.js";
import { tool, type RealtimeConnectionFactory } from "@zhivex-ai/core";

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
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { providerOptions }, {})).toThrow("MCP requires");
  });
  it("maps 3.1 Flash tools together with web search and smart_turn_v2", () => {
    const providerOptions = { enable_search: true, search_options: { enable_source: true }, output_audio: { language: "en" } };
    const turnDetection = { type: "smart_turn_v2", voiceprint_audio_urls: ["https://example.com/speaker.wav"] };
    const mapped = mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { voice: "longanqian_v3.1", turnDetection, providerOptions }, {
      ...providerOptions, voice: "longanqian_v3.1", turn_detection: turnDetection, tools: [{ type: "function", function: { name: "get_weather" } }]
    });
    expect(mapped).toMatchObject({ enable_search: true, search_options: { enable_source: true }, output_audio: { language: "en" }, turn_detection: turnDetection });
    expect(mapped.tools).toEqual([{ type: "function", function: { name: "get_weather" } }]);
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-plus", { providerOptions }, { tools: [{ type: "function" }], enable_search: true })).toThrow("mutually exclusive");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.0-realtime-flash", { providerOptions }, { tools: [{ type: "function" }], enable_search: true })).toThrow("mutually exclusive");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { providerOptions: { enable_thinking: false } }, {})).toThrow("enable_thinking");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { turnDetection: { type: "semantic_vad" } }, {})).toThrow("smart_turn_v2");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { turnDetection: { type: "server_vad", voiceprint_audio_urls: ["https://example.com/a.wav"] } }, {})).toThrow("smart_turn");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { turnDetection: { type: "smart_turn", voiceprint_audio_urls: [] } }, {})).toThrow("1 to 5");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { turnDetection: { type: "smart_turn", voiceprint_audio_urls: Array.from({ length: 6 }, () => "https://example.com/a.wav") } }, {})).toThrow("1 to 5");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { turnDetection: { type: "smart_turn_v2", voiceprint_audio_urls: ["http://example.com/a.wav"] } }, {})).toThrow("HTTPS");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { turnDetection: { type: "smart_turn_v2", voiceprint_audio_urls: ["https://user:pass@example.com/a.wav"] } }, {})).toThrow("HTTPS");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { providerOptions: { search_options: { enable_source: "yes" } } }, {})).toThrow("enable_source");
    expect(() => mapQwenCloudRealtimeSession("qwen-audio-3.1-realtime-flash", { providerOptions: { search_options: null } }, {})).toThrow("enable_source");
  });
  it("keeps published audio realtime models on the previous pass-through contract", () => {
    const published = ["qwen-audio-3.0-realtime-flash", "qwen-audio-3.0-realtime-plus", "qwen-audio-3.1-realtime-plus"];
    const looseTurn = { type: "smart_turn_v2", voiceprint_audio_urls: ["http://example.com/a.wav", "https://user:pass@example.com/a.wav"] };
    const serverVadUrls = { type: "server_vad", voiceprint_audio_urls: ["not-a-url"] };
    const sixUrls = { type: "smart_turn", voiceprint_audio_urls: Array.from({ length: 6 }, () => "https://example.com/a.wav") };
    const emptyUrls = { type: "smart_turn_v2", voiceprint_audio_urls: [] };
    for (const id of published) {
      expect(mapQwenCloudRealtimeSession(id, { turnDetection: looseTurn }, { turn_detection: looseTurn }).turn_detection).toEqual(looseTurn);
      expect(mapQwenCloudRealtimeSession(id, { turnDetection: serverVadUrls }, { turn_detection: serverVadUrls }).turn_detection).toEqual(serverVadUrls);
      expect(mapQwenCloudRealtimeSession(id, { turnDetection: sixUrls }, { turn_detection: sixUrls }).turn_detection).toEqual(sixUrls);
      expect(mapQwenCloudRealtimeSession(id, { turnDetection: emptyUrls }, { turn_detection: emptyUrls }).turn_detection).toEqual(emptyUrls);
      expect(mapQwenCloudRealtimeSession(id, { providerOptions: { search_options: { enable_source: "yes" } } }, { search_options: { enable_source: "yes" } }).search_options).toEqual({ enable_source: "yes" });
      expect(mapQwenCloudRealtimeSession(id, { providerOptions: { search_options: null } }, { search_options: null }).search_options).toBeNull();
      expect(() => mapQwenCloudRealtimeSession(id, { turnDetection: { type: "semantic_vad" } }, {})).toThrow("smart_turn_v2");
      expect(() => mapQwenCloudRealtimeSession(id, { providerOptions: { enable_search: true } }, { tools: [{ type: "function" }], enable_search: true })).toThrow("mutually exclusive");
    }
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
  it("Audio 3.1 Flash accepts tools with search and keeps a voiceprint failure open", async () => {
    const f = await fixture("qwen-audio-3.1-realtime-flash", {
      voice: "longanqian_v3.1",
      turnDetection: { type: "smart_turn_v2", voiceprint_audio_urls: ["https://example.com/speaker.wav"] },
      tools: { weather: tool({ name: "weather", schema: z.object({ city: z.string() }), execute: () => ({ ok: true }) }) },
      providerOptions: { enable_search: true, search_options: { enable_source: true }, output_audio: { language: "en" } }
    });
    expect(f.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        voice: "longanqian_v3.1",
        enable_search: true,
        search_options: { enable_source: true },
        output_audio: { language: "en" },
        turn_detection: { type: "smart_turn_v2", voiceprint_audio_urls: ["https://example.com/speaker.wav"] },
        tools: [{ type: "function", function: { name: "weather" } }]
      }
    });
    expect(f.session.capabilities).toMatchObject({
      tools: true, vision: false, audioInput: true, audioOutput: true, webSearch: true, reasoning: false,
      agentCapabilities: { supportTier: "tier-b", hostedWebSearch: true, remoteMcp: false },
      realtime: { audioInput: true, audioOutput: true, imageInput: false, tools: true }
    });
    const events: any[] = [];
    const collecting = (async () => { for await (const event of f.session.eventStream()) events.push(event); })();
    await new Promise(resolve => setTimeout(resolve, 0));
    f.push({ type: "voiceprint_audio_list.failed", item_id: "vp_1", reason: "unreachable" });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "realtime-provider-data", data: expect.objectContaining({ type: "voiceprint_audio_list.failed" }) })));
    await f.session.sendText("still open");
    expect(f.sent.at(-2)?.type).toBe("conversation.item.create");
    expect(f.sent.at(-1)?.type).toBe("response.create");
    await f.session.close();
    await collecting;
  });
  it("published audio realtime models still reject tools combined with web search", async () => {
    const tools = { weather: tool({ name: "weather", schema: z.object({ city: z.string() }), execute: () => ({ ok: true }) }) };
    for (const modelId of ["qwen-audio-3.0-realtime-flash", "qwen-audio-3.0-realtime-plus", "qwen-audio-3.1-realtime-plus"]) {
      await expect(fixture(modelId, { tools, providerOptions: { enable_search: true } })).rejects.toThrow("cannot be enabled together");
    }
  });
  it("published audio realtime models forward loose voiceprint and search fields and keep voiceprint failures open", async () => {
    const turnDetection = { type: "smart_turn_v2", voiceprint_audio_urls: ["http://example.com/a.wav"] };
    for (const modelId of ["qwen-audio-3.0-realtime-flash", "qwen-audio-3.0-realtime-plus", "qwen-audio-3.1-realtime-plus"]) {
      const f = await fixture(modelId, { turnDetection, providerOptions: { search_options: { enable_source: "yes" } } });
      expect(f.sent[0]).toMatchObject({
        type: "session.update",
        session: { turn_detection: turnDetection, search_options: { enable_source: "yes" } }
      });
      const events: any[] = [];
      const collecting = (async () => { for await (const event of f.session.eventStream()) events.push(event); })();
      await new Promise(resolve => setTimeout(resolve, 0));
      f.push({ type: "voiceprint_audio_list.in_progress", item_id: "vp_1" });
      f.push({ type: "voiceprint_audio_list.failed", item_id: "vp_1", reason: "unreachable" });
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "realtime-provider-data", data: expect.objectContaining({ type: "voiceprint_audio_list.failed" }) })));
      expect(events.some(event => event.type === "realtime-error")).toBe(false);
      await f.session.sendText("still open");
      expect(f.sent.at(-1)?.type).toBe("response.create");
      await f.session.close();
      await collecting;
    }
  });
  it("non-audio realtime models still fail the session on voiceprint_audio_list.failed", async () => {
    const omni = await fixture("qwen3.8-omni-flash-realtime");
    const omniEvents: any[] = [];
    const omniCollecting = (async () => { for await (const event of omni.session.eventStream()) omniEvents.push(event); })();
    await new Promise(resolve => setTimeout(resolve, 0));
    omni.push({ type: "voiceprint_audio_list.failed", item_id: "vp_1", reason: "unreachable" });
    await vi.waitFor(() => expect(omniEvents).toContainEqual(expect.objectContaining({ type: "realtime-error", message: "Qwen realtime error" })));
    expect(omniEvents.some(event => event.data?.type === "voiceprint_audio_list.failed")).toBe(false);
    await expect(omni.session.sendText("closed")).rejects.toThrow("not open");
    await omniCollecting;

    const legacy = await fixture("qwen3.5-omni-plus-realtime");
    const legacyEvents: any[] = [];
    const legacyCollecting = (async () => { for await (const event of legacy.session.eventStream()) legacyEvents.push(event); })();
    await new Promise(resolve => setTimeout(resolve, 0));
    legacy.push({ type: "voiceprint_audio_list.in_progress", item_id: "vp_1" });
    legacy.push({ type: "voiceprint_audio_list.completed", item_id: "vp_1" });
    legacy.push({ type: "voiceprint_audio_list.failed", item_id: "vp_1", reason: "unreachable" });
    await vi.waitFor(() => expect(legacyEvents).toContainEqual(expect.objectContaining({ type: "realtime-error" })));
    expect(legacyEvents.some(event => event.type === "realtime-provider-data")).toBe(false);
    await expect(legacy.session.sendText("closed")).rejects.toThrow("not open");
    await legacyCollecting;
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
