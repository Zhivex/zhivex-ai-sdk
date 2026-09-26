import { trimTrailingSlashes } from "./url-path.js";
import { Buffer } from "node:buffer";
import { ConfigurationError, ValidationError, ProviderHTTPError, assertTrustedEndpoint, readJsonWithLimit, withTimeoutSignal, type TranscriptionModel } from "@zhivex-ai/core/provider";
import { transcriptionCapabilities } from "./capabilities.js";
export interface QwenNativeASROptions { apiKey: string; taskBaseURL: string; fetch?: typeof globalThis.fetch; allowUnsafeEndpoints?: boolean }
export interface QwenASRRequestOptions { abortSignal?: AbortSignal; timeoutMs?: number }
export interface QwenFileTranscriptionInput extends QwenASRRequestOptions {
  fileURL: string;
  languageHints?: string[];
  channelIds?: number[];
  diarization?: boolean;
  speakerCount?: number;
  keepDialect?: boolean;
  vocabularyId?: string;
  vocabulary?: Record<string, number>;
  context?: Array<{ role: "user" | "assistant"; content: Array<{ type: "input_text" | "text"; text: string }> }>;
}
export interface QwenFileTranscriptionTask {
  taskId: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";
  requestId?: string;
  code?: string;
  durationSeconds?: number;
  results?: Array<{ fileURL: string; status: "SUCCEEDED" | "FAILED"; transcriptionURL?: string; code?: string }>;
}
export interface QwenFileTranscriptionModel {
  readonly provider: "qwen";
  readonly modelId: string;
  submit(input: QwenFileTranscriptionInput): Promise<QwenFileTranscriptionTask>;
  get(input: QwenASRRequestOptions & { taskId: string }): Promise<QwenFileTranscriptionTask>;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const invalid = (message: string): never => { throw new ValidationError(`Qwen ASR: ${message}`); };
function client(options: QwenNativeASROptions) {
  if (!nonempty(options.apiKey)) throw new ConfigurationError("Qwen ASR requires an API key.");
  const base = trimTrailingSlashes(options.taskBaseURL);
  assertTrustedEndpoint(base, { protocols: ["https:"], allowUnsafe: options.allowUnsafeEndpoints, label: "Qwen ASR endpoint" });
  return async (path: string, body: unknown, input: QwenASRRequestOptions, asyncTask = false) => {
    let serialized: string | undefined;
    try { serialized = body === undefined ? undefined : JSON.stringify(body); } catch { return invalid("request must be JSON serializable."); }
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > 29 * 1024 * 1024) return invalid("request exceeds 29 MiB.");
    const { signal, cleanup } = withTimeoutSignal({ abortSignal: input.abortSignal, timeoutMs: input.timeoutMs ?? 30000 });
    try {
      const response = await (options.fetch ?? globalThis.fetch)(`${base}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", ...(asyncTask ? { "X-DashScope-Async": "enable" } : { "X-DashScope-SSE": "disable" }) }, ...(body === undefined ? {} : { body: serialized }) });
      if (!response.ok) { await response.body?.cancel(); throw new ProviderHTTPError(`Qwen ASR request failed (${response.status}).`, response.status); }
      const json = await readJsonWithLimit<unknown>(response, { maxBytes: 2 * 1024 * 1024, provider: "qwen", endpoint: "asr" });
      if (!object(json)) return invalid("invalid response.");
      if (json.code) throw new ProviderHTTPError("Qwen ASR provider rejected the request.", response.status);
      return json;
    } finally { cleanup(); }
  };
}
function publicURL(value: string) {
  return assertTrustedEndpoint(value, { protocols: ["https:", "http:"], label: "Qwen ASR file URL" });
}
function task(json: Record<string, any>, expectedId?: string): QwenFileTranscriptionTask {
  const out = json.output;
  const statuses = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"];
  if (!object(out) || !nonempty(out.task_id) || !statuses.includes(out.task_status) || (expectedId !== undefined && out.task_id !== expectedId)) return invalid("invalid task identity or status.");
  let results: QwenFileTranscriptionTask["results"];
  if (out.results !== undefined) {
    if (!Array.isArray(out.results)) return invalid("invalid task results.");
    results = out.results.map((r: unknown) => {
      if (!object(r) || !nonempty(r.file_url) || !["SUCCEEDED", "FAILED"].includes(r.subtask_status)) return invalid("invalid subtask result.");
      if (r.subtask_status === "SUCCEEDED") {
        if (!nonempty(r.transcription_url)) return invalid("missing transcript URL.");
        publicURL(r.transcription_url);
      }
      return { fileURL: r.file_url, status: r.subtask_status, ...(nonempty(r.transcription_url) ? { transcriptionURL: r.transcription_url } : {}), ...(nonempty(r.code) ? { code: r.code } : {}) };
    });
  }
  if (out.task_status === "SUCCEEDED" && (!results || !results.length)) return invalid("successful task has no results.");
  if (json.usage?.duration !== undefined && (typeof json.usage.duration !== "number" || !Number.isFinite(json.usage.duration) || json.usage.duration < 0)) return invalid("invalid duration.");
  return { taskId: out.task_id, status: out.task_status, ...(nonempty(json.request_id) ? { requestId: json.request_id } : {}), ...(nonempty(out.code) ? { code: out.code } : {}), ...(results ? { results } : {}), ...(json.usage?.duration === undefined ? {} : { durationSeconds: json.usage.duration }) };
}
export function createQwenFileTranscriptionModel(modelId: string, options: QwenNativeASROptions): QwenFileTranscriptionModel {
  if (!["qwen-audio-3.0-asr-flash-filetrans", "qwen-audio-3.1-asr-flash-filetrans"].includes(modelId)) throw new ConfigurationError("Unsupported Qwen file transcription model.");
  const request = client(options);
  return { provider: "qwen", modelId,
    async submit(input) {
      publicURL(input.fileURL);
      if (input.keepDialect !== undefined && (modelId !== "qwen-audio-3.1-asr-flash-filetrans" || typeof input.keepDialect !== "boolean")) return invalid("keepDialect requires the 3.1 filetrans model.");
      if (input.channelIds && (!input.channelIds.length || !input.channelIds.every(n => Number.isSafeInteger(n) && n >= 0))) return invalid("invalid channel IDs.");
      if (input.languageHints && (!input.languageHints.length || input.languageHints.length > 4 || !input.languageHints.every(nonempty))) return invalid("languageHints supports one to four language codes.");
      if (input.diarization !== undefined && typeof input.diarization !== "boolean") return invalid("diarization must be boolean.");
      if (input.diarization && input.channelIds && input.channelIds.length > 1) return invalid("diarization requires mono audio.");
      if (input.speakerCount !== undefined && (!input.diarization || !Number.isSafeInteger(input.speakerCount) || input.speakerCount < 2 || input.speakerCount > 100)) return invalid("speakerCount requires diarization and must be 2 to 100.");
      if (input.vocabularyId !== undefined && !nonempty(input.vocabularyId)) return invalid("invalid vocabulary ID.");
      if (input.vocabulary) {
        if (!object(input.vocabulary) || Object.keys(input.vocabulary).length > 2000 || !Object.entries(input.vocabulary).every(([k, v]) => nonempty(k) && Number.isInteger(v) && (v >= 1 && v <= 5 || v === 50)) || Object.values(input.vocabulary).filter(v => v === 50).length > 50) return invalid("invalid vocabulary weights.");
      }
      if (input.context && (!Array.isArray(input.context) || !input.context.every(m => object(m) && ["user", "assistant"].includes(m.role) && Array.isArray(m.content) && m.content.every(c => object(c) && c.type === (m.role === "user" ? "input_text" : "text") && nonempty(c.text))))) return invalid("invalid context messages.");
      return task(await request("/services/audio/asr/transcription", { model: modelId, input: { file_urls: [input.fileURL], ...(input.context ? { context: input.context } : {}) }, parameters: {
        ...(input.channelIds ? { channel_id: input.channelIds } : {}), ...(input.languageHints ? { language_hints: input.languageHints } : {}), ...(input.diarization === undefined ? {} : { diarization_enabled: input.diarization }), ...(input.speakerCount === undefined ? {} : { speaker_count: input.speakerCount }), ...(input.keepDialect === undefined ? {} : { keep_dialect: input.keepDialect }), ...(input.vocabularyId ? { vocabulary_id: input.vocabularyId } : {}), ...(input.vocabulary ? { vocabulary: input.vocabulary } : {})
      } }, input, true));
    },
    async get(input) {
      if (!nonempty(input.taskId) || !/^[a-zA-Z0-9_-]+$/.test(input.taskId)) return invalid("invalid task ID.");
      return task(await request(`/tasks/${encodeURIComponent(input.taskId)}`, undefined, input), input.taskId);
    }
  };
}
export function createQwenNativeTranscriptionModel(modelId: string, options: QwenNativeASROptions): TranscriptionModel {
  if (modelId !== "qwen-audio-3.0-asr-flash") throw new ConfigurationError("Unsupported Qwen synchronous native ASR model.");
  const request = client(options);
  return { provider: "qwen", modelId, capabilities: transcriptionCapabilities,
    async transcribe(input) {
      const params = { ...(input.providerOptions ?? {}) };
      if (!Object.keys(params).every(k => ["format", "sample_rate", "language", "vocabulary", "context"].includes(k))) return invalid("unsupported synchronous ASR option.");
      if (input.maxRetries && input.maxRetries > 0) return invalid("native ASR does not automatically retry billable requests.");
      if (params.sample_rate !== undefined && !/^(8000|16000|22050|24000|32000|44100|48000)$/.test(String(params.sample_rate))) return invalid("unsupported sample rate.");
      if (params.context !== undefined && !Array.isArray(params.context)) return invalid("context must be an array.");
      if (!/^audio\/[\w.+-]+$/.test(input.audio.mediaType)) return invalid("audio mediaType is required.");
      const format = params.format ?? input.audio.mediaType.split("/")[1]?.replace("x-wav", "wav");
      if (!nonempty(format)) return invalid("audio format is required.");
      let data: string;
      if (typeof input.audio.data === "string") {
        data = input.audio.data;
        if (/^https?:/.test(data)) publicURL(data);
        else {
          const payload = data.startsWith("data:") ? /^data:audio\/[\w.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data)?.[1] : data;
          if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return invalid("audio must be a public URL or valid base64.");
          if (!data.startsWith("data:")) data = `data:${input.audio.mediaType};base64,${data}`;
        }
      } else {
        const bytes = input.audio.data instanceof Uint8Array ? input.audio.data : new Uint8Array(input.audio.data);
        if (bytes.byteLength > 20 * 1024 * 1024) return invalid("audio exceeds 20 MiB.");
        data = `data:${input.audio.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
      }
      if (data.length > 28 * 1024 * 1024) return invalid("audio exceeds request limit.");
      const { context, ...parameters } = params;
      const messages = [...(Array.isArray(context) ? context : []), ...(input.prompt ? [{ role: "user", content: [{ type: "input_text", text: input.prompt }] }] : []), { role: "user", content: [{ type: "input_audio", input_audio: { data } }] }];
      const json = await request("/services/aigc/multimodal-generation/generation", { model: modelId, input: { messages }, parameters: { ...parameters, format, ...(input.language ? { language: input.language } : {}) } }, input);
      const content = json.output?.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p: any) => p && typeof p.text === "string").map((p: any) => p.text).join("") : typeof json.output?.text === "string" ? json.output.text : undefined;
      if (text === undefined) return invalid("missing transcription text.");
      return { text, rawResponse: json };
    }
  };
}
