import {
  ConfigurationError, ProviderHTTPError, UnsupportedFeatureError,
  encodeMediaFrame, readErrorBodyWithLimit, readJsonWithLimit, withRetry, withTimeoutSignal,
  type EmbeddingModel, type EmbedInput, type EmbedResult, type ModelCapabilities, type RetryOptions
} from "@zhivex-ai/core/provider";

export interface VertexEmbeddingOptions {
  outputDimensionality?: number;
  autoTruncate?: boolean;
  taskType?: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY" | "CLASSIFICATION" | "CLUSTERING" | "QUESTION_ANSWERING" | "FACT_VERIFICATION" | "CODE_RETRIEVAL_QUERY";
  title?: string;
  documentOcr?: boolean;
  audioTrackExtraction?: boolean;
  [key: string]: unknown;
}

const embeddingCapabilities: ModelCapabilities = {
    streaming: false, tools: false, structuredOutput: false, jsonMode: false,
    toolChoice: false, parallelToolCalls: false, vision: false, files: false,
    audioInput: false, audioOutput: false, embeddings: true, reasoning: false, webSearch: false
  };

/** OpenMaaS embeddings use the OpenAI-compatible endpoint, not Google predict. */
export class VertexOpenEmbeddingModel implements EmbeddingModel {
  readonly provider = "vertex";
  readonly capabilities = { ...embeddingCapabilities };
  constructor(readonly modelId: string, private readonly baseURL: string, private readonly fetcher: typeof globalThis.fetch) {}

  async embed(input: EmbedInput & RetryOptions): Promise<EmbedResult> {
    if (Object.keys(input.providerOptions ?? {}).length) throw new UnsupportedFeatureError("Vertex E5 embeddings do not expose Google embedding controls or configurable dimensions.");
    if (input.values.some((value) => typeof value !== "string")) throw new UnsupportedFeatureError("Vertex E5 embeddings require text values.");
    if (!input.values.length) return { embeddings: [], rawResponse: [] };
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await withRetry(async () => {
        const result = await this.fetcher(`${this.baseURL}/endpoints/openapi/embeddings`, {
          method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal,
          body: JSON.stringify({ model: this.modelId, input: input.values, encoding_format: "float" })
        });
        if (!result.ok) throw new ProviderHTTPError(`Vertex E5 embeddings failed with status ${result.status}.`, result.status, { responseBody: await readErrorBodyWithLimit(result) });
        return result;
      }, { ...input, abortSignal: signal });
      const json: any = await readJsonWithLimit(response, { maxBytes: 128 * 1024 * 1024 });
      if (!Array.isArray(json.data) || json.data.length !== input.values.length) throw new ConfigurationError("Vertex E5 returned a different number of embedding vectors than input values.");
      const indexed = new Map<number, number[]>();
      let dimensions: number | undefined;
      for (const item of json.data) {
        if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= input.values.length || indexed.has(item.index)) throw new ConfigurationError("Vertex E5 returned invalid or duplicate embedding indices.");
        const embedding = vector(item.embedding, dimensions);
        dimensions ??= embedding.length;
        indexed.set(item.index, embedding);
      }
      const tokens = json.usage?.prompt_tokens;
      if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new ConfigurationError("Vertex E5 returned invalid token usage.");
      return { embeddings: input.values.map((_, index) => indexed.get(index)!), rawResponse: json,
        ...(tokens !== undefined ? { usage: { inputTokens: tokens } } : {}) };
    } finally { cleanup(); }
  }
}

const tasks = new Set(["RETRIEVAL_QUERY", "RETRIEVAL_DOCUMENT", "SEMANTIC_SIMILARITY", "CLASSIFICATION", "CLUSTERING", "QUESTION_ANSWERING", "FACT_VERIFICATION", "CODE_RETRIEVAL_QUERY"]);
const fields = new Set(["outputDimensionality", "autoTruncate", "taskType", "title", "documentOcr", "audioTrackExtraction"]);
const vector = (value: unknown, dimensions?: number): number[] => {
  if (!Array.isArray(value) || !value.length || !value.every((n) => typeof n === "number" && Number.isFinite(n))) throw new ConfigurationError("Vertex returned an invalid embedding vector.");
  if (dimensions !== undefined && value.length !== dimensions) throw new ConfigurationError("Vertex returned inconsistent embedding dimensions.");
  return value;
};

export class VertexEmbeddingModel implements EmbeddingModel {
  readonly provider = "vertex";
  readonly capabilities: ModelCapabilities;
  constructor(readonly modelId: string, private readonly baseURL: string, private readonly fetcher: typeof globalThis.fetch) {
    const multimodal = /^gemini-embedding-2(?:-|$)/.test(modelId);
    this.capabilities = { ...embeddingCapabilities, vision: multimodal, files: multimodal, audioInput: multimodal };
  }

  async embed(input: EmbedInput & RetryOptions): Promise<EmbedResult> {
    const config = { ...(input.providerOptions ?? {}) } as VertexEmbeddingOptions;
    for (const key of Object.keys(config)) if (!fields.has(key)) throw new UnsupportedFeatureError(`Vertex embeddings do not expose providerOptions.${key}.`);
    if (config.outputDimensionality !== undefined && (!Number.isInteger(config.outputDimensionality) || config.outputDimensionality <= 0)) throw new ConfigurationError("Embedding outputDimensionality must be a positive integer.");
    for (const key of ["autoTruncate", "documentOcr", "audioTrackExtraction"] as const) if (config[key] !== undefined && typeof config[key] !== "boolean") throw new ConfigurationError(`Embedding ${key} must be a boolean.`);
    if (config.taskType !== undefined && !tasks.has(config.taskType)) throw new ConfigurationError("Invalid Vertex embedding taskType.");
    if (config.title !== undefined && (typeof config.title !== "string" || config.taskType !== "RETRIEVAL_DOCUMENT")) throw new ConfigurationError("Embedding title requires taskType RETRIEVAL_DOCUMENT.");
    const multimodal = /^gemini-embedding-2(?:-|$)/.test(this.modelId);
    if (multimodal && (config.taskType !== undefined || config.title !== undefined || config.autoTruncate !== undefined)) throw new UnsupportedFeatureError("Gemini Embedding 2 does not expose text-only taskType, title or autoTruncate controls.");
    if (!multimodal && (config.documentOcr !== undefined || config.audioTrackExtraction !== undefined)) throw new UnsupportedFeatureError("OCR and audio track extraction require Gemini Embedding 2.");
    const values = input.values.map((value) => {
      if (typeof value === "string") return multimodal ? { text: value } : { content: value,
        ...(config.taskType ? { task_type: config.taskType } : {}), ...(config.title !== undefined ? { title: config.title } : {}) };
      if (!multimodal) throw new UnsupportedFeatureError(`Vertex model "${this.modelId}" only supports text embedding values; use gemini-embedding-2 for media.`);
      if (!value || !value.mediaType || (value.uri === undefined && value.data === undefined) || (value.uri !== undefined && value.data !== undefined)) throw new ConfigurationError("Embedding media requires mediaType and exactly one of data or uri.");
      if (value.uri !== undefined && !/^(?:gs|https):\/\//.test(value.uri)) throw new ConfigurationError("Embedding media URI must use gs:// or https://.");
      const part = value.uri ? { fileData: { fileUri: value.uri, mimeType: value.mediaType } }
        : { inlineData: { mimeType: value.mediaType, data: encodeMediaFrame({ data: value.data!, mediaType: value.mediaType }) } };
      return { ...part, ...(value.providerMetadata?.videoMetadata ? { videoMetadata: value.providerMetadata.videoMetadata } : {}) };
    });
    if (!values.length) return { embeddings: [], rawResponse: [] };
    const { signal, cleanup } = withTimeoutSignal(input);
    const raw: any[] = [];
    const embeddings: number[][] = [];
    let dimensions = config.outputDimensionality;
    try {
      // Gemini embedding-001 accepts only one text per predict request.
      const batchSize = multimodal || /^gemini-embedding-001(?:-|$)/.test(this.modelId) ? 1 : 5;
      for (let offset = 0; offset < values.length; offset += batchSize) {
        const chunk = values.slice(offset, offset + batchSize);
        const parameters = { ...(config.outputDimensionality !== undefined ? { outputDimensionality: config.outputDimensionality } : {}), ...(config.autoTruncate !== undefined ? { autoTruncate: config.autoTruncate } : {}) };
        const body = multimodal ? { content: { parts: chunk }, ...(Object.keys(config).length ? { embedContentConfig: config } : {}) }
          : { instances: chunk, ...(Object.keys(parameters).length ? { parameters } : {}) };
        const response = await withRetry(async () => {
          const result = await this.fetcher(`${this.baseURL}/publishers/google/models/${encodeURIComponent(this.modelId)}:${multimodal ? "embedContent" : "predict"}`, {
            method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal, body: JSON.stringify(body)
          });
          if (!result.ok) throw new ProviderHTTPError(`Vertex embeddings failed with status ${result.status}.`, result.status, { responseBody: await readErrorBodyWithLimit(result) });
          return result;
        }, { ...input, abortSignal: signal });
        const json: any = await readJsonWithLimit(response, { maxBytes: 128 * 1024 * 1024 });
        const readVector = (value: unknown) => {
          const embedding = vector(value, dimensions);
          dimensions ??= embedding.length;
          return embedding;
        };
        const vectors = multimodal ? [readVector(json.embedding?.values)] : (json.predictions ?? []).map((prediction: any) => readVector(prediction.embeddings?.values));
        if (vectors.length !== chunk.length) throw new ConfigurationError("Vertex returned a different number of embedding vectors than input values.");
        embeddings.push(...vectors);
        raw.push(json);
      }
      const tokenCounts = raw.flatMap((json) => json.usageMetadata?.promptTokenCount !== undefined ? [json.usageMetadata.promptTokenCount]
        : (json.predictions ?? []).flatMap((p: any) => p.embeddings?.statistics?.token_count === undefined ? [] : [p.embeddings.statistics.token_count]));
      let inputTokens = 0;
      for (const count of tokenCounts) {
        if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(inputTokens + count)) {
          throw new ConfigurationError("Vertex returned invalid embedding token usage.");
        }
        inputTokens += count;
      }
      return { embeddings, rawResponse: raw.length === 1 ? raw[0] : raw,
        ...(tokenCounts.length ? { usage: { inputTokens } } : {}) };
    } finally { cleanup(); }
  }
}
