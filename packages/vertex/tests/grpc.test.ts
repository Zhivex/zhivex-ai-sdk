import { Duplex } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createVertex } from "../src/index.js";

const mock = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(), calls: [] as object[] }));
vi.mock("@google-cloud/aiplatform", async importOriginal => {
  const sdk = await importOriginal<typeof import("@google-cloud/aiplatform")>();
  class Client {
    constructor(options: object) { mock.calls.push(options); }
    streamDirectRawPredict(options: object) { return mock.create("raw", options); }
    streamDirectPredict(options: object) { return mock.create("tensor", options); }
    serverStreamingPredict(request: object, options: object) { return mock.create("serverStreamingPredict", options, request); }
    streamingRawPredict(options: object) { return mock.create("streamingRawPredict", options); }
    streamingPredict(options: object) { return mock.create("streamingPredict", options); }
    close() { mock.close(); return Promise.resolve(); }
  }
  return { ...sdk, v1: { ...sdk.v1, PredictionServiceClient: Client }, v1beta1: { ...sdk.v1beta1, PredictionServiceClient: Client } };
});
const setup = () => createVertex({ projectId: "p", location: "us-central1", accessToken: "token" }).endpoints;
const input = { endpoint: "endpoints/e1", methodName: "/test.Service/Predict", inputs: [new Uint8Array([1, 2])], timeoutMs: 2000 };
beforeEach(() => { mock.create.mockReset(); mock.close.mockReset(); mock.calls.length = 0; });
function wire(options: { echo?: boolean; fail?: boolean } = {}) {
  const frames: any[] = [];
  const stream = new Duplex({ objectMode: true, read() {}, write(frame, _encoding, callback) {
    frames.push(frame);
    if (options.fail) { callback(new Error("remote failure")); return; }
    if (options.echo && frame.input) this.push({ output: frame.input });
    if (options.echo && frame.inputs) this.push({ outputs: frame.inputs, parameters: frame.parameters });
    callback();
  }, final(callback) { this.push(null); callback(); } });
  const cancel = vi.fn(() => stream.destroy());
  Object.assign(stream, { cancel });
  mock.create.mockReturnValue(stream);
  return { frames, stream, cancel };
}
describe("Vertex bidirectional direct gRPC", () => {
  it("sends routing metadata once, preserves bytes and closes the official client", async () => {
    const { frames, cancel } = wire({ echo: true });
    const results = [];
    for await (const value of setup().streamDirectRawPredict(input)) results.push([...value]);
    expect(results).toEqual([[1, 2]]);
    expect(frames).toEqual([{ endpoint: "projects/p/locations/us-central1/endpoints/e1", methodName: "/test.Service/Predict" }, { input: Buffer.from([1, 2]) }]);
    expect(mock.calls[0]).toMatchObject({ apiEndpoint: "us-central1-aiplatform.googleapis.com", projectId: "p" });
    expect(await (mock.calls[0] as any).auth.getAccessToken()).toBe("token");
    expect(mock.create).toHaveBeenCalledWith("raw", { timeout: 2000, retry: null });
    expect(cancel).toHaveBeenCalled(); expect(mock.close).toHaveBeenCalledOnce();
  });
  it("converts native tensors through Google's protobuf codec without losing int64 precision", async () => {
    wire({ echo: true });
    const outputs = [];
    for await (const value of setup().streamDirectPredict({ endpoint: input.endpoint, inputs: [{ inputs: [{ dtype: "INT64", shape: ["1"], int64Val: ["9223372036854775807"] }] }], timeoutMs: 2000 })) outputs.push(value);
    expect(outputs).toEqual([{ outputs: [{ dtype: "INT64", shape: ["1"], int64Val: ["9223372036854775807"] }] }]);
  });
  it("uses the separate StreamingPredict RPC with native tensor frames", async () => {
    const { frames } = wire({ echo: true });
    const outputs = [];
    for await (const value of setup().streamingPredict({ endpoint: input.endpoint, inputs: [{ inputs: [{ dtype: "STRING", stringVal: ["hello"] }] }] })) outputs.push(value);
    expect(mock.create).toHaveBeenCalledWith("streamingPredict", { retry: null });
    expect(frames[0]).toEqual({ endpoint: "projects/p/locations/us-central1/endpoints/e1" });
    expect(outputs).toEqual([{ outputs: [{ dtype: "STRING", stringVal: ["hello"] }] }]);
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it("uses the separate StreamingRawPredict RPC with binary frames", async () => {
    const { frames } = wire({ echo: true });
    const outputs = [];
    for await (const value of setup().streamingRawPredict(input)) outputs.push([...value]);
    expect(mock.create).toHaveBeenCalledWith("streamingRawPredict", { timeout: 2000, retry: null });
    expect(frames[0]).toEqual({ endpoint: "projects/p/locations/us-central1/endpoints/e1", methodName: input.methodName });
    expect(outputs).toEqual([[1, 2]]);
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it("sends a single tensor request and reads server streaming responses", async () => {
    const { stream, frames, cancel } = wire();
    stream.push({ outputs: [{ dtype: "INT64", int64Val: ["9223372036854775807"] }] });
    stream.push({ outputs: [{ dtype: "STRING", stringVal: ["done"] }] });
    stream.push(null);
    const outputs = [];
    for await (const value of setup().serverStreamingPredict({ endpoint: input.endpoint, inputs: [{ dtype: "STRING", stringVal: ["prompt"] }], parameters: { dtype: "BOOL", boolVal: [true] }, timeoutMs: 2000 })) outputs.push(value);
    expect(outputs).toEqual([{ outputs: [{ dtype: "INT64", int64Val: ["9223372036854775807"] }] }, { outputs: [{ dtype: "STRING", stringVal: ["done"] }] }]);
    expect(mock.create).toHaveBeenCalledWith("serverStreamingPredict", { timeout: 2000, retry: null }, expect.objectContaining({ endpoint: "projects/p/locations/us-central1/endpoints/e1", inputs: [expect.objectContaining({ stringVal: ["prompt"] })], parameters: expect.objectContaining({ boolVal: [true] }) }));
    expect(frames).toEqual([]);
    expect(cancel).toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it.each([
    ["publishers/google/models/model@001", "projects/p/locations/us-central1/publishers/google/models/model@001"],
    ["projects/other/locations/europe-west4/publishers/acme/models/custom@v2", "projects/other/locations/europe-west4/publishers/acme/models/custom@v2"]
  ])("routes publisher server streaming resource %s without URL escaping", async (endpoint, resource) => {
    const { stream } = wire(); stream.push(null);
    for await (const _ of setup().serverStreamingPredict({ endpoint, inputs: [] })) {}
    expect(mock.create).toHaveBeenCalledWith("serverStreamingPredict", { retry: null }, expect.objectContaining({ endpoint: resource }));
  });
  it("does not allow publisher model resources on deployed-endpoint-only RPCs", async () => {
    const endpoint = "publishers/google/models/model@001";
    await expect(setup().streamDirectPredict({ endpoint, inputs: [] })[Symbol.asyncIterator]().next()).rejects.toThrow("deployed endpoint");
    await expect(setup().streamingRawPredict({ ...input, endpoint })[Symbol.asyncIterator]().next()).rejects.toThrow("deployed endpoint");
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("cancels a server stream when output exceeds its cumulative limit", async () => {
    const { stream, cancel } = wire();
    stream.push({ outputs: [{ dtype: "STRING", stringVal: ["too large"] }] });
    await expect((async () => {
      for await (const _ of setup().serverStreamingPredict({ endpoint: input.endpoint, inputs: [], maxResponseBytes: 4 })) {}
    })()).rejects.toMatchObject({ name: "ProviderResponseTooLargeError", endpoint: "serverStreamingPredict" });
    expect(cancel).toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it("cancels both directions when the consumer leaves early", async () => {
    const { cancel } = wire({ echo: true });
    const returned = vi.fn();
    const source = { [Symbol.asyncIterator]() { let sent = false; return { next: () => sent ? new Promise<IteratorResult<Uint8Array>>(() => {}) : (sent = true, Promise.resolve({ done: false as const, value: new Uint8Array([1]) })), return: () => { returned(); return Promise.resolve({ done: true as const, value: undefined }); } }; } };
    for await (const value of setup().streamDirectRawPredict({ ...input, inputs: source })) { expect(value[0]).toBe(1); break; }
    expect(cancel).toHaveBeenCalled(); expect(returned).toHaveBeenCalledOnce(); expect(mock.close).toHaveBeenCalledOnce();
  });
  it("bounds stalled input/output by deadline", async () => {
    const { cancel } = wire();
    const source = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); yield new Uint8Array(); } };
    await expect((async () => { for await (const _ of setup().streamDirectRawPredict({ ...input, inputs: source, timeoutMs: 40 })) {} })()).rejects.toThrow();
    expect(cancel).toHaveBeenCalled(); expect(mock.close).toHaveBeenCalledOnce();
  });
  it("releases the client even when the input iterator throws from return", async () => {
    const { cancel } = wire({ echo: true });
    const returned = vi.fn(() => { throw new Error("source cleanup failed"); });
    const source = { [Symbol.asyncIterator]() { let sent = false; return { next: () => sent ? new Promise<IteratorResult<Uint8Array>>(() => {}) : (sent = true, Promise.resolve({ done: false as const, value: new Uint8Array([1]) })), return: returned }; } };
    for await (const value of setup().streamDirectRawPredict({ ...input, inputs: source })) {
      expect(value[0]).toBe(1);
      break;
    }
    expect(returned).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it("enforces accumulated response size without replaying the request", async () => {
    wire({ echo: true });
    await expect((async () => { for await (const _ of setup().streamDirectRawPredict({ ...input, inputs: [new Uint8Array([1, 2]), new Uint8Array([3, 4])], maxResponseBytes: 3 })) {} })()).rejects.toMatchObject({ name: "ProviderResponseTooLargeError" });
    expect(mock.create).toHaveBeenCalledOnce(); expect(mock.close).toHaveBeenCalledOnce();
  });
  it("processes timer cancellation while a synchronous producer keeps supplying frames", async () => {
    const { frames, cancel } = wire();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = { *[Symbol.iterator]() {
      timer = setTimeout(() => controller.abort(new Error("scheduled cancellation")), 0);
      for (let index = 0; index < 10000; index++) yield new Uint8Array([1]);
    } };
    try {
      await expect((async () => {
        for await (const _ of setup().streamDirectRawPredict({ ...input, inputs: source, abortSignal: controller.signal })) {}
      })()).rejects.toThrow("scheduled cancellation");
      expect(frames.length).toBeLessThan(10001);
      expect(cancel).toHaveBeenCalled();
      expect(mock.close).toHaveBeenCalledOnce();
    } finally { clearTimeout(timer); }
  });
  it("propagates remote errors and rejects replay configuration", async () => {
    wire({ fail: true });
    await expect((async () => { for await (const _ of setup().streamDirectRawPredict(input)) {} })()).rejects.toThrow("remote failure");
    expect(mock.close).toHaveBeenCalledOnce();
    await expect(setup().streamDirectRawPredict({ ...input, maxRetries: 1 })[Symbol.asyncIterator]().next()).rejects.toThrow("cannot be replayed");
    expect(mock.create).toHaveBeenCalledOnce();
  });
});
