// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useZhivexRealtime, type UseZhivexRealtimeResult, type RealtimeChatSession } from "../src/realtime.js";
import { encodePCM16 } from "../src/realtime-audio.js";
import { createRealtimeRelay } from "../src/realtime-server.js";
import type { AgentLiveEvent, RealtimeSession } from "@zhivex-ai/core";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function channel() {
  const events: AgentLiveEvent[] = []; let done = false; let wake: (() => void) | undefined;
  return { push(event: AgentLiveEvent) { events.push(event); wake?.(); }, close() { done = true; wake?.(); },
    events: (async function* () { while (true) { const event = events.shift(); if (event) yield event; else if (done) return; else await new Promise<void>(resolve => { wake = resolve; }); } })() };
}
function audio() { return { start: vi.fn(async () => {}), startMicrophone: vi.fn(async () => {}), stopMicrophone: vi.fn(), play: vi.fn(), interrupt: vi.fn(), close: vi.fn(async () => {}) }; }

describe("realtime lifecycle", () => {
  it("encodes signed little-endian PCM with clipping", () => {
    expect([...encodePCM16(new Float32Array([-2, 0, 2]))]).toEqual([0, 128, 0, 0, 255, 127]);
  });
  it("closes a late connection after disconnect and ignores its events", async () => {
    let resolve!: (value: RealtimeChatSession) => void;
    const driver = audio(); const ch = channel(); const close = vi.fn(async () => ch.close());
    const session: RealtimeChatSession = { events: ch.events, sendText: vi.fn(), sendAudio: vi.fn(), sendMedia: vi.fn(), close };
    let result!: UseZhivexRealtimeResult;
    const root = createRoot(document.createElement("div"));
    function App() { result = useZhivexRealtime({ createAudio: () => driver, transport: { connect: () => new Promise(done => { resolve = done; }) } }); return null; }
    await act(async () => root.render(createElement(App)));
    let connecting!: Promise<void>;
    await act(async () => { connecting = result.connect(); await Promise.resolve(); });
    await act(async () => result.disconnect());
    await act(async () => { resolve(session); await connecting; });
    expect(close).toHaveBeenCalledTimes(1); expect(driver.close).toHaveBeenCalledTimes(1); expect(result.status).toBe("disconnected");
    await act(async () => root.unmount());
  });
  it("replaces final transcripts, bounds history, interrupts output and closes media on unmount", async () => {
    const ch = channel(), driver = audio(), interrupt = vi.fn(async () => {});
    let result!: UseZhivexRealtimeResult;
    const close = vi.fn(async () => ch.close());
    const root = createRoot(document.createElement("div"));
    function App() { result = useZhivexRealtime({ maxTranscripts: 2, maxTranscriptChars: 8, createAudio: () => driver, transport: { connect: async () => ({ events: ch.events, sendText: vi.fn(), sendAudio: vi.fn(), sendMedia: vi.fn(), close, interrupt }) } }); return null; }
    await act(async () => root.render(createElement(App)));
    await act(async () => result.connect());
    await act(async () => result.interrupt());
    expect(driver.interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).not.toHaveBeenCalled();
    await act(async () => {
      ch.push({ type: "realtime-text-delta", itemId: "2", textDelta: "same" });
      ch.push({ type: "realtime-transcript", itemId: "2", role: "assistant", text: "same", isFinal: false });
      ch.push({ type: "realtime-text-delta", itemId: "2", textDelta: "duplicate" });
      ch.push({ type: "realtime-transcript", itemId: "1", role: "user", text: "partial", isFinal: false });
      ch.push({ type: "realtime-transcript", itemId: "1", role: "user", text: "final", isFinal: true });
    });
    expect(result.transcripts).toEqual([{ id: "assistant:2", role: "assistant", text: "same", final: false }, { id: "user:1", role: "user", text: "final", final: true }]);
    await act(async () => result.interrupt());
    await act(async () => ch.push({ type: "realtime-audio-output", audio: new Uint8Array([0, 0]), mediaType: "audio/pcm" }));
    expect(driver.play).not.toHaveBeenCalled(); expect(interrupt).toHaveBeenCalledTimes(1);
    await act(async () => {
      ch.push({ type: "realtime-response-complete" });
      ch.push({ type: "realtime-transcript", role: "assistant", itemId: "2", text: "1234567890", isFinal: true });
      ch.push({ type: "realtime-transcript", role: "assistant", itemId: "3", text: "third", isFinal: true });
    });
    expect(result.transcripts).toHaveLength(2); expect(result.transcripts[0]!.text).toBe("34567890");
    await act(async () => root.unmount()); expect(close).toHaveBeenCalled(); expect(driver.close).toHaveBeenCalled();
  });
  it("rejects browser tool execution and mismatched audio on the server relay", async () => {
    const ch = channel(); const sent: string[] = [];
    const sendAudio = vi.fn(async () => {}), sendToolResult = vi.fn();
    const session = { config: {}, eventStream: () => ch.events, sendAudio, sendToolResult, sendMedia: vi.fn(), sendText: vi.fn(), close: async () => ch.close() } as unknown as RealtimeSession;
    const relay = createRealtimeRelay({ session, send: data => { sent.push(data); }, close() {} });
    await relay.receive(JSON.stringify({ type: "tool-result", id: 1, payload: {} }));
    await relay.receive(JSON.stringify({ type: "audio", id: 2, payload: { data: "AAA=", mediaType: "audio/pcm", sampleRateHz: 44100, channels: 1 } }));
    await relay.receive(JSON.stringify({ type: "audio", id: 3, payload: { data: "AAA=", mediaType: "audio/pcm", sampleRateHz: 16000, channels: 1 } }));
    expect(sendToolResult).not.toHaveBeenCalled(); expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(sent.map(value => JSON.parse(value)).filter(value => value.error)).toHaveLength(2);
    await relay.close(); await relay.done;
  });
});
it("does not re-enable the microphone when an older permission request finishes after stop and restart", async () => {
  const ch = channel(), driver = audio();
  const pending: Array<() => void> = [];
  driver.startMicrophone.mockImplementation(() => new Promise<void>(resolve => pending.push(resolve)));
  let result!: UseZhivexRealtimeResult;
  const root = createRoot(document.createElement("div"));
  function App() { result = useZhivexRealtime({ createAudio: () => driver, transport: { connect: async () => ({ events: ch.events, sendText: vi.fn(), sendAudio: vi.fn(), sendMedia: vi.fn(), close: async () => ch.close() }) } }); return null; }
  await act(async () => root.render(createElement(App)));
  await act(async () => result.connect());
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => { first = result.startMicrophone(); });
  await act(async () => result.stopMicrophone());
  await act(async () => { second = result.startMicrophone(); });
  await act(async () => { pending[0]!(); await first; });
  expect(result.microphoneActive).toBe(false);
  await act(async () => { pending[1]!(); await second; });
  expect(result.microphoneActive).toBe(true);
  await act(async () => root.unmount());
});
