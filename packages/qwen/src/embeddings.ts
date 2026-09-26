import { ConfigurationError, ValidationError, readJsonWithLimit, withResponseRetry, withTimeoutSignal,
  type EmbedInput, type EmbedResult, type EmbeddingModel, type RetryOptions } from "@zhivex-ai/core/provider";
import { embeddingCapabilities } from "./capabilities.js";

/** DashScope extensions; dimensions also work through the compatible endpoint. */
export interface QwenEmbeddingOptions {
  dimensions?: number;
  text_type?: "query" | "document";
  instruct?: string;
  output_type?: "dense" | "sparse" | "dense&sparse";
}
export interface QwenSparseEmbedding { index: number; value: number; token?: string }
export interface QwenNativeEmbeddingResult {
  entries: Array<{ index: number; embedding?: number[]; sparseEmbedding?: QwenSparseEmbedding[] }>;
  usage: EmbedResult["usage"];
  rawResponse?: unknown;
}
export interface QwenTextEmbeddingModel extends EmbeddingModel {
  embedNative(input: { values: string[]; providerOptions?: QwenEmbeddingOptions } & RetryOptions): Promise<QwenNativeEmbeddingResult>;
}
const dimensions: Record<string, number[]> = {
  "qwen3.7-text-embedding": [256, 512, 768, 1024, 1536, 2048, 2560],
  "text-embedding-v4": [64, 128, 256, 512, 768, 1024, 1536, 2048],
  "text-embedding-v3": [512, 768, 1024]
};

export function createQwenTextEmbeddingModel(modelId: string, apiKey: string, baseURL: string,
  taskBaseURL: string, fetcher: typeof globalThis.fetch): QwenTextEmbeddingModel {
  const request = async (input: EmbedInput & RetryOptions, native: boolean): Promise<QwenNativeEmbeddingResult> => {
    const options = (input.providerOptions ?? {}) as QwenEmbeddingOptions;
    const allowed = new Set(["dimensions", "text_type", "instruct", "output_type"]);
    if (Object.keys(options).some(key => !allowed.has(key))) throw new ConfigurationError("Unknown Qwen embedding option.");
    if (!Array.isArray(input.values) || !input.values.length || input.values.some(v => typeof v !== "string" || !v.trim())) {
      throw new ConfigurationError("Qwen text embeddings require nonempty text inputs.");
    }
    const batchLimit = modelId === "qwen3.7-text-embedding" ? 20 : dimensions[modelId] ? 10 : undefined;
    if (batchLimit && input.values.length > batchLimit) throw new ConfigurationError(`Qwen ${modelId} accepts at most ${batchLimit} texts per request.`);
    if (options.dimensions !== undefined && (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1 ||
      dimensions[modelId] && !dimensions[modelId]!.includes(options.dimensions))) throw new ConfigurationError("Unsupported Qwen embedding dimensions.");
    if (options.text_type !== undefined && !["query", "document"].includes(options.text_type)) throw new ConfigurationError("Invalid embedding text_type.");
    if (options.output_type !== undefined && !["dense", "sparse", "dense&sparse"].includes(options.output_type)) throw new ConfigurationError("Invalid embedding output_type.");
    if (options.instruct !== undefined && (typeof options.instruct !== "string" || !options.instruct.trim() || options.text_type !== "query" || modelId === "text-embedding-v3")) {
      throw new ConfigurationError("Embedding instructions require text_type query and a model supporting instructions.");
    }
    if (!native && options.output_type === "sparse") throw new ConfigurationError("Use embedNative() for sparse-only embeddings.");
    const dashscope = native || options.text_type !== undefined || options.instruct !== undefined || options.output_type !== undefined;
    const { signal, cleanup, abort } = withTimeoutSignal({ ...input, timeoutMs: input.timeoutMs ?? 30000 });
    try {
      const response = await withResponseRetry(() => fetcher(dashscope
        ? `${taskBaseURL}/services/embeddings/text-embedding/text-embedding` : `${baseURL}/embeddings`, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(dashscope ? { model: modelId, input: { texts: input.values }, parameters: {
          dimension: options.dimensions, text_type: options.text_type, instruct: options.instruct, output_type: options.output_type
        } } : { model: modelId, input: input.values, ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }) })
      }), { ...input, abortSignal: signal }, "Qwen embeddings");
      const json = await readJsonWithLimit<any>(response, { maxBytes: 16 * 1024 * 1024, provider: "qwen", endpoint: "embeddings", abort });
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new ValidationError("Invalid Qwen embedding response.");
      const data = dashscope ? json.output?.embeddings : json.data;
      if (json.code || !Array.isArray(data) || data.length !== input.values.length) throw new ValidationError("Invalid Qwen embedding response.");
      const seen = new Set<number>();
      // Older compatible responses omit all indexes; preserve their array order.
      const unindexed = !dashscope && data.every((item: any) => item?.index === undefined);
      let denseLength: number | undefined;
      const entries = data.map((item: any, position: number) => {
        const index = dashscope ? item?.text_index : unindexed ? position : item?.index;
        if (!Number.isInteger(index) || index < 0 || index >= input.values.length || seen.has(index)) throw new ValidationError("Invalid Qwen embedding result index.");
        seen.add(index);
        const dense = item.embedding;
        const sparse = item.sparse_embedding;
        if ((options.output_type !== "sparse" || dense !== undefined) && (!Array.isArray(dense) || !dense.length || dense.some((v: unknown) => typeof v !== "number" || !Number.isFinite(v)) ||
          options.dimensions !== undefined && dense.length !== options.dimensions)) throw new ValidationError("Invalid Qwen dense embedding.");
        if (Array.isArray(dense)) {
          if (denseLength !== undefined && dense.length !== denseLength) throw new ValidationError("Inconsistent Qwen embedding dimensions.");
          denseLength = dense.length;
        }
        if ((options.output_type?.includes("sparse") || sparse !== undefined) && (!Array.isArray(sparse) || sparse.some((v: any) => !v || !Number.isSafeInteger(v.index) || v.index < 0 || typeof v.value !== "number" || !Number.isFinite(v.value) || v.token !== undefined && typeof v.token !== "string") || new Set(sparse.map((v: any) => v.index)).size !== sparse.length)) {
          throw new ValidationError("Invalid Qwen sparse embedding.");
        }
        return { index, ...(Array.isArray(dense) ? { embedding: dense as number[] } : {}),
          ...(Array.isArray(sparse) ? { sparseEmbedding: sparse as QwenSparseEmbedding[] } : {}) };
      }).sort((a, b) => a.index - b.index);
      for (const value of [json.usage?.prompt_tokens, json.usage?.total_tokens]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new ValidationError("Invalid Qwen embedding usage.");
      }
      return { entries, rawResponse: json, usage: { inputTokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens, totalTokens: json.usage?.total_tokens } };
    } finally { cleanup(); }
  };
  return {
    provider: "qwen", modelId, capabilities: embeddingCapabilities,
    async embed(input) {
      const result = await request(input, false);
      return { embeddings: result.entries.map(entry => entry.embedding!), usage: result.usage,
        rawResponse: result.rawResponse };
    },
    embedNative: input => request(input as EmbedInput & RetryOptions, true)
  };
}
