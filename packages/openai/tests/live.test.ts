import { describe, expect, it, vi } from "vitest";
import { createOpenAI } from "../src/index.js";
import { streamLiveAgent, type RealtimeConnection, type RealtimeEvent, type RealtimeSessionConfig } from "@zhivex-ai/core";

class Connection implements RealtimeConnection {
  sent: Record<string, unknown>[] = [];
  queue: unknown[] = [];
  waiter?: (value: unknown) => void;
  autoStart = true;
  autoClose = true;
  closed = false;
  push(value: unknown) { if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(value); } else this.queue.push(value); }
  async sendJson(payload: Record<string, unknown>) {
    this.sent.push(payload);
    if (payload.type === "session.start" && this.autoStart) this.push({ type: "session.started", session: { id: "live_123" } });
    if (payload.type === "session.close" && this.autoClose) this.push({ type: "session.closed", usage: { duration_seconds: 2 } });
  }
  async recvJson() { return this.queue.length ? this.queue.shift() : this.closed ? undefined : new Promise((resolve) => { this.waiter = resolve; }); }
  async close() { this.closed = true; this.push(undefined); }
}

const setup = () => {
  const connection = new Connection();
  const factory = vi.fn(async () => connection);
  const provider = createOpenAI({ apiKey: "test-key", realtimeConnectionFactory: factory });
  return { connection, factory, provider, model: provider.realtimeModel!("gpt-live-1") };
};

describe("GPT-Live client delegation", () => {
  it("starts the dedicated endpoint without a model query and waits for acknowledgement", async () => {
    const { connection, factory, model } = setup();
    connection.autoStart = false;
    let ready = false;
    const promise = model.connect({ instructions: "Delegate tasks.", voice: "quartz", providerOptions: { safety_identifier: "user-hash" } }).then((session) => { ready = true; return session; });
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    expect(ready).toBe(false);
    expect(factory.mock.calls[0]).toEqual(["wss://api.openai.com/v1/live/sessions", { authorization: "Bearer test-key", "OpenAI-Safety-Identifier": "user-hash" }, undefined]);
    expect(connection.sent[0]).toEqual({ type: "session.start", session: {
      model: "gpt-live-1", instructions: "Delegate tasks.", audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "quartz" } },
      delegation: { type: "client" }, store: false
    } });
    connection.push({ type: "session.started", session: { id: "live_123" } });
    const session = await promise;
    expect(model.capabilities.realtime).toMatchObject({ fullDuplex: true, clientDelegation: true, browserTokens: false, tools: false });
    await session.close();
  });

  it("streams continuous PCM, preserves transcripts and IDs, and waits for final usage", async () => {
    const { connection, model } = setup();
    const session = await model.connect();
    const events: RealtimeEvent[] = [];
    const drain = (async () => { for await (const event of session.eventStream()) events.push(event); })();
    await session.sendAudio({ data: new Uint8Array([1, 0]), mediaType: "audio/pcm", sampleRateHz: 24000, isFinal: true });
    expect(connection.sent.slice(1)).toEqual([{ type: "session.input_audio.append", audio: "AQA=" }]);
    connection.push({ type: "session.input_transcript.delta", delta: "Order ", start_ms: 1, end_ms: 10 });
    connection.push({ type: "session.output_transcript.delta", delta: "Yes", start_ms: 5, end_ms: 12 });
    connection.push({ type: "session.output_audio.delta", delta: "AQA=" });
    connection.push({ type: "session.delegation.created", offset_ms: 12, delegation: { id: "item_original", target: "client" } });
    await vi.waitFor(() => expect(events.some((e) => e.type === "realtime-delegation")).toBe(true));
    expect(events).toContainEqual(expect.objectContaining({ type: "realtime-transcript", role: "user", text: "Order ", startMs: 1, endMs: 10, isFinal: false }));
    expect(events).toContainEqual(expect.objectContaining({ type: "realtime-audio-output", audio: new Uint8Array([1, 0]), sampleRateHz: 24000 }));
    await session.appendContext!({ kind: "commentary", content: "Shipped.", delegationId: "item_original", eventId: "result_1" });
    expect(connection.sent.at(-1)).toEqual({ type: "session.commentary.append", content: "Shipped.", delegation_id: "item_original", event_id: "result_1" });
    await session.appendContext!({ kind: "context", content: "Current order: 42" });
    expect(connection.sent.at(-1)).toMatchObject({ type: "session.thinking.append", delegation_id: null });
    await session.setInputMuted!(true);
    expect(connection.sent.at(-1)).toEqual({ type: "session.input_audio.mute" });
    connection.autoClose = false;
    const close = session.close();
    const repeatedClose = session.close();
    await vi.waitFor(() => expect(connection.sent.at(-1)?.type).toBe("session.close"));
    expect(connection.closed).toBe(false);
    await expect(session.sendAudio({ data: "AQA=", mediaType: "audio/pcm" })).rejects.toThrow("not open");
    connection.push({ type: "session.usage.updated", usage: { duration_seconds: 3 } });
    connection.push({ type: "session.closed", usage: { duration_seconds: 4 } });
    await Promise.all([close, repeatedClose, drain]);
    expect(connection.sent.filter((e) => e.type === "session.close")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "realtime-end", providerMetadata: { usage: { duration_seconds: 4 } } });
    expect(events.some((e) => e.type === "realtime-response-complete")).toBe(false);
    const replay: RealtimeEvent[] = [];
    for await (const e of session.eventStream()) replay.push(e);
    expect(replay.some((e) => e.type === "realtime-audio-output")).toBe(false);
  });

  it.each([
    { inputSampleRateHz: 48000 }, { channels: 2 }, { inputSampleRateHz: 16000, outputSampleRateHz: 24000 },
    { autoResponse: true }, { tools: {} }, { providerOptions: { delegation: { type: "responses" } } },
    { delegation: { type: "responses" } }, { providerOptions: { input: [{ role: "system" }] } },
    { providerOptions: { closeTimeoutMs: 0 } }
  ])("rejects unsupported configuration before opening a socket: %j", async (config) => {
    const { model, factory } = setup();
    await expect(model.connect(config as RealtimeSessionConfig)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(["audio/pcmu", "audio/pcma"])("supports %s without PCM alignment", async (mediaType) => {
    const { model, connection } = setup();
    const session = await model.connect({ inputAudioMediaType: mediaType });
    await session.sendAudio({ data: new Uint8Array([1]), mediaType, sampleRateHz: 8000 });
    expect(connection.sent.at(-1)).toEqual({ type: "session.input_audio.append", audio: "AQ==" });
    await session.close();
  });

  it("rejects invalid frames, unrelated delegation IDs and legacy commands without closing", async () => {
    const { model } = setup();
    const session = await model.connect();
    await expect(session.sendAudio({ data: new Uint8Array([1]), mediaType: "audio/pcm" })).rejects.toThrow("complete 16-bit");
    await expect(session.sendAudio({ data: "AQA=", mediaType: "audio/wav" })).rejects.toThrow("format");
    await expect(session.appendContext!({ kind: "commentary", content: "Done", delegationId: "invented" })).rejects.toThrow("Unknown");
    await expect(session.sendText("Hello")).rejects.toThrow("typed user input");
    await expect(session.sendToolResult({ toolCallId: "x", toolName: "x", output: 1, isError: false })).rejects.toThrow("tool results");
    await expect(session.update({ voice: "quartz" })).rejects.toThrow("immutable");
    await expect(model.createBrowserToken!()).rejects.toThrow("WebRTC");
    expect(() => streamLiveAgent({ model })).toThrow("runRealtimeDelegations");
    await session.close();
  });

  it("times out startup and closes the transport", async () => {
    const { model, connection } = setup();
    connection.autoStart = false;
    await expect(model.connect({}, { timeoutMs: 5 })).rejects.toThrow("timed out");
    expect(connection.closed).toBe(true);
  });

  it("reports incomplete close and transport failure rather than inventing final usage", async () => {
    const { model, connection } = setup();
    const session = await model.connect({ providerOptions: { closeTimeoutMs: 5 } });
    connection.autoClose = false;
    await expect(session.close()).rejects.toThrow("final usage is unconfirmed");
    expect(connection.closed).toBe(true);
    const other = setup();
    const otherSession = await other.model.connect();
    other.connection.push(undefined);
    const events: RealtimeEvent[] = [];
    for await (const e of otherSession.eventStream()) events.push(e);
    expect(events.some((e) => e.type === "realtime-error")).toBe(true);
  });

  it("preserves provider error metadata", async () => {
    const { model, connection } = setup();
    const session = await model.connect();
    connection.push({ type: "error", error: { message: "bad append", client_event_id: "append_1" } });
    const events: RealtimeEvent[] = [];
    for await (const event of session.eventStream()) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: "realtime-error", message: "bad append", providerMetadata: { type: "error", error: { message: "bad append", client_event_id: "append_1" } } }));
  });

  it("rejects unsafe endpoints and use as a text model", async () => {
    const { provider, factory } = setup();
    expect(() => provider("gpt-live-1")).toThrow("voice model");
    expect(() => provider.realtimeModel!("gpt-live-1-mini")).toThrow("Unsupported GPT-Live model");
    const bad = createOpenAI({ apiKey: "test", realtimeConnectionFactory: factory, realtimeURL: "wss://api.openai.com/v1/live/sessions?model=gpt-live-1" });
    await expect(bad.realtimeModel!("gpt-live-1").connect()).rejects.toThrow("query");
    expect(factory).not.toHaveBeenCalled();
  });
});
