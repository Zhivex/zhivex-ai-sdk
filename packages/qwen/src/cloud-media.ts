import { ConfigurationError, ProviderHTTPError, readJsonWithLimit, withTimeoutSignal } from "@zhivex-ai/core";

export interface QwenCloudRequestOptions { abortSignal?: AbortSignal; timeoutMs?: number }
export function requireCloudText(value: unknown, name: string, max = 10000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ConfigurationError(`${name} must be nonempty and at most ${max} characters.`);
}
export function requireCloudURL(value: unknown): asserts value is string {
  requireCloudText(value, "media URL");
  let url: URL; try { url = new URL(value); } catch { throw new ConfigurationError("Invalid media URL."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new ConfigurationError("Media requires an HTTP(S) URL without credentials.");
}
/** Mutations are deliberately not retried: these APIs have no idempotency key. */
export async function cloudRequest(apiKey: string, url: string, fetcher: typeof globalThis.fetch, options: QwenCloudRequestOptions, body?: unknown, async = false): Promise<any> {
  const { signal, cleanup } = withTimeoutSignal({ ...options, timeoutMs: options.timeoutMs ?? 60000 });
  try {
    const response = await fetcher(url, { method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(async ? { "X-DashScope-Async": "enable" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await readJsonWithLimit<any>(response, { provider: "qwen", endpoint: "cloud-media", maxBytes: 8 * 1024 * 1024 });
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new ConfigurationError("Invalid Qwen Cloud response envelope.");
    if (!response.ok || (json.code !== undefined && json.code !== 0)) throw new ProviderHTTPError("Qwen Cloud media request failed.", response.status, { responseBody: { code: typeof json.code === "string" || typeof json.code === "number" ? json.code : undefined, request_id: typeof json.request_id === "string" ? json.request_id : undefined } });
    return json;
  } finally { cleanup(); }
}
export interface QwenImageTranslationInput extends QwenCloudRequestOptions {
  imageUrl: string; sourceLanguage: string; targetLanguage: string;
  domainHint?: string; sensitiveWords?: string[]; terminologies?: Array<{ src: string; tgt: string }>; imageSegment?: boolean;
}
export interface QwenImageTranslationResult { imageUrl?: string; operationName?: string; requestId?: string; rawResponse: unknown }
export interface QwenImageTranslationModel { readonly modelId: string; translate(input: QwenImageTranslationInput & { async?: boolean }): Promise<QwenImageTranslationResult> }
export function createQwenImageTranslationModel(modelId: string, apiKey: string, taskBaseURL: string, fetcher: typeof globalThis.fetch): QwenImageTranslationModel {
  if (!["qwen-mt-image", "qwen-mt-image-2.0"].includes(modelId)) throw new ConfigurationError("Unsupported Qwen image translation model.");
  return { modelId, async translate(input) {
    requireCloudURL(input.imageUrl); requireCloudText(input.sourceLanguage, "sourceLanguage", 64); requireCloudText(input.targetLanguage, "targetLanguage", 64);
    if (input.targetLanguage.toLowerCase() === "auto") throw new ConfigurationError("targetLanguage cannot be auto.");
    if (input.domainHint !== undefined && input.domainHint.trim().split(/\s+/).length > 200) throw new ConfigurationError("domainHint supports at most 200 words.");
    if (input.sensitiveWords && (input.sensitiveWords.length > 50 || input.sensitiveWords.some(word => typeof word !== "string" || !word))) throw new ConfigurationError("sensitiveWords supports at most 50 nonempty strings.");
    for (const term of input.terminologies ?? []) { requireCloudText(term.src, "terminology.src"); requireCloudText(term.tgt, "terminology.tgt"); }
    const async = input.async ?? modelId === "qwen-mt-image";
    if (!async && modelId === "qwen-mt-image") throw new ConfigurationError("Legacy image translation only supports asynchronous mode.");
    const json = await cloudRequest(apiKey, `${taskBaseURL}/services/aigc/image2image/image-synthesis`, fetcher, input, { model: modelId, input: {
      image_url: input.imageUrl, source_lang: input.sourceLanguage, target_lang: input.targetLanguage,
      ext: { domainHint: input.domainHint, sensitives: input.sensitiveWords, terminologies: input.terminologies, config: { imageSegment: input.imageSegment } }
    } }, async);
    const value = async ? json.output?.task_id : json.output?.image_url;
    requireCloudText(value, async ? "response task ID" : "response image URL");
    if (!async) requireCloudURL(value);
    return { ...(async ? { operationName: value } : { imageUrl: value }), requestId: json.request_id, rawResponse: json };
  } };
}

export interface QwenWan30Media { type: "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio" | "file" | "link"; url: string }
export interface QwenWan30Parameters { resolution?: "480P" | "720P" | "1080P"; ratio?: "adaptive" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16"; duration?: number; audio?: boolean; prompt_extend?: boolean; watermark?: boolean; seed?: number }
export function validateWan30(media: unknown, parameters: Record<string, unknown>): void {
  if (parameters.duration !== undefined && (typeof parameters.duration !== "number" || !Number.isInteger(parameters.duration) || (parameters.duration !== -1 && (parameters.duration < 2 || parameters.duration > 30)))) throw new ConfigurationError("Wan 3.0 duration must be -1 or an integer from 2 to 30.");
  if (parameters.resolution !== undefined && !["480P", "720P", "1080P"].includes(String(parameters.resolution))) throw new ConfigurationError("Invalid Wan 3.0 resolution.");
  if (parameters.ratio !== undefined && !["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(String(parameters.ratio))) throw new ConfigurationError("Invalid Wan 3.0 ratio.");
  if (media === undefined) return;
  if (!Array.isArray(media) || !media.length) throw new ConfigurationError("Wan 3.0 media must be a nonempty array.");
  const counts: Record<string, number> = {};
  for (const item of media) {
    if (!item || !["first_frame", "last_frame", "reference_image", "reference_video", "reference_audio", "file", "link"].includes(item.type)) throw new ConfigurationError("Invalid Wan 3.0 media type.");
    if (typeof item.url === "string" && item.url.startsWith("data:") && item.type !== "link") {
      if (!/^data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.url)) throw new ConfigurationError("Invalid Wan 3.0 media data URI.");
    } else requireCloudURL(item.url);
    counts[item.type] = (counts[item.type] ?? 0) + 1;
  }
  for (const [type, max] of Object.entries({ first_frame: 1, last_frame: 1, reference_image: 10, reference_video: 5, reference_audio: 5, file: 1, link: 1 })) if ((counts[type] ?? 0) > max) throw new ConfigurationError(`Too many Wan 3.0 ${type} inputs.`);
  if (counts.last_frame && !counts.first_frame) throw new ConfigurationError("last_frame requires first_frame.");
  if ((counts.first_frame || counts.last_frame) && Object.keys(counts).some(type => type !== "first_frame" && type !== "last_frame")) throw new ConfigurationError("First/last frames cannot be mixed with reference media.");
  if ((counts.file || counts.link) && parameters.prompt_extend === false) throw new ConfigurationError("File/link input requires prompt_extend=true.");
  if (counts.file && counts.link) throw new ConfigurationError("Provide either a file or link, not both.");
}
export interface QwenImage30Parameters {
  n?: number; size?: string; negative_prompt?: string; prompt_extend?: boolean;
  prompt_extend_mode?: "direct" | "agent"; enable_thinking?: boolean; watermark?: boolean; seed?: number;
}
export interface QwenHappyHorseMedia { type: "first_frame" | "reference_image" | "video"; url: string }
export interface QwenHappyHorseParameters { resolution?: "480P" | "720P" | "1080P"; ratio?: string; duration?: number; watermark?: boolean; seed?: number; audio_setting?: "auto" | "origin" }
export function validateQwenImage30(input: { prompt: string; images?: unknown[]; count?: number; size?: string }, parameters: Record<string, unknown>): void {
  requireCloudText(input.prompt, "prompt", 100000);
  if ((input.images?.length ?? 0) > 3) throw new ConfigurationError("Qwen Image 3.0 accepts at most three reference images.");
  if (parameters.prompt_extend_mode !== undefined && !["direct", "agent"].includes(String(parameters.prompt_extend_mode))) throw new ConfigurationError("Invalid Image 3.0 prompt_extend_mode.");
  if (parameters.prompt_extend_mode === "agent" && input.images?.length) throw new ConfigurationError("Image 3.0 agent enhancement is text-to-image only.");
  const count = input.count ?? parameters.n;
  if (count !== undefined && (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 6)) throw new ConfigurationError("Qwen Image 3.0 count must be an integer from 1 to 6.");
  const size = input.size ?? parameters.size;
  if (size !== undefined) {
    const match = typeof size === "string" ? /^(\d+)\*(\d+)$/.exec(size) : null;
    const w = Number(match?.[1]), h = Number(match?.[2]);
    if (!match || w * h < 512 * 512 || w * h > 2048 * 2048 || w / h < 1 / 8 || w / h > 8) throw new ConfigurationError("Qwen Image 3.0 size requires width*height, 512²–2048² pixels and ratio 1:8–8:1.");
  }
}

/** HappyHorse uses media[], including first-frame input; it does not accept legacy img_url. */
export function validateHappyHorse(modelId: string, media: unknown, parameters: Record<string, unknown>): void {
  if (modelId === "happyhorse-1.0-video-edit") {
    if (parameters.duration !== undefined || parameters.ratio !== undefined) throw new ConfigurationError("HappyHorse video editing preserves source duration and ratio; omit duration and ratio.");
    if (parameters.resolution !== undefined && !["720P", "1080P"].includes(String(parameters.resolution))) throw new ConfigurationError("HappyHorse editing supports 720P or 1080P.");
    if (parameters.audio_setting !== undefined && !["auto", "origin"].includes(String(parameters.audio_setting))) throw new ConfigurationError("HappyHorse audio_setting must be auto or origin.");
    if (!Array.isArray(media) || media.filter(item => item?.type === "video").length !== 1 || media.filter(item => item?.type === "reference_image").length > 5 || media.some(item => !["video", "reference_image"].includes(item?.type))) throw new ConfigurationError("HappyHorse editing requires one video and at most five reference_image assets.");
    for (const item of media) {
      if (item.type === "reference_image" && typeof item.url === "string" && item.url.startsWith("data:")) {
        if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.url)) throw new ConfigurationError("Invalid HappyHorse reference image.");
      } else requireCloudURL(item.url);
    }
    return;
  }
  if (parameters.duration !== undefined && (typeof parameters.duration !== "number" || !Number.isInteger(parameters.duration) || parameters.duration < 3 || parameters.duration > 15)) throw new ConfigurationError("HappyHorse duration must be an integer from 3 to 15.");
  if (parameters.resolution !== undefined && !["480P", "720P", "1080P"].includes(String(parameters.resolution))) throw new ConfigurationError("Invalid HappyHorse resolution.");
  if (parameters.ratio !== undefined && !["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"].includes(String(parameters.ratio))) throw new ConfigurationError("Invalid HappyHorse ratio.");
  if (modelId.endsWith("-t2v")) { if (media !== undefined) throw new ConfigurationError("HappyHorse t2v does not accept media."); return; }
  const type = modelId.endsWith("-i2v") ? "first_frame" : modelId.endsWith("-r2v") ? "reference_image" : undefined;
  if (!type) return;
  if (!Array.isArray(media) || media.length < 1 || media.length > (type === "first_frame" ? 1 : 9)) throw new ConfigurationError(`HappyHorse ${type} media count is invalid.`);
  for (const item of media) {
    if (item?.type !== type) throw new ConfigurationError(`HappyHorse requires ${type} inputs.`);
    if (typeof item.url === "string" && item.url.startsWith("data:")) {
      if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.url)) throw new ConfigurationError("Invalid HappyHorse image data URI.");
    } else requireCloudURL(item.url);
  }
}

export interface QwenViduMedia { type: "image"; url: string }
export function prepareViduVideo(modelId: string, media: unknown, parameters: Record<string, unknown>): Record<string, unknown> {
  const bounds: Record<string, [number, number]> = {
    "vidu/viduq3-mix_reference2video": [1, 16], "vidu/viduq3-ad_reference2video": [3, 15],
    "vidu/viduq3-drama_reference2video": [2, 15], "vidu/viduq2-pro-fast_img2video": [1, 10]
  };
  const range = bounds[modelId]; if (!range) throw new ConfigurationError("Unsupported Vidu video model.");
  const firstFrame = modelId.endsWith("_img2video");
  if (!Array.isArray(media) || media.length < 1 || media.length > (firstFrame ? 1 : 7)) throw new ConfigurationError("Invalid Vidu image count.");
  for (const item of media) { if (item?.type !== "image") throw new ConfigurationError("Vidu requires media type=image."); requireCloudURL(item.url); }
  const output = { ...parameters };
  const duration = output.duration ?? 5;
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration < range[0] || duration > range[1]) throw new ConfigurationError(`Vidu duration must be an integer from ${range[0]} to ${range[1]}.`);
  output.duration = duration;
  const resolution = output.resolution ?? (modelId.includes("drama") ? "1080P" : "720P");
  if (resolution !== "720P" && resolution !== "1080P") throw new ConfigurationError("Vidu resolution must be 720P or 1080P.");
  output.resolution = resolution;
  if (firstFrame && output.ratio !== undefined) throw new ConfigurationError("Vidu first-frame output follows the image aspect ratio.");
  if (output.ratio !== undefined) {
    const ratios = modelId.includes("drama") ? ["16:9", "9:16"] : ["16:9", "4:3", "1:1", "3:4", "9:16"];
    if (!ratios.includes(String(output.ratio))) throw new ConfigurationError("Unsupported Vidu ratio.");
    const sizes: Record<string, string> = resolution === "720P" ? { "16:9": "1280*720", "4:3": "1280*960", "1:1": "1280*1280", "3:4": "960*1280", "9:16": "720*1280" } : { "16:9": "1920*1080", "4:3": "1920*1440", "1:1": "1920*1920", "3:4": "1440*1920", "9:16": "1080*1920" };
    output.size = sizes[String(output.ratio)]; delete output.ratio;
  }
  if (output.n !== undefined && output.n !== 1) throw new ConfigurationError("Vidu produces one video per task.");
  delete output.n;
  if (output.audio !== undefined && (modelId.includes("drama") || firstFrame)) throw new ConfigurationError("audio toggle is supported only by Vidu mix/ad models.");
  return output;
}
export function validateViduImage(input: { prompt: string; images?: unknown[]; count?: number; size?: string }, parameters: Record<string, unknown>): void {
  requireCloudText(input.prompt, "prompt", 5000);
  if ((input.images?.length ?? 0) > 14) throw new ConfigurationError("Vidu accepts at most 14 reference images.");
  if ((input.count ?? parameters.n ?? 1) !== 1) throw new ConfigurationError("Vidu generates one image per task.");
  const sizes = "1024*1024,720*1440,1440*720,1024*768,768*1024,1920*1088,1088*1920,1536*1024,1024*1536,1920*816,816*1920,2048*2048,1088*2160,2160*1088,2736*2048,2048*2736,2560*1440,1440*2560,3072*2048,2048*3072,2560*1104,1104*2560,2880*2880,1440*2880,2880*1440,3312*2480,2480*3312,3840*2160,2160*3840,3520*2352,2352*3520,3840*1648,1648*3840".split(",");
  if (!sizes.includes(String(input.size ?? parameters.size ?? "1024*1024"))) throw new ConfigurationError("Unsupported Vidu image size.");
}
