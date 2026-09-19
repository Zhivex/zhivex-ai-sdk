import { ConfigurationError, ProviderResponseTooLargeError, decodeBase64WithLimit, encodeMediaFrame, readBodyWithLimit, readJsonWithLimit, withRetry, withTimeoutSignal, type RetryOptions, type JsonValue } from "@zhivex-ai/core/provider";
import { assertVertexTensor, type VertexTensor } from "./tensors.js";

/** Arbitrary HTTP payload for a deployed Vertex endpoint, not a publisher model. */
export interface VertexEndpointRawPredictInput extends RetryOptions {
  endpoint: string;
  body: string | Uint8Array;
  contentType: string;
  /** Defaults to 16 MiB; applied before and during response consumption. */
  maxResponseBytes?: number;
}
export interface VertexEndpointRawPredictResult {
  body: Uint8Array;
  contentType?: string;
  status: number;
  endpointId?: string;
  deployedModelId?: string;
}
export interface VertexEndpointsClient {
  rawPredict(input: VertexEndpointRawPredictInput): Promise<VertexEndpointRawPredictResult>;
  streamRawPredict(input: VertexEndpointRawPredictInput): AsyncIterable<VertexEndpointStreamEvent>;
  directRawPredict(input: VertexEndpointDirectRawPredictInput): Promise<VertexEndpointDirectRawPredictResult>;
  explain(input: VertexEndpointExplainInput): Promise<VertexEndpointExplainResult>;
  directPredict(input: VertexEndpointDirectPredictInput): Promise<VertexEndpointDirectPredictResult>;
}
export interface VertexEndpointDirectPredictInput extends RetryOptions {
  endpoint: string;
  inputs: VertexTensor[];
  parameters?: VertexTensor;
  maxResponseBytes?: number;
}
export interface VertexEndpointDirectPredictResult {
  outputs: VertexTensor[];
  parameters?: VertexTensor;
}
export interface VertexEndpointExplainInput extends RetryOptions {
  endpoint: string;
  instances: JsonValue[];
  parameters?: JsonValue;
  deployedModelId?: string;
  explanationSpecOverride?: {
    parameters?: Record<string, JsonValue>;
    metadata?: Record<string, JsonValue>;
    examplesOverride?: Record<string, JsonValue>;
  };
  /** Maximum response JSON size; defaults to 16 MiB. */
  maxResponseBytes?: number;
}
export interface VertexEndpointExplainResult {
  /** Native attribution or example-based explanations, in instance order. */
  explanations: Record<string, JsonValue>[];
  predictions: JsonValue[];
  deployedModelId?: string;
}
export interface VertexEndpointDirectRawPredictInput extends RetryOptions {
  endpoint: string;
  /** Fully qualified gRPC method, e.g. /tensorflow.serving.PredictionService/Predict. */
  methodName: string;
  /** Serialized request message for the container's gRPC method. */
  input: Uint8Array;
  /** Maximum decoded output size; defaults to 16 MiB. */
  maxResponseBytes?: number;
}
export interface VertexEndpointDirectRawPredictResult {
  output: Uint8Array;
  status: number;
}
type EndpointAction = "rawPredict" | "streamRawPredict" | "directRawPredict" | "explain" | "directPredict";
export type VertexEndpointStreamEvent =
  | ({ type: "response" } & Omit<VertexEndpointRawPredictResult, "body">)
  | { type: "chunk"; data: Uint8Array };

const responseMetadata = (response: Response): Omit<VertexEndpointRawPredictResult, "body"> => ({
  status: response.status,
  ...(response.headers.has("content-type") ? { contentType: response.headers.get("content-type")! } : {}),
  ...(response.headers.has("x-vertex-ai-endpoint-id") ? { endpointId: response.headers.get("x-vertex-ai-endpoint-id")! } : {}),
  ...(response.headers.has("x-vertex-ai-deployed-model-id") ? { deployedModelId: response.headers.get("x-vertex-ai-deployed-model-id")! } : {})
});

export const createVertexEndpointsClient = (
  fetcher: typeof globalThis.fetch,
  resolveURL: (endpoint: string, action: EndpointAction) => string,
  assertAccess: () => void,
  parseError: (response: Response) => Promise<unknown>
): VertexEndpointsClient => {
  const prepare = (input: VertexEndpointRawPredictInput, action: EndpointAction) => {
    assertAccess();
    const url = resolveURL(input.endpoint, action);
    if (typeof input.body !== "string" && !(input.body instanceof Uint8Array)) throw new ConfigurationError("Vertex endpoint body must be text or Uint8Array.");
    if (typeof input.contentType !== "string" || !input.contentType.trim() || /[\r\n]/.test(input.contentType)) throw new ConfigurationError("Vertex endpoint contentType must be a nonempty HTTP content type.");
    const headers = new Headers({ "content-type": input.contentType });
    const maxBytes = input.maxResponseBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new ConfigurationError("Vertex endpoint maxResponseBytes must be a positive safe integer.");
    // Copy caller-owned bytes once so retries send the same payload.
    const body = typeof input.body === "string" ? input.body : new Uint8Array(input.body).buffer;
    return { url, headers, body, maxBytes };
  };
  const request = (input: RetryOptions, prepared: ReturnType<typeof prepare>, signal?: AbortSignal) => withRetry(async () => {
    const response = await fetcher(prepared.url, { method: "POST", redirect: "error", headers: prepared.headers, body: prepared.body, signal });
    if (!response.ok) await parseError(response);
    return response;
  }, { ...input, abortSignal: signal });
  return {
  async directPredict(input) {
    if (!Array.isArray(input.inputs)) throw new ConfigurationError("Vertex directPredict inputs must be a tensor array.");
    input.inputs.forEach(value => assertVertexTensor(value));
    if (input.parameters !== undefined) assertVertexTensor(input.parameters);
    const prepared = prepare({ ...input, body: JSON.stringify({ inputs: input.inputs, ...(input.parameters !== undefined ? { parameters: input.parameters } : {}) }), contentType: "application/json" }, "directPredict");
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await request(input, prepared, signal);
      const json = await readJsonWithLimit<VertexEndpointDirectPredictResult>(response, { maxBytes: prepared.maxBytes, provider: "vertex", endpoint: "endpoints.directPredict" });
      if (!json || typeof json !== "object" || Array.isArray(json) || (json.outputs !== undefined && !Array.isArray(json.outputs))) throw new ConfigurationError("Vertex directPredict returned an invalid response.");
      const outputs = json.outputs ?? [];
      outputs.forEach(value => assertVertexTensor(value));
      if (json.parameters !== undefined) assertVertexTensor(json.parameters);
      return { outputs, ...(json.parameters !== undefined ? { parameters: json.parameters } : {}) };
    } finally { cleanup(); }
  },
  async explain(input) {
    if (!Array.isArray(input.instances) || !input.instances.length) throw new ConfigurationError("Vertex explain requires a nonempty instances array.");
    const instanceCount = input.instances.length;
    if (input.deployedModelId !== undefined && (typeof input.deployedModelId !== "string" || !input.deployedModelId.trim())) throw new ConfigurationError("Vertex explain deployedModelId must be a nonempty string.");
    if (input.explanationSpecOverride !== undefined && (!input.explanationSpecOverride || typeof input.explanationSpecOverride !== "object" || Array.isArray(input.explanationSpecOverride))) throw new ConfigurationError("Vertex explain explanationSpecOverride must be an object.");
    const prepared = prepare({ ...input, contentType: "application/json", body: JSON.stringify({
      instances: input.instances,
      ...(input.parameters !== undefined ? { parameters: input.parameters } : {}),
      ...(input.deployedModelId !== undefined ? { deployedModelId: input.deployedModelId } : {}),
      ...(input.explanationSpecOverride !== undefined ? { explanationSpecOverride: input.explanationSpecOverride } : {})
    }) }, "explain");
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await request(input, prepared, signal);
      const json = await readJsonWithLimit<VertexEndpointExplainResult>(response, { maxBytes: prepared.maxBytes, provider: "vertex", endpoint: "endpoints.explain" });
      if (!json || !Array.isArray(json.explanations) || json.explanations.length !== instanceCount || json.explanations.some(value => !value || typeof value !== "object" || Array.isArray(value)) || !Array.isArray(json.predictions) || (json.deployedModelId !== undefined && typeof json.deployedModelId !== "string")) throw new ConfigurationError("Vertex explain returned an invalid response or explanation count.");
      return { explanations: json.explanations, predictions: json.predictions, ...(json.deployedModelId !== undefined ? { deployedModelId: json.deployedModelId } : {}) };
    } finally { cleanup(); }
  },
  async directRawPredict(input) {
    if (typeof input.methodName !== "string" || !/^\/[^/\s?#]+\/[^/\s?#]+\/?$/.test(input.methodName)) throw new ConfigurationError("Vertex directRawPredict methodName must use /namespace.Service/Method.");
    if (!(input.input instanceof Uint8Array)) throw new ConfigurationError("Vertex directRawPredict input must be Uint8Array.");
    const prepared = prepare({ ...input, body: JSON.stringify({ methodName: input.methodName, input: encodeMediaFrame({ data: input.input, mediaType: "application/octet-stream" }) }), contentType: "application/json" }, "directRawPredict");
    const jsonLimit = Math.ceil(prepared.maxBytes / 3) * 4 + 64 * 1024;
    if (!Number.isSafeInteger(jsonLimit)) throw new ConfigurationError("Vertex directRawPredict response limit is too large.");
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await request(input, prepared, signal);
      const json = await readJsonWithLimit<{ output?: unknown }>(response, { maxBytes: jsonLimit, provider: "vertex", endpoint: "endpoints.directRawPredict" });
      if (!json || Array.isArray(json) || typeof json !== "object" || (json.output !== undefined && typeof json.output !== "string")) throw new ConfigurationError("Vertex directRawPredict returned an invalid output envelope.");
      // ProtoJSON can omit a bytes field containing its empty default value.
      return { output: json.output ? decodeBase64WithLimit(json.output, { maxBytes: prepared.maxBytes, provider: "vertex", endpoint: "endpoints.directRawPredict" }) : new Uint8Array(), status: response.status };
    } finally { cleanup(); }
  },
  async rawPredict(input) {
    const prepared = prepare(input, "rawPredict");
    const { signal, cleanup } = withTimeoutSignal(input);
    try {
      const response = await request(input, prepared, signal);
      const bytes = await readBodyWithLimit(response, { maxBytes: prepared.maxBytes, provider: "vertex", endpoint: "endpoints.rawPredict" });
      return { body: bytes, ...responseMetadata(response) };
    } finally { cleanup(); }
  },
  async *streamRawPredict(input) {
    const prepared = prepare(input, "streamRawPredict");
    const { signal, cleanup } = withTimeoutSignal(input);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel(signal?.reason).catch(() => {}); };
    try {
      const response = await request(input, prepared, signal);
      reader = response.body?.getReader();
      signal?.addEventListener("abort", cancel, { once: true });
      signal?.throwIfAborted();
      const contentLength = Number(response.headers.get("content-length"));
      const tooLarge = (receivedBytes: number) => new ProviderResponseTooLargeError({ maxBytes: prepared.maxBytes, receivedBytes, provider: "vertex", endpoint: "endpoints.streamRawPredict" });
      if (Number.isFinite(contentLength) && contentLength > prepared.maxBytes) throw tooLarge(contentLength);
      yield { type: "response", ...responseMetadata(response) };
      let receivedBytes = 0;
      while (reader) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > prepared.maxBytes) throw tooLarge(receivedBytes);
        yield { type: "chunk", data: value };
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      cleanup();
    }
  }
  };
};
