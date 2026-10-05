import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRealtimeAudio } from "../src/realtime-audio.js";

class AudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn();
  start = vi.fn();
  onended: (() => void) | null = null;
  buffer: unknown;
}
class Context {
  static latest: Context;
  static rateOverride: number | undefined;
  sampleRate: number;
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  audioWorklet = { addModule: vi.fn(async (_url: string) => {}) };
  input = new AudioNode();
  outputs: AudioNode[] = [];
  buffers: Float32Array[][] = [];
  createMediaStreamSource = vi.fn((_stream: unknown) => this.input);
  constructor(options: { sampleRate: number }) { this.sampleRate = Context.rateOverride ?? options.sampleRate; Context.latest = this; }
  createBuffer(channels: number, frames: number, _rate: number) {
    const samples = Array.from({ length: channels }, () => new Float32Array(frames));
    this.buffers.push(samples);
    return { getChannelData: (channel: number) => samples[channel]! };
  }
  createBufferSource() { const source = new AudioNode(); this.outputs.push(source); return source; }
}
class Worklet extends AudioNode {
  static latest: Worklet;
  port = { onmessage: null as ((event: { data: Float32Array }) => void) | null, close: vi.fn() };
  constructor(_context: unknown, _name: string) { super(); Worklet.latest = this; }
  emit(samples: number[]) { this.port.onmessage?.({ data: new Float32Array(samples) }); }
}
const tracks = () => { const stop = vi.fn(); return { stop, stream: { getTracks: () => [{ stop }] } }; };
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

beforeEach(() => {
  Context.rateOverride = undefined;
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("browser realtime audio lifecycle", () => {
  it("captures PCM after permission and stops every capture resource on close", async () => {
    const media = tracks();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => media.stream) } });
    const driver = createBrowserRealtimeAudio({ workletUrl: "/capture.js" });
    await driver.start();
    const send = vi.fn(async () => {}), error = vi.fn();
    await driver.startMicrophone(send, error);
    const processor = Worklet.latest;
    processor.emit([-1, 0, 1]);
    await flush();
    expect(send).toHaveBeenCalledWith({ data: new Uint8Array([0, 128, 0, 0, 255, 127]), mediaType: "audio/pcm", sampleRateHz: 16000, channels: 1 });
    expect(Context.latest.audioWorklet.addModule).toHaveBeenCalledWith("/capture.js");
    expect(error).not.toHaveBeenCalled();
    await driver.close();
    expect(media.stop).toHaveBeenCalledTimes(1);
    expect(processor.port.close).toHaveBeenCalledTimes(1);
    expect(processor.port.onmessage).toBeNull();
    expect(Context.latest.input.disconnect).toHaveBeenCalledTimes(1);
    expect(Context.latest.close).toHaveBeenCalledTimes(1);
    await expect(driver.start()).rejects.toThrow("closed");
  });

  it("stops a permission result that arrives after cancellation", async () => {
    const media = tracks();
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise(done => { resolve = done; }) } });
    const driver = createBrowserRealtimeAudio({ workletUrl: "/capture.js" });
    await driver.start();
    const starting = driver.startMicrophone(vi.fn(), vi.fn());
    driver.stopMicrophone();
    resolve(media.stream);
    await starting;
    expect(media.stop).toHaveBeenCalledTimes(1);
    expect(Context.latest.createMediaStreamSource).not.toHaveBeenCalled();
    await driver.close();
  });

  it("cleans up permission grants when the requested PCM rate is unavailable", async () => {
    Context.rateOverride = 48000;
    const media = tracks();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => media.stream } });
    const driver = createBrowserRealtimeAudio();
    await expect(driver.startMicrophone(vi.fn(), vi.fn())).rejects.toThrow("Start audio");
    await driver.start();
    await expect(driver.startMicrophone(vi.fn(), vi.fn())).rejects.toThrow("requested PCM sample rate");
    expect(media.stop).toHaveBeenCalledTimes(1);
    await driver.close();
  });

  it("revokes temporary modules and permits a retry after worklet initialization fails", async () => {
    const media = tracks();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => media.stream } });
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:temporary");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const driver = createBrowserRealtimeAudio();
    await driver.start();
    Context.latest.audioWorklet.addModule.mockRejectedValueOnce(new Error("CSP blocked worklet"));
    await expect(driver.startMicrophone(vi.fn(), vi.fn())).rejects.toThrow("CSP blocked worklet");
    expect(media.stop).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith("blob:temporary");
    await driver.startMicrophone(vi.fn(), vi.fn());
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(Context.latest.audioWorklet.addModule).toHaveBeenCalledTimes(2);
    driver.stopMicrophone();
    await driver.startMicrophone(vi.fn(), vi.fn());
    expect(Context.latest.audioWorklet.addModule).toHaveBeenCalledTimes(2);
    await driver.close();
  });

  it("stops capture when transport rejects a frame", async () => {
    const media = tracks();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => media.stream } });
    const driver = createBrowserRealtimeAudio({ workletUrl: "/capture.js" });
    await driver.start();
    const onError = vi.fn();
    await driver.startMicrophone(async () => { throw new Error("offline"); }, onError);
    Worklet.latest.emit([0]);
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }));
    expect(media.stop).toHaveBeenCalledTimes(1);
    await driver.close();
  });

  it("bounds queued microphone frames and discards work after stop", async () => {
    const media = tracks();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => media.stream } });
    const driver = createBrowserRealtimeAudio({ workletUrl: "/capture.js" });
    await driver.start();
    const onError = vi.fn(), send = vi.fn(async () => {});
    await driver.startMicrophone(send, onError);
    for (let index = 0; index < 17; index++) Worklet.latest.emit([0]);
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Microphone transport is too slow." }));
    expect(media.stop).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    await driver.close();
  });

  it("decodes PCM channels, bounds scheduled playback, and interrupts output", async () => {
    const driver = createBrowserRealtimeAudio({ maxBufferedSeconds: 0.5 });
    await driver.start();
    const event = { type: "realtime-audio-output" as const, mediaType: "audio/pcm", sampleRateHz: 8000, channels: 2, audio: new Uint8Array([0, 128, 255, 127]) };
    driver.play(event);
    expect(Context.latest.buffers[0]![0]![0]).toBe(-1);
    expect(Context.latest.buffers[0]![1]![0]).toBe(32767 / 32768);
    expect(Context.latest.outputs[0]!.start).toHaveBeenCalledWith(0);
    const ended = Context.latest.outputs[0]!;
    ended.onended?.();
    expect(ended.disconnect).toHaveBeenCalledTimes(1);
    driver.play(event);
    driver.interrupt();
    expect(Context.latest.outputs[1]!.stop).toHaveBeenCalledTimes(1);
    expect(Context.latest.outputs[1]!.onended).toBeNull();
    expect(() => driver.play({ ...event, audio: new Uint8Array(8000 * 4) })).toThrow("playback buffer limit");
    expect(() => driver.play({ ...event, mediaType: "audio/mp3" })).toThrow("Unsupported realtime audio format");
    expect(() => driver.play({ ...event, audio: new Uint8Array([0]) })).toThrow("Invalid PCM audio frame");
    expect(() => driver.play({ ...event, channels: 9 })).toThrow("Invalid PCM audio frame");
    driver.play({ ...event, audio: new Uint8Array() });
    await driver.close();
    driver.play(event);
    expect(Context.latest.outputs).toHaveLength(2);
  });

  it("rejects invalid audio limits before acquiring browser resources", () => {
    for (const options of [{ inputSampleRateHz: 0 }, { outputSampleRateHz: NaN }, { maxBufferedSeconds: -1 }]) {
      expect(() => createBrowserRealtimeAudio(options)).toThrow("Invalid audio limits");
    }
  });
});
