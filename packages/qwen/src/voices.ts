import { ConfigurationError, ProviderHTTPError, readJsonWithLimit, withTimeoutSignal } from "@zhivex-ai/core";

export interface QwenVoiceRequestOptions { abortSignal?: AbortSignal; timeoutMs?: number }
export interface QwenVoice {
  voice: string;
  targetModel?: string;
  fallbackMode?: boolean;
  fallbackReason?: string;
}
export interface QwenVoiceCreateInput extends QwenVoiceRequestOptions {
  /** Explicit target: enrollment availability must be confirmed for this model and region. */
  targetModel: string;
  preferredName: string;
  /** Public HTTPS URL or base64 audio data URI, sent to Qwen without fetching locally. */
  audio: string;
  text?: string;
  language?: string;
}
export interface QwenVoicesClient {
  create(input: QwenVoiceCreateInput): Promise<QwenVoice>;
  list(input?: QwenVoiceRequestOptions & { pageIndex?: number; pageSize?: number }): Promise<{ voices: QwenVoice[]; totalCount?: number }>;
  delete(input: QwenVoiceRequestOptions & { voice: string }): Promise<void>;
}
const nonempty = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new ConfigurationError(`${name} must be a nonempty string of at most 512 characters.`);
  return value;
};
const normalizeVoice = (output: any): QwenVoice => {
  if (!output || typeof output.voice !== "string" || !output.voice) throw new ConfigurationError("Qwen enrollment returned no voice identifier.");
  return {
    voice: output.voice,
    ...(typeof output.target_model === "string" ? { targetModel: output.target_model } : {}),
    ...(typeof output.fallback_mode === "boolean" ? { fallbackMode: output.fallback_mode } : {}),
    ...(typeof output.fallback_reason === "string" ? { fallbackReason: output.fallback_reason } : {})
  };
};

export function createQwenVoicesClient(apiKey: string, taskBaseURL: string, fetcher: typeof globalThis.fetch): QwenVoicesClient {
  const request = async (input: Record<string, unknown>, options: QwenVoiceRequestOptions) => {
    const { signal, cleanup } = withTimeoutSignal({ ...options, timeoutMs: options.timeoutMs ?? 30000 });
    try {
      // Creation has no idempotency key: never automatically retry a possibly successful mutation.
      const response = await fetcher(`${taskBaseURL}/services/audio/tts/customization`, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "qwen-voice-enrollment", input })
      });
      const json = await readJsonWithLimit<any>(response, { maxBytes: 1024 * 1024, provider: "qwen", endpoint: "voice-enrollment" });
      if (!response.ok || json.code) {
        // Do not retain a response body that might echo the source audio or its signed URL.
        throw new ProviderHTTPError("Qwen voice enrollment request failed.", response.status, {
          ...(typeof json.code === "string" ? { responseBody: { code: json.code } } : {})
        });
      }
      if (input.action === "delete") {
        if (json.output?.voice !== input.voice) throw new ConfigurationError("Qwen did not confirm deletion of the requested voice.");
        return {};
      }
      if (!json.output || typeof json.output !== "object") throw new ConfigurationError("Invalid Qwen voice enrollment response.");
      return json.output;
    } finally { cleanup(); }
  };
  return {
    async create(input) {
      nonempty(input.targetModel, "targetModel");
      if (typeof input.preferredName !== "string" || !/^[A-Za-z0-9_]{1,16}$/.test(input.preferredName)) throw new ConfigurationError("preferredName must have 1-16 alphanumeric/underscore characters.");
      if (typeof input.audio !== "string" || !input.audio) throw new ConfigurationError("audio is required.");
      if (input.audio.startsWith("data:")) {
        const match = /^data:audio\/(?:wav|mpeg|mp3|mp4|x-wav);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.audio);
        if (!match || match[1]!.length % 4 !== 0 || match[1]!.length > Math.ceil(10 * 1024 * 1024 / 3) * 4) throw new ConfigurationError("audio must be a valid audio data URI of at most 10 MiB.");
      } else {
        let url: URL;
        try { url = new URL(input.audio); } catch { throw new ConfigurationError("audio must be an HTTPS URL or audio data URI."); }
        if (url.protocol !== "https:" || url.username || url.password) throw new ConfigurationError("Audio URLs require HTTPS without embedded credentials.");
      }
      return normalizeVoice(await request({ action: "create", target_model: input.targetModel, preferred_name: input.preferredName,
        audio: { data: input.audio }, ...(input.text === undefined ? {} : { text: input.text }), ...(input.language === undefined ? {} : { language: input.language }) }, input));
    },
    async list(input = {}) {
      for (const [name, value, min] of [["pageIndex", input.pageIndex, 0], ["pageSize", input.pageSize, 1]] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < min)) throw new ConfigurationError(`${name} is invalid.`);
      }
      const output = await request({ action: "list", page_index: input.pageIndex ?? 0, page_size: input.pageSize ?? 10 }, input);
      if (!Array.isArray(output.voice_list)) throw new ConfigurationError("Invalid Qwen voice list.");
      return { voices: output.voice_list.map(normalizeVoice), ...(typeof output.total_count === "number" ? { totalCount: output.total_count } : {}) };
    },
    async delete(input) { await request({ action: "delete", voice: nonempty(input.voice, "voice") }, input); }
  };
}
