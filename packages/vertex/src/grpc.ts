import { once } from "node:events";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { ConfigurationError, ProviderResponseTooLargeError, withTimeoutSignal, type RetryOptions } from "@zhivex-ai/core/provider";
import { assertVertexTensor, type VertexTensor } from "./tensors.js";

interface GrpcInput extends RetryOptions {
  endpoint: string;
  maxResponseBytes?: number;
}
export interface VertexGrpcRawInput extends GrpcInput {
  methodName: string;
  inputs: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}
export interface VertexGrpcTensorFrame {
  inputs: VertexTensor[];
  parameters?: VertexTensor;
}
export interface VertexGrpcTensorInput extends GrpcInput {
  inputs: AsyncIterable<VertexGrpcTensorFrame> | Iterable<VertexGrpcTensorFrame>;
}
export interface VertexGrpcServerInput extends GrpcInput, VertexGrpcTensorFrame {}
export interface VertexGrpcTensorOutput {
  outputs: VertexTensor[];
  parameters?: VertexTensor;
}
type StreamingMethod = "serverStreamingPredict" | "streamDirectRawPredict" | "streamDirectPredict" | "streamingRawPredict" | "streamingPredict";
export interface VertexGrpcClient {
  serverStreamingPredict(input: VertexGrpcServerInput): AsyncIterable<VertexGrpcTensorOutput>;
  streamingRawPredict(input: VertexGrpcRawInput): AsyncIterable<Uint8Array>;
  streamingPredict(input: VertexGrpcTensorInput): AsyncIterable<VertexGrpcTensorOutput>;
  streamDirectRawPredict(input: VertexGrpcRawInput): AsyncIterable<Uint8Array>;
  streamDirectPredict(input: VertexGrpcTensorInput): AsyncIterable<VertexGrpcTensorOutput>;
}

const abortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  let cancel!: () => void;
  const abort = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true }); });
  try { return await Promise.race([promise, abort]); }
  finally { signal.removeEventListener("abort", cancel); }
};

export const createVertexGrpcClient = (
  baseURL: string,
  resolveEndpoint: (endpoint: string, allowPublisher: boolean) => string,
  getToken: (signal: AbortSignal) => Promise<string>
): VertexGrpcClient => {
  async function* run(input: VertexGrpcRawInput | VertexGrpcTensorInput | VertexGrpcServerInput, method: StreamingMethod): AsyncGenerator<Uint8Array | VertexGrpcTensorOutput> {
    const raw = method === "streamDirectRawPredict" || method === "streamingRawPredict";
    if (input.maxRetries !== undefined && input.maxRetries !== 0) throw new ConfigurationError("Vertex gRPC streams cannot be replayed; maxRetries must be 0.");
    const endpoint = resolveEndpoint(input.endpoint, method === "serverStreamingPredict");
    const maxBytes = input.maxResponseBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 2147483647) throw new ConfigurationError("Vertex gRPC maxResponseBytes must be a positive int32.");
    if (raw && !/^\/[^/\s?#]+\/[^/\s?#]+\/?$/.test((input as VertexGrpcRawInput).methodName)) throw new ConfigurationError("Vertex gRPC methodName must use /namespace.Service/Method.");
    if (!input.inputs || (!(Symbol.asyncIterator in Object(input.inputs)) && !(Symbol.iterator in Object(input.inputs)))) throw new ConfigurationError("Vertex gRPC inputs must be iterable.");
    if (method === "serverStreamingPredict") {
      const request = input as VertexGrpcServerInput;
      if (!Array.isArray(request.inputs)) throw new ConfigurationError("Vertex serverStreamingPredict requires a tensor array.");
      request.inputs.forEach(value => assertVertexTensor(value));
      if (request.parameters !== undefined) assertVertexTensor(request.parameters);
    }
    const stop = new AbortController();
    const timing = withTimeoutSignal(input);
    const signal = timing.signal ? AbortSignal.any([stop.signal, timing.signal]) : stop.signal;
    let client: import("@google-cloud/aiplatform").v1.PredictionServiceClient | import("@google-cloud/aiplatform").v1beta1.PredictionServiceClient | undefined;
    let stream: ReturnType<NonNullable<typeof client>["streamDirectRawPredict"]> | undefined;
    let iterator: AsyncIterator<unknown> | Iterator<unknown> | undefined;
    let pump: Promise<void> | undefined;
    let pumpError: unknown;
    const cancel = () => { stream?.destroy(signal.reason instanceof Error ? signal.reason : new Error("Vertex gRPC stream aborted.")); };
    try {
      const token = await getToken(signal);
      const sdk = await abortable(import("@google-cloud/aiplatform"), signal);
      const url = new URL(baseURL);
      const api = url.pathname.startsWith("/v1beta1/") ? sdk.v1beta1 : sdk.v1;
      const proto = url.pathname.startsWith("/v1beta1/") ? sdk.protos.google.cloud.aiplatform.v1beta1 : sdk.protos.google.cloud.aiplatform.v1;
      const oauth = new OAuth2Client(); oauth.setCredentials({ access_token: token });
      client = new api.PredictionServiceClient({ apiEndpoint: url.hostname, ...(url.port ? { port: Number(url.port) } : {}), projectId: endpoint.split("/")[1], auth: new GoogleAuth({ projectId: endpoint.split("/")[1], authClient: oauth }), "grpc.max_receive_message_length": maxBytes });
      const callOptions = { ...(input.timeoutMs !== undefined ? { timeout: input.timeoutMs } : {}), retry: null };
      const encodeFrame = (frame: VertexGrpcTensorFrame) => {
        if (!frame || !Array.isArray(frame.inputs)) throw new ConfigurationError("Vertex gRPC tensor frames require inputs.");
        frame.inputs.forEach(value => assertVertexTensor(value));
        if (frame.parameters !== undefined) assertVertexTensor(frame.parameters);
        return { inputs: frame.inputs.map(value => proto.Tensor.fromObject(value)), ...(frame.parameters !== undefined ? { parameters: proto.Tensor.fromObject(frame.parameters) } : {}) };
      };
      stream = method === "serverStreamingPredict"
        ? client.serverStreamingPredict({ endpoint, ...encodeFrame(input as VertexGrpcServerInput) }, callOptions)
        : client[method](callOptions);
      stream.on("error", () => {}); // Iterator/pump report failures; cancellation must not be unhandled.
      signal.addEventListener("abort", cancel, { once: true });
      signal.throwIfAborted();
      if (method !== "serverStreamingPredict") {
        const source = input.inputs as AsyncIterable<unknown> & Iterable<unknown>;
        iterator = source[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]();
        const write = async (message: object) => {
          signal.throwIfAborted();
          if (!stream!.write(message)) await once(stream!, "drain", { signal });
        };
        pump = (async () => {
          await write({ endpoint, ...(raw ? { methodName: (input as VertexGrpcRawInput).methodName } : {}) });
          let sentFrames = 0;
          while (true) {
            const next = await abortable(Promise.resolve(iterator!.next()), signal);
            if (next.done) break;
            if (raw) {
              if (!(next.value instanceof Uint8Array)) throw new ConfigurationError("Vertex gRPC raw input must contain Uint8Array frames.");
              await write({ input: Buffer.from(next.value) });
            } else {
              const frame = next.value as VertexGrpcTensorFrame;
              await write(encodeFrame(frame));
            }
            // Immediately resolved iterators/writes can otherwise monopolize the
            // microtask queue, starving gRPC reads, abort events and deadlines.
            if (++sentFrames % 16 === 0) await yieldToIO(undefined, { signal });
          }
          stream!.end();
        })().catch(error => { pumpError = error; stream!.destroy(error instanceof Error ? error : new Error("Vertex gRPC input failed.")); });
      }
      let receivedBytes = 0;
      for await (const message of stream) {
        signal.throwIfAborted();
        let result: Uint8Array | VertexGrpcTensorOutput;
        if (raw) {
          if (message.output !== undefined && !(message.output instanceof Uint8Array)) throw new ConfigurationError("Invalid Vertex gRPC output bytes.");
          result = new Uint8Array(message.output ?? []);
          receivedBytes += result.byteLength;
        } else {
          const convert = (value: object): VertexTensor => {
            const tensor = proto.Tensor.toObject(proto.Tensor.fromObject(value), { longs: String, bytes: String, enums: String, json: true });
            assertVertexTensor(tensor); return tensor;
          };
          result = { outputs: (message.outputs ?? []).map(convert), ...(message.parameters ? { parameters: convert(message.parameters) } : {}) };
          receivedBytes += Buffer.byteLength(JSON.stringify(result));
        }
        if (receivedBytes > maxBytes) throw new ProviderResponseTooLargeError({ maxBytes, receivedBytes, provider: "vertex", endpoint: method });
        yield result;
      }
      if (pumpError) throw pumpError;
    } finally {
      stop.abort(new Error("Vertex gRPC stream closed."));
      signal.removeEventListener("abort", cancel);
      try {
        stream?.cancel();
      } finally {
        // A source can throw synchronously from return(), or never resolve it.
        // Neither may prevent releasing the transport or its deadline timer.
        void Promise.resolve().then(() => iterator?.return?.()).catch(() => {});
        try {
          await pump;
        } finally {
          try { await client?.close(); }
          finally { timing.cleanup(); }
        }
      }
    }
  }
  return {
    serverStreamingPredict: input => run(input, "serverStreamingPredict") as AsyncIterable<VertexGrpcTensorOutput>,
    streamDirectRawPredict: input => run(input, "streamDirectRawPredict") as AsyncIterable<Uint8Array>,
    streamDirectPredict: input => run(input, "streamDirectPredict") as AsyncIterable<VertexGrpcTensorOutput>,
    streamingRawPredict: input => run(input, "streamingRawPredict") as AsyncIterable<Uint8Array>,
    streamingPredict: input => run(input, "streamingPredict") as AsyncIterable<VertexGrpcTensorOutput>
  };
};
