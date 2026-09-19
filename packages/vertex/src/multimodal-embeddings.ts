import {
  ConfigurationError, ProviderHTTPError, UnsupportedFeatureError, encodeMediaFrame,
  readErrorBodyWithLimit, readJsonWithLimit, withRetry, withTimeoutSignal,
  type EmbeddingModel, type EmbedInput, type EmbedResult, type MediaInput, type RetryOptions
} from "@zhivex-ai/core/provider";

export interface VertexVideoSegmentConfig {
  startOffsetSec?: number;
  endOffsetSec?: number;
  intervalSec?: number;
}
export interface VertexMultimodalEmbeddingInput extends RetryOptions {
  text?: string;
  image?: MediaInput;
  video?: MediaInput;
  videoSegmentConfig?: VertexVideoSegmentConfig;
  /** Text/image-only requests. Requests containing video use the default 1408 dimensions. */
  outputDimensionality?: 128 | 256 | 512 | 1408;
}
export interface VertexMultimodalEmbeddingResult {
  textEmbedding?: number[];
  imageEmbedding?: number[];
  videoEmbeddings?: Array<{ startOffsetSec: number; endOffsetSec: number; embedding: number[] }>;
  rawResponse: unknown;
}
export interface VertexMultimodalEmbeddingClient {
  embed(input: VertexMultimodalEmbeddingInput): Promise<VertexMultimodalEmbeddingResult>;
}

const dimensions = new Set([128, 256, 512, 1408]);
const media = (input: MediaInput, kind: "image" | "video") => {
  if (!input || (input.data === undefined) === (input.uri === undefined)) throw new ConfigurationError(`Vertex ${kind} requires exactly one of data or uri.`);
  if (typeof input.mediaType !== "string" || !input.mediaType.startsWith(`${kind}/`)) throw new ConfigurationError(`Vertex ${kind} requires a ${kind} MIME type.`);
  if (kind === "image" && !["image/png", "image/jpeg"].includes(input.mediaType)) throw new UnsupportedFeatureError("Vertex multimodal embeddings accept JPEG or PNG images.");
  if (input.providerMetadata && Object.keys(input.providerMetadata).length) throw new UnsupportedFeatureError("Use videoSegmentConfig rather than media providerMetadata for legacy multimodal embeddings.");
  if (input.uri !== undefined && !/^gs:\/\/[^/]+\/.+/.test(input.uri)) throw new ConfigurationError("Legacy multimodal embedding media requires a gs:// object URI.");
  return {
    ...(input.uri !== undefined ? { gcsUri: input.uri } : { bytesBase64Encoded: encodeMediaFrame({ data: input.data!, mediaType: input.mediaType }) }),
    ...(kind === "image" ? { mimeType: input.mediaType } : {})
  };
};
const prepare = (input: VertexMultimodalEmbeddingInput) => {
  if (input.text === undefined && input.image === undefined && input.video === undefined) throw new ConfigurationError("Vertex multimodal embeddings require text, image or video.");
  if (input.text !== undefined && (typeof input.text !== "string" || !input.text.trim())) throw new ConfigurationError("Vertex multimodal embedding text must be non-empty.");
  if (input.outputDimensionality !== undefined && !dimensions.has(input.outputDimensionality)) throw new ConfigurationError("Vertex multimodal embedding dimensions must be 128, 256, 512 or 1408.");
  if (input.outputDimensionality !== undefined && input.video !== undefined) throw new UnsupportedFeatureError("Requests containing video use 1408 dimensions; outputDimensionality requires text/image-only input.");
  if (input.videoSegmentConfig !== undefined) {
    if (!input.video) throw new ConfigurationError("videoSegmentConfig requires video input.");
    const config = input.videoSegmentConfig;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new ConfigurationError("videoSegmentConfig must be an object.");
    for (const [key, value] of Object.entries(config)) {
      if (!["startOffsetSec", "endOffsetSec", "intervalSec"].includes(key)) throw new ConfigurationError(`Unknown video segment option ${key}.`);
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === "intervalSec" ? 4 : 0))) throw new ConfigurationError("Video offsets must be nonnegative integers and intervalSec must be at least 4.");
    }
    if (config.endOffsetSec !== undefined && config.endOffsetSec <= (config.startOffsetSec ?? 0)) throw new ConfigurationError("Video endOffsetSec must be greater than startOffsetSec.");
  }
  return { instances: [{ ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.image !== undefined ? { image: media(input.image, "image") } : {}),
    ...(input.video !== undefined ? { video: { ...media(input.video, "video"), ...(input.videoSegmentConfig ? { videoSegmentConfig: input.videoSegmentConfig } : {}) } } : {}) }],
    ...(input.outputDimensionality !== undefined ? { parameters: { dimension: input.outputDimensionality } } : {}) };
};
const vector = (value: unknown, size: number): number[] => {
  if (!Array.isArray(value) || value.length !== size || !value.every(n => typeof n === "number" && Number.isFinite(n))) throw new ConfigurationError("Vertex returned an invalid multimodal embedding vector.");
  return value;
};

export class VertexLegacyMultimodalEmbeddingModel implements EmbeddingModel {
  readonly provider = "vertex";
  readonly modelId = "multimodalembedding@001";
  readonly capabilities = { streaming: false, tools: false, structuredOutput: false, jsonMode: false,
    toolChoice: false, parallelToolCalls: false, vision: true, files: false, audioInput: false,
    audioOutput: false, embeddings: true, reasoning: false, webSearch: false };
  constructor(private readonly baseURL: string, private readonly fetcher: typeof globalThis.fetch, private readonly assertAccess: () => void) {}

  async embedMultimodal(input: VertexMultimodalEmbeddingInput): Promise<VertexMultimodalEmbeddingResult> {
    this.assertAccess();
    const body = prepare(input);
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(async () => {
        const response = await this.fetcher(`${this.baseURL}/publishers/google/models/multimodalembedding@001:predict`, {
          method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal, body: JSON.stringify(body)
        });
        if (!response.ok) throw new ProviderHTTPError(`Vertex multimodal embeddings failed with status ${response.status}.`, response.status, { responseBody: await readErrorBodyWithLimit(response) });
        return response;
      }, { ...input, abortSignal: signal });
      const raw: any = await readJsonWithLimit(response, { maxBytes: 128 * 1024 * 1024 });
      if (!Array.isArray(raw?.predictions) || raw.predictions.length !== 1 || !raw.predictions[0]) throw new ConfigurationError("Vertex multimodal embeddings require exactly one prediction.");
      const prediction = raw.predictions[0];
      const result: VertexMultimodalEmbeddingResult = { rawResponse: raw };
      const size = input.outputDimensionality ?? 1408;
      if (input.text !== undefined) result.textEmbedding = vector(prediction.textEmbedding, size);
      if (input.image !== undefined) result.imageEmbedding = vector(prediction.imageEmbedding, size);
      if (input.video !== undefined) {
        if (!Array.isArray(prediction.videoEmbeddings) || !prediction.videoEmbeddings.length) throw new ConfigurationError("Vertex returned no video embedding segments.");
        let previousEnd = -1;
        result.videoEmbeddings = prediction.videoEmbeddings.map((segment: any) => {
          if (!segment || !Number.isFinite(segment.startOffsetSec) || !Number.isFinite(segment.endOffsetSec) || segment.startOffsetSec < 0 || segment.startOffsetSec < previousEnd || segment.endOffsetSec <= segment.startOffsetSec) throw new ConfigurationError("Vertex returned invalid video segment offsets.");
          previousEnd = segment.endOffsetSec;
          return { startOffsetSec: segment.startOffsetSec, endOffsetSec: segment.endOffsetSec, embedding: vector(segment.embedding, 1408) };
        });
      }
      return result;
    } finally { cleanup(); }
  }

  async embed(input: EmbedInput & RetryOptions): Promise<EmbedResult> {
    const options = input.providerOptions ?? {};
    for (const key of Object.keys(options)) if (key !== "outputDimensionality") throw new UnsupportedFeatureError(`Legacy multimodal embeddings do not expose providerOptions.${key}.`);
    // Validate the complete batch before starting requests. Each value maps to one vector.
    const requests = input.values.map(value => {
      if (typeof value !== "string" && value?.mediaType?.startsWith("video/")) throw new UnsupportedFeatureError("Use vertex.multimodalEmbeddings.embed({ video }) to retain all video segments and timestamps.");
      const request = { ...(typeof value === "string" ? { text: value } : { image: value }), outputDimensionality: options.outputDimensionality as VertexMultimodalEmbeddingInput["outputDimensionality"] };
      prepare(request);
      return request;
    });
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const embeddings: number[][] = [], rawResponse: unknown[] = [];
      for (const request of requests) {
        const result = await this.embedMultimodal({ ...input, ...request, abortSignal: signal });
        embeddings.push(result.textEmbedding ?? result.imageEmbedding!);
        rawResponse.push(result.rawResponse);
      }
      return { embeddings, rawResponse };
    } finally { cleanup(); }
  }
}
