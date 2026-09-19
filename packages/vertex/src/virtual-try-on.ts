import {
  ConfigurationError, decodeBase64WithLimit, encodeMediaFrame,
  type ImageGenerationResult, type MediaInput, type PredictionModel, type RetryOptions, type JsonValue
} from "@zhivex-ai/core/provider";

export interface VertexVirtualTryOnInput extends RetryOptions {
  personImage: MediaInput;
  productImage: MediaInput;
  productMask?: MediaInput;
  productImageConfig?: Record<string, JsonValue>;
  prompt?: string;
  count?: number;
  outputMimeType?: "image/png" | "image/jpeg";
  outputStorageUri?: string;
  /** Native VirtualTryOnModelParams, e.g. baseSteps, seed, addWatermark, outputOptions. */
  providerOptions?: Record<string, JsonValue>;
}
export interface VertexVirtualTryOnResult extends ImageGenerationResult {
  filtered: Array<{ reason: string }>;
}
export interface VertexVirtualTryOnClient {
  generate(input: VertexVirtualTryOnInput): Promise<VertexVirtualTryOnResult>;
}
const gcs = (uri: string) => /^gs:\/\/[^/\s?#]+\/[^\s?#]+$/.test(uri);
const media = (image: MediaInput) => {
  if (!image || !["image/png", "image/jpeg"].includes(image.mediaType) ||
    (image.data === undefined) === (image.uri === undefined)) throw new ConfigurationError("Virtual Try-On requires a PNG/JPEG image with exactly one data or GCS uri.");
  if (image.uri !== undefined) {
    if (!gcs(image.uri)) throw new ConfigurationError("Virtual Try-On image URI must be a gs:// object path.");
    return { mimeType: image.mediaType, gcsUri: image.uri };
  }
  const bytes = encodeMediaFrame({ data: image.data!, mediaType: image.mediaType });
  if (!bytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(bytes)) throw new ConfigurationError("Virtual Try-On image data must be nonempty base64 or bytes.");
  decodeBase64WithLimit(bytes, { maxBytes: 7 * 1024 * 1024, provider: "vertex", endpoint: "virtual-try-on input" });
  return { mimeType: image.mediaType, bytesBase64Encoded: bytes };
};

export const createVertexVirtualTryOnClient = (
  model: PredictionModel, assertAccess: () => void, sanitize: (value: unknown) => unknown
): VertexVirtualTryOnClient => ({
  async generate(input) {
    assertAccess();
    const count = input.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new ConfigurationError("Virtual Try-On count must be 1-4.");
    if (input.prompt !== undefined && typeof input.prompt !== "string") throw new ConfigurationError("Virtual Try-On prompt must be text.");
    if (input.outputMimeType !== undefined && !["image/png", "image/jpeg"].includes(input.outputMimeType)) throw new ConfigurationError("Virtual Try-On output format must be PNG or JPEG.");
    if (input.outputStorageUri !== undefined && !/^gs:\/\/[^/\s?#]+(?:\/[^\s?#]*)?$/.test(input.outputStorageUri)) throw new ConfigurationError("Virtual Try-On outputStorageUri must be a gs:// path.");
    const parameters = { ...input.providerOptions };
    for (const key of ["sampleCount", "storageUri", "instances", "parameters", "action", "model"]) {
      if (parameters[key] !== undefined) throw new ConfigurationError(`Virtual Try-On providerOptions.${key} conflicts with the dedicated contract.`);
    }
    const output = parameters.outputOptions;
    if (output !== undefined && (!output || typeof output !== "object" || Array.isArray(output))) throw new ConfigurationError("Virtual Try-On outputOptions must be an object.");
    if (input.outputMimeType && output && output.mimeType !== undefined && output.mimeType !== input.outputMimeType) throw new ConfigurationError("Conflicting Virtual Try-On output MIME types.");
    if (parameters.seed !== undefined && parameters.addWatermark !== false) throw new ConfigurationError("Virtual Try-On seed requires addWatermark:false.");
    const result = await model.predictRaw({
      abortSignal: input.abortSignal, timeoutMs: input.timeoutMs, maxRetries: input.maxRetries, retryBackoffMs: input.retryBackoffMs,
      instances: [{ ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        personImage: { image: media(input.personImage) }, productImages: [{ image: media(input.productImage),
          ...(input.productMask ? { maskImage: media(input.productMask) } : {}),
          ...(input.productImageConfig ? { productImageConfig: input.productImageConfig } : {}) }] }],
      parameters: { ...parameters, sampleCount: count,
        ...(input.outputMimeType ? { outputOptions: { ...output, mimeType: input.outputMimeType } } : {}),
        ...(input.outputStorageUri ? { storageUri: input.outputStorageUri } : {}) }
    });
    if (!Array.isArray(result.predictions) || !result.predictions.length) throw new ConfigurationError("Virtual Try-On returned no predictions.");
    const images: ImageGenerationResult["images"] = [], filtered: VertexVirtualTryOnResult["filtered"] = [];
    // Both the guide's flat predictions and the REST result schema's images wrapper.
    const predictions = result.predictions.flatMap((p: any) => Array.isArray(p?.images) ? p.images : [p]);
    if (!predictions.length || predictions.length > count) throw new ConfigurationError("Virtual Try-On returned an invalid image count.");
    for (const prediction of predictions) {
      if (!prediction || [prediction.bytesBase64Encoded, prediction.gcsUri, prediction.raiFilteredReason].filter(v => v !== undefined).length !== 1) throw new ConfigurationError("Invalid Virtual Try-On image response.");
      if (prediction.raiFilteredReason !== undefined) {
        if (typeof prediction.raiFilteredReason !== "string" || !prediction.raiFilteredReason) throw new ConfigurationError("Invalid Virtual Try-On filtering reason.");
        filtered.push({ reason: prediction.raiFilteredReason }); continue;
      }
      if (!["image/png", "image/jpeg"].includes(prediction.mimeType)) throw new ConfigurationError("Invalid Virtual Try-On output MIME type.");
      if (prediction.gcsUri !== undefined && (typeof prediction.gcsUri !== "string" || !gcs(prediction.gcsUri))) throw new ConfigurationError("Invalid Virtual Try-On output URI.");
      if (prediction.bytesBase64Encoded !== undefined && (typeof prediction.bytesBase64Encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(prediction.bytesBase64Encoded))) throw new ConfigurationError("Invalid Virtual Try-On output bytes.");
      images.push({ mediaType: prediction.mimeType,
        ...(prediction.gcsUri ? { uri: prediction.gcsUri } : { data: decodeBase64WithLimit(prediction.bytesBase64Encoded, { maxBytes: 32 * 1024 * 1024, provider: "vertex", endpoint: "virtual-try-on output" }) }) });
    }
    return { images, filtered, rawResponse: sanitize(result.rawResponse) };
  }
});
