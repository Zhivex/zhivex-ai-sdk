import type { AudioFrame, RealtimeAudioOutputEvent } from "@zhivex-ai/core";

export interface RealtimeAudioDriver {
  /** Call from a user gesture to unlock browser audio. */
  start(): Promise<void>;
  startMicrophone(send: (frame: AudioFrame) => Promise<void>, onError: (error: Error) => void): Promise<void>;
  stopMicrophone(): void;
  play(event: RealtimeAudioOutputEvent): void;
  interrupt(): void;
  close(): Promise<void>;
}

export const REALTIME_CAPTURE_WORKLET_SOURCE = `class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Float32Array(2048); this.offset = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) for (const sample of channel) {
      this.samples[this.offset++] = sample;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples); this.samples = new Float32Array(2048); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('zhivex-capture', Capture);`;

export function encodePCM16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

/** PCM16 capture/playback with bounded buffering. Compressed audio needs an application driver. */
export function createBrowserRealtimeAudio(options: {
  inputSampleRateHz?: number;
  outputSampleRateHz?: number;
  maxBufferedSeconds?: number;
  /** Host the processor yourself when CSP disallows blob modules. */
  workletUrl?: string;
} = {}): RealtimeAudioDriver {
  const inputRate = options.inputSampleRateHz ?? 16000;
  const outputRate = options.outputSampleRateHz ?? 24000;
  const maxSeconds = options.maxBufferedSeconds ?? 10;
  for (const value of [inputRate, outputRate, maxSeconds]) if (!Number.isFinite(value) || value <= 0) throw new RangeError("Invalid audio limits.");
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let captureGeneration = 0;
  let playbackTime = 0;
  let closed = false;
  let workletLoaded: Promise<void> | undefined;
  const playing = new Set<AudioBufferSourceNode>();
  const stopMicrophone = () => {
    captureGeneration++;
    if (processor) { processor.port.onmessage = null; processor.port.close(); processor.disconnect(); }
    source?.disconnect(); stream?.getTracks().forEach(track => track.stop());
    processor = undefined; source = undefined; stream = undefined;
  };
  const interrupt = () => {
    for (const node of playing) { node.onended = null; node.stop(); node.disconnect(); }
    playing.clear(); playbackTime = 0;
  };
  return {
    async start() {
      if (closed) throw new Error("Audio driver is closed.");
      context ??= new AudioContext({ sampleRate: inputRate });
      await context.resume();
    },
    async startMicrophone(send, onError) {
      if (!context || closed) throw new Error("Start audio from a user gesture first.");
      stopMicrophone();
      const generation = captureGeneration;
      const current = () => !closed && generation === captureGeneration;
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (!current()) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      let url: string | undefined;
      try {
        if (context.sampleRate !== inputRate) throw new Error("Browser did not provide the requested PCM sample rate.");
        if (!workletLoaded) {
          url = options.workletUrl ?? URL.createObjectURL(new Blob([REALTIME_CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }));
          workletLoaded = context.audioWorklet.addModule(url).catch(error => { workletLoaded = undefined; throw error; });
        }
        await workletLoaded;
        if (!current()) return;
        source = context.createMediaStreamSource(acquired);
        processor = new AudioWorkletNode(context, "zhivex-capture");
        let pending = 0;
        let chain = Promise.resolve();
        processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (!current()) return;
          if (++pending > 16) { stopMicrophone(); onError(new Error("Microphone transport is too slow.")); return; }
          const data = encodePCM16(event.data);
          chain = chain.then(async () => {
            if (current()) await send({ data, mediaType: "audio/pcm", sampleRateHz: inputRate, channels: 1 });
          }).catch(error => { if (current()) { stopMicrophone(); onError(error instanceof Error ? error : new Error(String(error))); } })
            .finally(() => { pending--; });
        };
        source.connect(processor); processor.connect(context.destination);
      } catch (error) { if (current()) stopMicrophone(); throw error; }
      finally { if (url && !options.workletUrl) URL.revokeObjectURL(url); }
    },
    stopMicrophone,
    play(event) {
      if (!context || closed) return;
      if (!/^audio\/(pcm|pcm16|raw|s16le)(;|$)/i.test(event.mediaType)) throw new Error(`Unsupported realtime audio format: ${event.mediaType}`);
      const channels = event.channels ?? 1;
      const rate = event.sampleRateHz ?? outputRate;
      if (!Number.isInteger(channels) || channels < 1 || channels > 8 || !Number.isFinite(rate) || rate < 8000 || rate > 192000 || event.audio.length % (2 * channels)) throw new Error("Invalid PCM audio frame.");
      const frames = event.audio.length / (2 * channels);
      if (!frames) return;
      const start = Math.max(context.currentTime, playbackTime);
      if (start + frames / rate - context.currentTime > maxSeconds) throw new Error("Realtime playback buffer limit exceeded.");
      const buffer = context.createBuffer(channels, frames, rate);
      const bytes = new DataView(event.audio.buffer, event.audio.byteOffset, event.audio.byteLength);
      for (let channel = 0; channel < channels; channel++) {
        const target = buffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) target[i] = bytes.getInt16((i * channels + channel) * 2, true) / 32768;
      }
      const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination);
      playing.add(node); node.onended = () => { playing.delete(node); node.disconnect(); };
      node.start(start); playbackTime = start + frames / rate;
    },
    interrupt,
    async close() { closed = true; stopMicrophone(); interrupt(); await context?.close(); context = undefined; }
  };
}
