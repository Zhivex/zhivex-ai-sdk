import { withManualRedirect } from "./manual-redirect.js";
import { Buffer } from "node:buffer";

import {
  ParseError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  ValidationError,
  assertTrustedEndpoint,
  decodeBase64WithLimit,
  hostedTool,
  readErrorBodyWithLimit,
  readJsonWithLimit,
  withRetry,
  withTimeoutSignal,
  type GeneratedMedia,
  type ImageGenerationModel,
  type ImageGenerationModelInput,
  type ImageGenerationResult,
  type JsonValue,
  type ModelCapabilities
} from "@zhivex-ai/core/provider";

const MIB = 1024 * 1024;
const DEFAULT_RESPONSE_MAX_BYTES = 128 * MIB;
const DEFAULT_ERROR_BODY_MAX_BYTES = 64 * 1024;

export type OpenAIImageOutputFormat = "png" | "jpeg" | "webp";
export type OpenAIImageApiOutputFormat = OpenAIImageOutputFormat | "svg" | "gif";
export type OpenAIImageSize = "auto" | `${number}x${number}`;
export type OpenAIImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max" | "standard" | "hd";
export type OpenAIImageComplexity = "low" | "medium" | "high";
export type OpenAIImageJsonReference =
  | { image_url: string; file_id?: never }
  | { file_id: string; image_url?: never };

export type OpenAIImageGenerationOptions = Record<string, unknown> & {
  background?: "auto" | "opaque" | "transparent";
  complexity?: OpenAIImageComplexity;
  frame_count?: number;
  frame_duration_ms?: number;
  markup?: OpenAIImageJsonReference;
  mask?: OpenAIImageJsonReference;
  moderation?: "auto" | "low";
  output_compression?: number;
  output_format?: OpenAIImageApiOutputFormat;
  quality?: OpenAIImageQuality;
  response_format?: "url" | "b64_json";
  style?: "vivid" | "natural";
  user?: string;
  /** Extra HTTP headers. Authorization and content-type remain SDK-controlled. */
  headers?: Record<string, string>;
  /** Maximum JSON response size, including base64 image data. Defaults to 128 MiB. */
  responseMaxBytes?: number;
  /** Maximum error response body retained for diagnostics. Defaults to 64 KiB. */
  errorBodyMaxBytes?: number;
  /** Explicitly allow non-HTTPS or private custom endpoints. */
  allowUnsafeEndpoints?: boolean;
  /** Streaming belongs to the Responses/Image streaming APIs, not ImageGenerationModel. */
  stream?: false;
  partial_images?: never;
};

export interface OpenAIImageGenerationToolConfig {
  action?: "auto" | "generate" | "edit";
  background?: "auto" | "opaque" | "transparent";
  input_fidelity?: "low" | "high";
  output_compression?: number;
  output_format?: OpenAIImageOutputFormat;
  partial_images?: 0 | 1 | 2 | 3;
  model?: string;
  quality?: "auto" | "low" | "medium" | "high" | "xhigh" | "max";
  size?: OpenAIImageSize;
}

export interface OpenAIImageGenerationToolChoice {
  type: "image_generation";
}

export interface OpenAIImageGenerationModelConfig {
  modelId: string;
  apiKey: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  responseMaxBytes?: number;
  errorBodyMaxBytes?: number;
  /** Explicitly allow non-HTTPS or private custom endpoints. */
  allowUnsafeEndpoints?: boolean;
}

export interface OpenAIImageGenerationCall {
  type: "image_generation_call";
  id?: string;
  status?: string;
  revised_prompt?: string | null;
  result?: string | null;
  output_format?: OpenAIImageOutputFormat;
  [key: string]: unknown;
}

export interface NormalizedOpenAIImageGenerationCall {
  id?: string;
  status?: string;
  revisedPrompt?: string;
  image?: GeneratedMedia;
  providerMetadata: Record<string, unknown>;
}

export type OpenAIImageGenerationPartialImageEvent =
  | {
      type: "response.image_generation_call.partial_image";
      partial_image_b64: string;
      partial_image_index: number;
      item_id?: string;
      output_index?: number;
      sequence_number?: number;
      output_format?: OpenAIImageOutputFormat;
      [key: string]: unknown;
    }
  | {
      type: "image_generation.partial_image";
      b64_json: string;
      partial_image_index: number;
      output_format?: OpenAIImageOutputFormat;
      [key: string]: unknown;
    };

export interface NormalizedOpenAIImageGenerationPartialImage {
  source: "responses" | "images";
  callId?: string;
  partialImageIndex: number;
  outputIndex?: number;
  sequenceNumber?: number;
  image: GeneratedMedia;
  providerMetadata: Record<string, unknown>;
}

type OpenAIImagesResponseItem = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  [key: string]: unknown;
};

type OpenAIImagesResponse = {
  data?: OpenAIImagesResponseItem[];
  [key: string]: unknown;
};

const imageGenerationCapabilities: ModelCapabilities = {
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  imageGeneration: true,
  reasoning: false,
  webSearch: false
};

const normalizePositiveLimit = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`The OpenAI image generation "${name}" option must be a positive safe integer.`);
  }
  return value;
};

const validateIntegerRange = (value: number | undefined, name: string, minimum: number, maximum: number) => {
  if (value === undefined) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ValidationError(`The OpenAI image generation "${name}" option must be an integer from ${minimum} to ${maximum}.`);
  }
};

const outputFormatFromMimeType = (mediaType: string | undefined): OpenAIImageApiOutputFormat | undefined => {
  if (mediaType === undefined) return undefined;
  const normalized = mediaType.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpeg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized === "image/gif") return "gif";
  throw new UnsupportedFeatureError(`Provider "openai" does not support image output MIME type "${mediaType}".`);
};

const mediaTypeFromOutputFormat = (format: OpenAIImageApiOutputFormat | undefined) =>
  format === "jpeg" ? "image/jpeg"
    : format === "webp" ? "image/webp"
      : format === "svg" ? "image/svg+xml"
        : format === "gif" ? "image/gif"
          : "image/png";

const normalizedModelId = (modelId: string) => modelId.trim().toLowerCase();
const isGPTImageModel = (modelId: string) => /^gpt-image(?:-|$)/.test(normalizedModelId(modelId));
const isGPTImage2Model = (modelId: string) => /^gpt-image-2(?:-|$)/.test(normalizedModelId(modelId));
const isGPTImage25Model = (modelId: string) =>
  /^gpt-image-2\.5-(?:flare|sunburst)(?:-\d{4}-\d{2}-\d{2})?$/.test(normalizedModelId(modelId));
/** Published ids only. The 2.6 model pages do not list dated snapshots. */
const isGPTImage26Model = (modelId: string) =>
  /^gpt-image-2\.6-(?:flare|sunburst)$/.test(normalizedModelId(modelId));
const supportsGptImageApiEdits = (modelId: string) =>
  isGPTImage25Model(modelId) || isGPTImage26Model(modelId);

const assertExtendedImageQuality = (modelId: string | undefined, quality: unknown) => {
  if (quality !== "xhigh" && quality !== "max") return;
  if (modelId !== undefined && (isGPTImage25Model(modelId) || isGPTImage26Model(modelId))) return;
  throw new UnsupportedFeatureError(
    `Provider "openai" image quality "${quality}" is supported by gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2.6-flare, and gpt-image-2.6-sunburst.`
  );
};
const isDallE2Model = (modelId: string) => /^dall-e-2(?:-|$)/.test(normalizedModelId(modelId));
const isDallE3Model = (modelId: string) => /^dall-e-3(?:-|$)/.test(normalizedModelId(modelId));

const promptLimitForModel = (modelId: string) => {
  if (isDallE2Model(modelId)) return 1_000;
  if (isDallE3Model(modelId)) return 4_000;
  if (isGPTImageModel(modelId)) return 32_000;
  return undefined;
};

const sizeFromAspectRatio = (aspectRatio: string | undefined, modelId: string): OpenAIImageSize | undefined => {
  if (!aspectRatio) return undefined;
  const normalized = aspectRatio.replaceAll(" ", "");
  if (isDallE2Model(modelId)) {
    if (normalized === "1:1") return "1024x1024";
    throw new UnsupportedFeatureError(
      `Provider "openai" model "dall-e-2" cannot map aspect ratio "${aspectRatio}" because it only supports square output.`
    );
  }
  if (isDallE3Model(modelId)) {
    if (normalized === "1:1") return "1024x1024";
    if (normalized === "16:9") return "1792x1024";
    if (normalized === "9:16") return "1024x1792";
    throw new UnsupportedFeatureError(
      `Provider "openai" cannot map aspect ratio "${aspectRatio}" to a supported size for model "dall-e-3". Pass an explicit "size" instead.`
    );
  }

  const standard: Record<string, OpenAIImageSize> = {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536"
  };
  if (standard[normalized]) return standard[normalized];

  if (isGPTImage2Model(modelId) || isGPTImage25Model(modelId) || isGPTImage26Model(modelId)) {
    if (normalized === "16:9") return "1536x864";
    if (normalized === "9:16") return "864x1536";
  }

  throw new UnsupportedFeatureError(
    `Provider "openai" cannot map aspect ratio "${aspectRatio}" to a supported size for model "${modelId}". Pass an explicit "size" instead.`
  );
};

const sanitizeMetadata = (value: Record<string, unknown>, base64Keys: string[]) => {
  const sanitized = { ...value };
  for (const key of base64Keys) delete sanitized[key];
  return sanitized;
};

const validateToolConfig = (config: OpenAIImageGenerationToolConfig) => {
  if (config.model !== undefined && isGPTImage26Model(config.model)) {
    throw new UnsupportedFeatureError(
      `Provider "openai" model "${config.model}" is not available on the Responses image_generation tool. Use Image API generations or edits.`
    );
  }
  assertExtendedImageQuality(config.model, config.quality);
  validateIntegerRange(config.partial_images, "partial_images", 0, 3);
  validateIntegerRange(config.output_compression, "output_compression", 0, 100);
  if (config.background === "transparent" && config.output_format === "jpeg") {
    throw new ValidationError('OpenAI image generation requires "png" or "webp" output for a transparent background.');
  }
};

/** Creates the hosted Responses API image_generation tool definition. */
export const openAIImageGenerationTool = (config: OpenAIImageGenerationToolConfig = {}) => {
  validateToolConfig(config);
  return hostedTool({
    name: "image_generation",
    provider: "openai",
    type: "image_generation",
    toolClass: "custom",
    config: config as unknown as JsonValue
  });
};

/** Forces the hosted Responses image_generation tool for the current turn. */
export const openAIImageGenerationToolChoice = (): OpenAIImageGenerationToolChoice => ({
  type: "image_generation"
});

export const isOpenAIImageGenerationCall = (value: unknown): value is OpenAIImageGenerationCall =>
  Boolean(value && typeof value === "object" && (value as Record<string, unknown>).type === "image_generation_call");

/** Decodes a Responses image_generation_call without retaining a second base64 copy in metadata. */
export const normalizeOpenAIImageGenerationCall = (
  value: unknown,
  fallbackOutputFormat: OpenAIImageOutputFormat = "png",
  maxImageBytes?: number
): NormalizedOpenAIImageGenerationCall | undefined => {
  if (!isOpenAIImageGenerationCall(value)) return undefined;
  const revisedPrompt = typeof value.revised_prompt === "string" ? value.revised_prompt : undefined;
  const outputFormat = value.output_format ?? fallbackOutputFormat;
  const providerMetadata = sanitizeMetadata(value, ["result"]);
  const result = typeof value.result === "string" && value.result ? value.result : undefined;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    revisedPrompt,
    image: result
      ? {
          data: maxImageBytes === undefined
            ? Uint8Array.from(Buffer.from(result, "base64"))
            : decodeBase64WithLimit(result, {
                maxBytes: maxImageBytes,
                provider: "openai",
                endpoint: "hosted image generation event"
              }),
          mediaType: mediaTypeFromOutputFormat(outputFormat),
          text: revisedPrompt,
          providerMetadata
        }
      : undefined,
    providerMetadata
  };
};

export const isOpenAIImageGenerationPartialImageEvent = (
  value: unknown
): value is OpenAIImageGenerationPartialImageEvent => {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    (event.type === "response.image_generation_call.partial_image" && typeof event.partial_image_b64 === "string") ||
    (event.type === "image_generation.partial_image" && typeof event.b64_json === "string")
  ) && Number.isSafeInteger(event.partial_image_index);
};

/** Normalizes partial images from both Responses and the streaming Image API. */
export const normalizeOpenAIImageGenerationPartialImage = (
  value: unknown,
  fallbackOutputFormat: OpenAIImageOutputFormat = "png",
  maxImageBytes?: number
): NormalizedOpenAIImageGenerationPartialImage | undefined => {
  if (!isOpenAIImageGenerationPartialImageEvent(value)) return undefined;
  const isResponses = value.type === "response.image_generation_call.partial_image";
  const base64 = isResponses ? value.partial_image_b64 : value.b64_json;
  const providerMetadata = sanitizeMetadata(value, ["partial_image_b64", "b64_json"]);
  return {
    source: isResponses ? "responses" : "images",
    callId: isResponses && typeof value.item_id === "string" ? value.item_id : undefined,
    partialImageIndex: value.partial_image_index,
    outputIndex: isResponses && typeof value.output_index === "number" ? value.output_index : undefined,
    sequenceNumber: isResponses && typeof value.sequence_number === "number" ? value.sequence_number : undefined,
    image: {
      data: maxImageBytes === undefined
        ? Uint8Array.from(Buffer.from(base64, "base64"))
        : decodeBase64WithLimit(base64, {
            maxBytes: maxImageBytes,
            provider: "openai",
            endpoint: "hosted image generation event"
          }),
      mediaType: mediaTypeFromOutputFormat(value.output_format ?? fallbackOutputFormat),
      providerMetadata
    },
    providerMetadata
  };
};

const MARKUP_MAX_BYTES = 50 * 1024 * 1024;

const dataUrlByteLength = (dataUrl: string) => {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor(payload.length * 3 / 4) - padding;
};

const assertHttpsOrImageDataUrl = (value: string, name: string, pngOnly: boolean) => {
  if (/^https:\/\//i.test(value)) return;
  const dataUrl = pngOnly
    ? /^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i
    : /^data:image\/[a-z0-9][a-z0-9.+-]*;base64,[a-z0-9+/]+={0,2}$/i;
  if (!dataUrl.test(value)) {
    throw new ValidationError(
      pngOnly
        ? `The OpenAI image generation "${name}" image_url must be an HTTPS URL or a base64 image/png data URL.`
        : `The OpenAI image generation "${name}" image_url must be an HTTPS URL or a base64 image data URL.`
    );
  }
  if (/^data:image\/svg\+xml/i.test(value)) {
    throw new UnsupportedFeatureError('Provider "openai" image edits do not accept SVG input.');
  }
  if (pngOnly && dataUrlByteLength(value) > MARKUP_MAX_BYTES) {
    throw new ValidationError('The OpenAI image generation "markup" data URL exceeds the 50 MB limit.');
  }
};

const readJsonImageReference = (value: unknown, name: string): OpenAIImageJsonReference | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`The OpenAI image generation "${name}" option must be an object with image_url or file_id.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || (keys[0] !== "image_url" && keys[0] !== "file_id")) {
    throw new ValidationError(`The OpenAI image generation "${name}" option must contain exactly one of image_url or file_id.`);
  }
  if (keys[0] === "file_id") {
    if (typeof record.file_id !== "string" || record.file_id.length === 0 || record.file_id.trim() !== record.file_id) {
      throw new ValidationError(`The OpenAI image generation "${name}.file_id" must be a non-empty string.`);
    }
    return { file_id: record.file_id };
  }
  if (typeof record.image_url !== "string" || record.image_url.length === 0) {
    throw new ValidationError(`The OpenAI image generation "${name}.image_url" must be a string.`);
  }
  assertHttpsOrImageDataUrl(record.image_url, name, name === "markup");
  return { image_url: record.image_url };
};

const mediaBytes = (data: NonNullable<ImageGenerationModelInput["images"]>[number]["data"]) => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data !== "string" || !/^[a-z0-9+/]+={0,2}$/i.test(data)) {
    throw new ValidationError("OpenAI image edit data must be bytes or base64.");
  }
  return Uint8Array.from(Buffer.from(data, "base64"));
};

const imageReferenceFromMedia = (
  image: NonNullable<ImageGenerationModelInput["images"]>[number],
  name: string
): OpenAIImageJsonReference => {
  const fileId = image.providerMetadata?.file_id;
  const hasFileId = typeof fileId === "string" && fileId.length > 0;
  const hasUri = typeof image.uri === "string" && image.uri.length > 0;
  const hasData = image.data !== undefined && image.data !== "";
  if (hasFileId && (hasUri || hasData)) {
    throw new ValidationError(`OpenAI image edit "${name}" must contain exactly one of file_id or image data.`);
  }
  if (hasFileId && typeof fileId === "string") {
    if (fileId.trim() !== fileId) {
      throw new ValidationError(`OpenAI image edit "${name}" file_id must not have surrounding whitespace.`);
    }
    return { file_id: fileId };
  }
  if (hasUri && image.uri) {
    if (/^data:image\/svg\+xml/i.test(image.uri) || image.mediaType.trim().toLowerCase() === "image/svg+xml") {
      throw new UnsupportedFeatureError('Provider "openai" image edits do not accept SVG input.');
    }
    assertHttpsOrImageDataUrl(image.uri, name, false);
    return { image_url: image.uri };
  }
  if (!hasData || image.data === undefined) {
    throw new ValidationError(`OpenAI image edit "${name}" requires image bytes, an HTTPS URL, a data URL, or file_id.`);
  }
  const mediaType = image.mediaType.trim().toLowerCase();
  if (mediaType === "image/svg+xml") {
    throw new UnsupportedFeatureError('Provider "openai" image edits do not accept SVG input.');
  }
  if (!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(mediaType)) {
    throw new ValidationError(`OpenAI image edit "${name}" requires an image/* mediaType.`);
  }
  const bytes = mediaBytes(image.data);
  return { image_url: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}` };
};

const readOptionalInteger = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new ValidationError(`The OpenAI image generation "${name}" option must be an integer.`);
  }
  return value;
};

export class OpenAIImageGenerationModel implements ImageGenerationModel<OpenAIImageGenerationOptions> {
  readonly provider = "openai";
  readonly capabilities: ModelCapabilities;

  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly responseMaxBytes: number;
  private readonly errorBodyMaxBytes: number;

  constructor(config: OpenAIImageGenerationModelConfig) {
    this.modelId = config.modelId;
    this.capabilities = {
      ...imageGenerationCapabilities,
      vision: supportsGptImageApiEdits(config.modelId)
    };
    this.apiKey = config.apiKey;
    this.baseURL = assertTrustedEndpoint(config.baseURL ?? "https://api.openai.com/v1", {
      label: "OpenAI image generation baseURL",
      protocols: ["https"],
      allowUnsafe: config.allowUnsafeEndpoints
    }).toString().replace(/\/$/, "");
    this.fetcher = withManualRedirect(config.fetch ?? globalThis.fetch);
    this.responseMaxBytes = normalizePositiveLimit(
      config.responseMaxBytes ?? DEFAULT_RESPONSE_MAX_BYTES,
      "responseMaxBytes"
    );
    this.errorBodyMaxBytes = normalizePositiveLimit(
      config.errorBodyMaxBytes ?? DEFAULT_ERROR_BODY_MAX_BYTES,
      "errorBodyMaxBytes"
    );
  }

  async generateImage(
    input: ImageGenerationModelInput<OpenAIImageGenerationOptions>
  ): Promise<ImageGenerationResult> {
    if (!input.prompt.trim()) {
      throw new ValidationError('The OpenAI image generation "prompt" field is required.');
    }

    const promptLimit = promptLimitForModel(this.modelId);
    if (promptLimit !== undefined && input.prompt.length > promptLimit) {
      throw new ValidationError(
        `The OpenAI image generation prompt exceeds the ${promptLimit}-character limit for model "${this.modelId}".`
      );
    }

    const editing = Boolean(input.images?.length);
    if (editing && !supportsGptImageApiEdits(this.modelId)) {
      throw new UnsupportedFeatureError(
        'Provider "openai" image generations do not accept input images. Use the Responses image_generation tool for conversational edits.'
      );
    }
    if (input.negativePrompt) {
      throw new UnsupportedFeatureError('Provider "openai" image generations do not support a separate negative prompt.');
    }

    validateIntegerRange(input.count, "count", 1, 10);
    if (isDallE3Model(this.modelId) && input.count !== undefined && input.count !== 1) {
      throw new UnsupportedFeatureError('Provider "openai" model "dall-e-3" only supports one image per request.');
    }

    const providerOptions = { ...(input.providerOptions ?? {}) };
    if (providerOptions.stream !== undefined && providerOptions.stream !== false) {
      throw new UnsupportedFeatureError(
        'OpenAI Image API streaming is not supported through ImageGenerationModel. Use the Responses streaming API for partial images.'
      );
    }
    if (providerOptions.partial_images !== undefined) {
      throw new UnsupportedFeatureError(
        'The OpenAI "partial_images" option requires streaming and is not supported through ImageGenerationModel.'
      );
    }

    const customHeaders = providerOptions.headers;
    if (customHeaders !== undefined && (!customHeaders || typeof customHeaders !== "object" || Array.isArray(customHeaders))) {
      throw new ValidationError('The OpenAI image generation "headers" option must be an object.');
    }
    const safeCustomHeaders = Object.fromEntries(
      Object.entries((customHeaders ?? {}) as Record<string, string>).filter(
        ([key]) => !["authorization", "content-type"].includes(key.toLowerCase())
      )
    );
    delete providerOptions.headers;
    delete providerOptions.stream;
    delete providerOptions.partial_images;

    const responseMaxBytes = normalizePositiveLimit(
      typeof providerOptions.responseMaxBytes === "number" ? providerOptions.responseMaxBytes : this.responseMaxBytes,
      "responseMaxBytes"
    );
    const errorBodyMaxBytes = normalizePositiveLimit(
      typeof providerOptions.errorBodyMaxBytes === "number" ? providerOptions.errorBodyMaxBytes : this.errorBodyMaxBytes,
      "errorBodyMaxBytes"
    );
    delete providerOptions.responseMaxBytes;
    delete providerOptions.errorBodyMaxBytes;
    assertExtendedImageQuality(this.modelId, providerOptions.quality);

    validateIntegerRange(
      typeof providerOptions.output_compression === "number" ? providerOptions.output_compression : undefined,
      "output_compression",
      0,
      100
    );

    const mimeOutputFormat = outputFormatFromMimeType(input.outputMimeType);
    let outputFormat = mimeOutputFormat ??
      (providerOptions.output_format as OpenAIImageApiOutputFormat | undefined);
    if (outputFormat !== undefined && !["png", "jpeg", "webp", "svg", "gif"].includes(outputFormat)) {
      throw new ValidationError(`The OpenAI image generation "output_format" option "${String(outputFormat)}" is invalid.`);
    }

    if (isDallE2Model(this.modelId) || isDallE3Model(this.modelId)) {
      if (mimeOutputFormat !== undefined && mimeOutputFormat !== "png") {
        throw new UnsupportedFeatureError(`Provider "openai" model "${this.modelId}" only supports PNG image output.`);
      }
      if (providerOptions.output_format !== undefined) {
        throw new UnsupportedFeatureError(
          `Provider "openai" model "${this.modelId}" does not support the "output_format" option.`
        );
      }
      outputFormat = undefined;
    }
    if (isGPTImageModel(this.modelId) && providerOptions.response_format !== undefined) {
      throw new UnsupportedFeatureError(
        `Provider "openai" model "${this.modelId}" always returns base64 images and does not support "response_format".`
      );
    }

    const background = providerOptions.background;
    if (background === "transparent" && outputFormat === "jpeg") {
      throw new ValidationError('OpenAI image generation requires "png" or "webp" output for a transparent background.');
    }
    if (isGPTImage2Model(this.modelId) && background === "transparent") {
      throw new UnsupportedFeatureError('Provider "openai" model "gpt-image-2" does not support transparent backgrounds.');
    }
    if (providerOptions.output_compression !== undefined && outputFormat !== "jpeg" && outputFormat !== "webp") {
      throw new ValidationError(
        'OpenAI image generation only supports "output_compression" with "jpeg" or "webp" output.'
      );
    }

    const complexity = providerOptions.complexity;
    const frameCount = readOptionalInteger(providerOptions.frame_count, "frame_count");
    const frameDuration = readOptionalInteger(providerOptions.frame_duration_ms, "frame_duration_ms");
    const markup = readJsonImageReference(providerOptions.markup, "markup");
    const mask = readJsonImageReference(providerOptions.mask, "mask");
    delete providerOptions.complexity;
    delete providerOptions.frame_count;
    delete providerOptions.frame_duration_ms;
    delete providerOptions.markup;
    delete providerOptions.mask;

    if (isGPTImage26Model(this.modelId)) {
      if (providerOptions.input_fidelity !== undefined) {
        throw new UnsupportedFeatureError('Provider "openai" GPT Image 2.6 does not accept input_fidelity.');
      }
      if (providerOptions.reasoning !== undefined || providerOptions.reasoning_summary !== undefined) {
        throw new UnsupportedFeatureError('Provider "openai" GPT Image 2.6 does not support reasoning.summary.');
      }
    }
    if (complexity !== undefined) {
      if (!isGPTImage26Model(this.modelId) || (complexity !== "low" && complexity !== "medium" && complexity !== "high")) {
        throw new UnsupportedFeatureError(
          'Provider "openai" image complexity must be "low", "medium", or "high" on gpt-image-2.6-flare or gpt-image-2.6-sunburst.'
        );
      }
    }
    if (outputFormat === "svg" && (!isGPTImage26Model(this.modelId) || editing)) {
      throw new UnsupportedFeatureError('Provider "openai" SVG output is supported on GPT Image 2.6 generations only.');
    }
    if (outputFormat === "svg" && input.count !== undefined && input.count !== 1) {
      throw new ValidationError('OpenAI SVG image generation requires count 1.');
    }
    if (outputFormat === "gif" && !isGPTImage26Model(this.modelId)) {
      throw new UnsupportedFeatureError(
        'Provider "openai" GIF output is supported by gpt-image-2.6-flare and gpt-image-2.6-sunburst.'
      );
    }
    if ((frameCount !== undefined || frameDuration !== undefined) && outputFormat !== "gif") {
      throw new ValidationError('OpenAI image generation only supports frame_count and frame_duration_ms with GIF output.');
    }
    validateIntegerRange(frameCount, "frame_count", 2, 16);
    validateIntegerRange(frameDuration, "frame_duration_ms", 20, 2000);
    if ((markup || mask) && !editing) {
      throw new ValidationError('OpenAI image markup and mask require an input image on the edits endpoint.');
    }
    if (markup && mask) {
      throw new ValidationError('OpenAI image edits cannot combine markup with mask.');
    }
    if (markup && !supportsGptImageApiEdits(this.modelId)) {
      throw new UnsupportedFeatureError(
        'Provider "openai" markup-guided edits are supported by GPT Image 2.5 and GPT Image 2.6.'
      );
    }

    const size = input.size ?? sizeFromAspectRatio(input.aspectRatio, this.modelId);
    const inputImages = editing
      ? input.images!.map((image, index) => imageReferenceFromMedia(image, `images[${index}]`))
      : undefined;
    const { signal, cleanup, abort } = withTimeoutSignal(input);

    try {
      const json = await withRetry(async () => {
        const response = await this.fetcher(`${this.baseURL}/images/${editing ? "edits" : "generations"}`, {
          method: "POST",
          headers: {
            ...safeCustomHeaders,
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`
          },
          signal,
          body: JSON.stringify({
            ...providerOptions,
            model: this.modelId,
            prompt: input.prompt,
            ...(inputImages ? { images: inputImages } : {}),
            ...(markup ? { markup } : {}),
            ...(mask ? { mask } : {}),
            ...(complexity !== undefined ? { complexity } : {}),
            ...(frameCount !== undefined ? { frame_count: frameCount } : {}),
            ...(frameDuration !== undefined ? { frame_duration_ms: frameDuration } : {}),
            n: input.count,
            size,
            output_format: outputFormat
          })
        });

        if (!response.ok) {
          const responseBody = await readErrorBodyWithLimit(response, errorBodyMaxBytes);
          throw new ProviderHTTPError(`OpenAI image generation failed with status ${response.status}.`, response.status, {
            responseBody
          });
        }

        return readJsonWithLimit<OpenAIImagesResponse>(response, {
          maxBytes: responseMaxBytes,
          provider: "openai",
          endpoint: editing ? "images/edits" : "images/generations",
          abort
        });
      }, input);

      if (!Array.isArray(json.data)) {
        throw new ParseError("OpenAI image generation response did not contain an image data array.");
      }

      const mediaType = mediaTypeFromOutputFormat(outputFormat);
      const images = json.data.map((item, index): GeneratedMedia => {
        if (!item || typeof item !== "object") {
          throw new ParseError(`OpenAI image generation response item ${index} was invalid.`);
        }
        const providerMetadata = sanitizeMetadata(item, ["b64_json"]);
        const hasData = typeof item.b64_json === "string" && item.b64_json.length > 0;
        const hasUri = typeof item.url === "string" && item.url.length > 0;
        if (!hasData && !hasUri) {
          throw new ParseError(`OpenAI image generation response item ${index} contained neither image data nor a URL.`);
        }
        return {
          data: hasData ? Uint8Array.from(Buffer.from(item.b64_json!, "base64")) : undefined,
          uri: hasUri ? item.url : undefined,
          mediaType,
          text: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
          providerMetadata
        };
      });

      const revisedPrompts = images.flatMap((image) => image.text ? [image.text] : []);
      return {
        images,
        text: revisedPrompts.length ? revisedPrompts.join("\n") : undefined,
        rawResponse: {
          ...json,
          data: json.data.map((item) => sanitizeMetadata(item, ["b64_json"]))
        }
      };
    } finally {
      cleanup();
    }
  }
}

export const createOpenAIImageGenerationModel = (config: OpenAIImageGenerationModelConfig) =>
  new OpenAIImageGenerationModel(config);
