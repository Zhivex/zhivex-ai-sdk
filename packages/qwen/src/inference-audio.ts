import {
  ConfigurationError, ProviderHTTPError, UnsupportedFeatureError, openWebSocketConnection,
  withTimeoutSignal, decodeBase64WithLimit,
  type RealtimeConnection, type RealtimeConnectionFactory, type SpeechModel,
  type SpeechModelInput, type SpeechResult, type TranscriptionModel, type TranscriptionModelInput,
  type TranscriptionResult
} from "@zhivex-ai/core";
import { speechCapabilities, transcriptionCapabilities } from "./capabilities.js";

export interface QwenCloudSpeechOptions extends Record<string, unknown> {
  format?: "pcm" | "wav" | "mp3" | "opus";
  sample_rate?: 8000 | 16000 | 22050 | 24000 | 44100 | 48000;
  volume?: number;
  rate?: number;
  pitch?: number;
  instruction?: string;
  enable_ssml?: boolean;
  seed?: number;
}
export interface QwenCloudASROptions extends Record<string, unknown> {
  format?: "pcm" | "wav" | "mp3" | "opus" | "speex" | "aac" | "amr";
  sample_rate?: number;
  vocabulary?: Record<string, number>;
  vocabulary_id?: string;
  language_hints?: string[];
  semantic_punctuation_enabled?: boolean;
  disfluency_removal_enabled?: boolean;
  context?: Array<{ role: "user" | "assistant"; content: Array<{ type: "input_text" | "text"; text: string }> }>;
}
export interface QwenASRTranscript {
  text: string;
  isFinal: boolean;
  beginTimeMs?: number;
  endTimeMs?: number;
  rawResponse: unknown;
}
export const isQwenCloudSpeech = (id: string) => /^qwen-audio-3\.[01]-tts-(flash|plus)(?:-|$)/i.test(id);
export const isQwenCloudStreamingASR = (id: string) => /^qwen-audio-3\.[01]-asr-flash-streaming(?:-|$)/i.test(id);

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const envelope = (action: string, taskId: string, payload: Record<string, unknown>) => ({
  header: { action, task_id: taskId, streaming: "duplex" }, payload
});
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    throw new ProviderHTTPError("Qwen inference returned an invalid event.", 502);
  }
  return value as Record<string, any>;
};
const event = (value: unknown, taskId: string) => {
  const message = record(value);
  if (message.header?.task_id !== taskId) throw new ProviderHTTPError("Qwen inference task ID mismatch.", 502);
  if (message.header.event === "task-failed") {
    throw new ProviderHTTPError(String(message.header.error_message ?? "Qwen inference task failed."), 502, {
      responseBody: JSON.stringify({ code: message.header.error_code, task_id: taskId })
    });
  }
  return message;
};
const checkRange = (value: unknown, name: string, min: number, max: number) => {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) {
    throw new ConfigurationError(`${name} must be between ${min} and ${max}.`);
  }
};
const connect = async (factory: RealtimeConnectionFactory, url: string, key: string, signal: AbortSignal, timeoutMs: number) => {
  const connection = await factory(url, { authorization: `Bearer ${key}` }, { signal, timeoutMs, maxIncomingFrameBytes: MAX_AUDIO_BYTES });
  if (!connection.recvFrame || !connection.sendBinary) {
    await connection.close();
    throw new UnsupportedFeatureError("Qwen inference audio requires a binary-capable RealtimeConnection (recvFrame/sendBinary).");
  }
  return connection;
};
const waitWithSignal = async <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) { void pending.catch(() => {}); throw signal.reason; }
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    ]);
  } finally { signal.removeEventListener("abort", onAbort); }
};

const receive = (connection: RealtimeConnection, signal: AbortSignal) => waitWithSignal(connection.recvFrame!(), signal);

/** DashScope duplex inference transport. Generates MP3 by default; no paid-task retries. */
export class QwenCloudSpeechModel implements SpeechModel<QwenCloudSpeechOptions> {
  readonly provider = "qwen";
  readonly capabilities = { ...speechCapabilities, embeddings: false };
  constructor(readonly modelId: string, private readonly apiKey: string, private readonly inferenceURL: string,
    private readonly factory: RealtimeConnectionFactory = openWebSocketConnection) {}

  async streamSpeech(input: SpeechModelInput<QwenCloudSpeechOptions>): Promise<AsyncIterable<SpeechResult>> {
    if (!input.input.trim()) throw new ConfigurationError("Qwen speech requires nonempty text.");
    const parameters = { ...(input.providerOptions ?? {}) };
    const format = parameters.format ?? "mp3";
    if (!["pcm", "wav", "mp3", "opus"].includes(format)) throw new ConfigurationError("Unsupported speech format.");
    if (parameters.sample_rate !== undefined && ![8000, 16000, 22050, 24000, 44100, 48000].includes(parameters.sample_rate)) throw new ConfigurationError("Unsupported speech sample rate.");
    checkRange(parameters.volume, "volume", 0, 100);
    checkRange(parameters.rate, "rate", 0.5, 2);
    checkRange(parameters.pitch, "pitch", 0.5, 2);
    const mediaType = ({ pcm: "audio/pcm", wav: "audio/wav", mp3: "audio/mpeg", opus: "audio/opus" })[format];
    const self = this;
    return (async function* () {
      const { signal, cleanup, abort } = withTimeoutSignal({ ...input, timeoutMs: input.timeoutMs ?? 60_000 });
      let connection: RealtimeConnection | undefined;
      try {
        connection = await connect(self.factory, self.inferenceURL, self.apiKey, signal, input.timeoutMs ?? 60_000);
        const taskId = crypto.randomUUID();
        await connection.sendJson(envelope("run-task", taskId, {
          task_group: "audio", task: "tts", function: "SpeechSynthesizer", model: self.modelId,
          parameters: { text_type: "PlainText", ...parameters, voice: input.voice ?? "longanhuan_v3.6", format }, input: {}
        }));
        const started = event(await receive(connection, signal), taskId);
        if (started.header.event !== "task-started") throw new ProviderHTTPError("Expected Qwen task-started event.", 502);
        await connection.sendJson(envelope("continue-task", taskId, { input: { text: input.input } }));
        await connection.sendJson(envelope("finish-task", taskId, { input: {} }));
        let totalBytes = 0;
        while (true) {
          const frame = await receive(connection, signal);
          if (frame === undefined) throw new ProviderHTTPError("Qwen speech closed before task-finished.", 502);
          if (frame instanceof Uint8Array) {
            totalBytes += frame.byteLength;
            if (totalBytes > MAX_AUDIO_BYTES) throw new ProviderHTTPError("Qwen speech exceeds the 32 MiB output limit.", 502);
            if (frame.byteLength) yield { audio: frame, mediaType, rawResponse: { task_id: taskId } };
          } else if (event(frame, taskId).header.event === "task-finished") {
            if (!totalBytes) throw new ProviderHTTPError("Qwen speech returned no audio.", 502);
            return;
          }
        }
      } finally { abort(); cleanup(); await connection?.close(); }
    })();
  }
  async generateSpeech(input: SpeechModelInput<QwenCloudSpeechOptions>): Promise<SpeechResult> {
    const chunks: Uint8Array[] = [];
    let mediaType = "audio/mpeg";
    let rawResponse: unknown;
    for await (const chunk of await this.streamSpeech(input)) { chunks.push(chunk.audio); mediaType = chunk.mediaType; rawResponse = chunk.rawResponse; }
    const audio = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
    return { audio, mediaType, rawResponse };
  }
}

/** Streaming ASR over binary inference frames; supports recorded audio and incremental input. */
export class QwenCloudStreamingASRModel implements TranscriptionModel<QwenCloudASROptions> {
  readonly provider = "qwen";
  readonly capabilities = { ...transcriptionCapabilities, embeddings: false };
  constructor(readonly modelId: string, private readonly apiKey: string, private readonly inferenceURL: string,
    private readonly factory: RealtimeConnectionFactory = openWebSocketConnection) {}

  async streamTranscription(input: Omit<TranscriptionModelInput<QwenCloudASROptions>, "audio"> & {
    audio: AsyncIterable<Uint8Array>; format?: QwenCloudASROptions["format"];
  }): Promise<AsyncIterable<QwenASRTranscript>> {
    const { context, ...parameters } = input.providerOptions ?? {};
    const format = input.format ?? parameters.format ?? "pcm";
    if (!["pcm", "wav", "mp3", "opus", "speex", "aac", "amr"].includes(format)) throw new ConfigurationError("Unsupported ASR format.");
    const sampleRate = parameters.sample_rate ?? 16000;
    checkRange(sampleRate, "sample_rate", 8000, 48000);
    if (!Number.isInteger(sampleRate)) throw new ConfigurationError("sample_rate must be an integer.");
    if (input.prompt && context) throw new ConfigurationError("Use prompt or context, not both.");
    const self = this;
    return (async function* () {
      const { signal, cleanup, abort } = withTimeoutSignal({ ...input, timeoutMs: input.timeoutMs ?? 60_000 });
      let connection: RealtimeConnection | undefined;
      let sending: Promise<void> | undefined;
      try {
        connection = await connect(self.factory, self.inferenceURL, self.apiKey, signal, input.timeoutMs ?? 60_000);
        const taskId = crypto.randomUUID();
        await connection.sendJson(envelope("run-task", taskId, {
          task_group: "audio", task: "asr", function: "recognition", model: self.modelId,
          parameters: { ...parameters, format, sample_rate: sampleRate, ...(input.language ? { language_hints: [input.language] } : {}) },
          input: { ...(context ? { context } : input.prompt ? { context: [{ role: "user", content: [{ type: "input_text", text: input.prompt }] }] } : {}) }
        }));
        if (event(await receive(connection, signal), taskId).header.event !== "task-started") throw new ProviderHTTPError("Expected Qwen task-started event.", 502);
        const socket = connection;
        sending = (async () => {
          let total = 0;
          const iterator = input.audio[Symbol.asyncIterator]();
          try {
            while (true) {
              const next = await waitWithSignal(iterator.next(), signal);
              if (next.done) break;
              const chunk = next.value;
              total += chunk.byteLength;
              if (total > MAX_AUDIO_BYTES) throw new ConfigurationError("Streaming ASR input exceeds the 32 MiB session limit.");
              for (let offset = 0; offset < chunk.length; offset += 3200) await waitWithSignal(socket.sendBinary!(chunk.subarray(offset, offset + 3200)), signal);
            }
            await socket.sendJson(envelope("finish-task", taskId, { input: {} }));
          } finally {
            // A caller's source may be stalled; request cancellation without blocking socket teardown.
            void iterator.return?.().catch(() => {});
          }
        })();
        // Attach rejection immediately while the receiver consumes incremental results.
        const sendFailure = sending.then(() => new Promise<never>(() => {}));
        void sendFailure.catch(() => {});
        while (true) {
          const frame = await Promise.race([receive(connection, signal), sendFailure]);
          if (frame === undefined) throw new ProviderHTTPError("Qwen ASR closed before task-finished.", 502);
          const message = event(frame, taskId);
          if (message.header.event === "task-finished") { await waitWithSignal(sending, signal); return; }
          if (message.header.event === "result-generated") {
            const sentence = message.payload?.output?.sentence;
            if (!sentence || typeof sentence.text !== "string") throw new ProviderHTTPError("Invalid ASR transcript event.", 502);
            yield { text: sentence.text, isFinal: sentence.sentence_end === true, beginTimeMs: sentence.begin_time,
              endTimeMs: sentence.end_time, rawResponse: message };
          }
        }
      } finally { abort(); cleanup(); await connection?.close(); void sending?.catch(() => {}); }
    })();
  }
  async transcribe(input: TranscriptionModelInput<QwenCloudASROptions>): Promise<TranscriptionResult> {
    const data = input.audio.data;
    const bytes = typeof data === "string"
      ? decodeBase64WithLimit(data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data, { maxBytes: MAX_AUDIO_BYTES, provider: "qwen", endpoint: "inference" })
      : data instanceof Uint8Array ? data : new Uint8Array(data);
    const format = input.providerOptions?.format ?? ({ "audio/pcm": "pcm", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/opus": "opus", "audio/aac": "aac" } as const)[input.audio.mediaType as "audio/pcm"];
    if (!format) throw new ConfigurationError("Specify a supported ASR audio format.");
    const sentences: QwenASRTranscript[] = [];
    const source = (async function* () { yield bytes; })();
    for await (const sentence of await this.streamTranscription({ ...input, audio: source, format })) if (sentence.isFinal) sentences.push(sentence);
    return { text: sentences.map(sentence => sentence.text).join(""), rawResponse: { sentences } };
  }
}
