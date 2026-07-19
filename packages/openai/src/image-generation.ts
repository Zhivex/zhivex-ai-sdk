import { Buffer } from "node:buffer";

import {
  ParseError,
  ProviderHTTPError,
  UnsupportedFeatureError,
  ValidationError,
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
} from "@zhivex-ai/core";

const MIB = 1024 * 1024;
const DEFAULT_RESPONSE_MAX_BYTES = 128 * MIB;
const DEFAULT_ERROR_BODY_MAX_BYTES = 64 * 1024;

export type OpenAIImageOutputFormat = "png" | "jpeg" | "webp";
export type OpenAIImageSize = "auto" | `${number}x${number}`;
export type OpenAIImageQuality = "auto" | "low" | "medium" | "high" | "standard" | "hd";

export type OpenAIImageGenerationOptions = Record<string, unknown> & {
  background?: "auto" | "opaque" | "transparent";
  moderation?: "auto" | "low";
  output_compression?: number;
  output_format?: OpenAIImageOutputFormat;
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
  quality?: "auto" | "low" | "medium" | "high";
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

const outputFormatFromMimeType = (mediaType: string | undefined): OpenAIImageOutputFormat | undefined => {
  if (mediaType === undefined) return undefined;
  const normalized = mediaType.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpeg";
  if (normalized === "image/webp") return "webp";
  throw new UnsupportedFeatureError(`Provider "openai" does not support image output MIME type "${mediaType}".`);
};

const mediaTypeFromOutputFormat = (format: OpenAIImageOutputFormat | undefined) =>
  format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";

const normalizedModelId = (modelId: string) => modelId.trim().toLowerCase();
const isGPTImageModel = (modelId: string) => /^gpt-image(?:-|$)/.test(normalizedModelId(modelId));
const isGPTImage2Model = (modelId: string) => /^gpt-image-2(?:-|$)/.test(normalizedModelId(modelId));
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

  if (isGPTImage2Model(modelId)) {
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

export class OpenAIImageGenerationModel implements ImageGenerationModel<OpenAIImageGenerationOptions> {
  readonly provider = "openai";
  readonly capabilities = imageGenerationCapabilities;

  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly responseMaxBytes: number;
  private readonly errorBodyMaxBytes: number;

  constructor(config: OpenAIImageGenerationModelConfig) {
    this.modelId = config.modelId;
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetcher = config.fetch ?? globalThis.fetch;
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

    if (input.images?.length) {
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

    validateIntegerRange(
      typeof providerOptions.output_compression === "number" ? providerOptions.output_compression : undefined,
      "output_compression",
      0,
      100
    );

    const mimeOutputFormat = outputFormatFromMimeType(input.outputMimeType);
    let outputFormat = mimeOutputFormat ??
      (providerOptions.output_format as OpenAIImageOutputFormat | undefined);
    if (outputFormat !== undefined && !["png", "jpeg", "webp"].includes(outputFormat)) {
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

    const size = input.size ?? sizeFromAspectRatio(input.aspectRatio, this.modelId);
    const { signal, cleanup, abort } = withTimeoutSignal(input);

    try {
      const json = await withRetry(async () => {
        const response = await this.fetcher(`${this.baseURL}/images/generations`, {
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
          endpoint: "images/generations",
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
