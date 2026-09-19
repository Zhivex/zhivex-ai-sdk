import { describe, expect, it, vi } from "vitest";
import { createVertex } from "../src/index.js";
import type { VertexTensor } from "../src/index.js";

const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(new Uint8Array([255, 0, 128]), {
    headers: { "content-type": "application/octet-stream", "x-vertex-ai-endpoint-id": "e1", "x-vertex-ai-deployed-model-id": "m1" }
  }));
  return { fetch, client: createVertex({ projectId: "p", location: "us-central1", accessToken: "token", fetch }).endpoints };
};
const input = { endpoint: "endpoints/e1", body: new Uint8Array([0, 255, 128]), contentType: "application/octet-stream" };
describe("Vertex endpoint HTTP payloads", () => {
  it("preserves tensor precision, nested parameters and special floating values", async () => {
    const { client, fetch } = setup();
    const tensor: VertexTensor = { dtype: "INT64", shape: ["2"], int64Val: ["9223372036854775807", "-9223372036854775808"] };
    const parameters: VertexTensor = { structVal: { signature: { dtype: "STRING", stringVal: ["serving_default"] }, extra: { listVal: [{ dtype: "DOUBLE", doubleVal: ["NaN", "Infinity", "-Infinity", 0.5] }] } } };
    fetch.mockResolvedValueOnce(Response.json({ outputs: [tensor], parameters }));
    expect(await client.directPredict({ endpoint: input.endpoint, inputs: [tensor], parameters })).toEqual({ outputs: [tensor], parameters });
    expect(String(fetch.mock.lastCall![0])).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/e1:directPredict");
    expect(JSON.parse(fetch.mock.lastCall![1]!.body as string)).toEqual({ inputs: [tensor], parameters });
  });
  it("rejects lossy and incompatible tensor inputs before HTTP", async () => {
    const { client, fetch } = setup();
    for (const tensor of [{ dtype: "FLOAT", floatVal: [NaN] }, { dtype: "INT64", int64Val: ["9223372036854775808"] }, { dtype: "INT64", int64Val: [42] }, { dtype: "UINT64", uint64Val: ["-1"] }, { dtype: "BOOL", intVal: [1] }, { dtype: "FLOAT", floatVal: [1], intVal: [1] }, { shape: [1] }, { bytesVal: ["!bad"] }]) {
      await expect(client.directPredict({ endpoint: input.endpoint, inputs: [tensor as VertexTensor] })).rejects.toThrow("Tensor");
    }
    const cyclic: VertexTensor = {}; cyclic.listVal = [cyclic];
    await expect(client.directPredict({ endpoint: input.endpoint, inputs: [cyclic] })).rejects.toThrow("Tensor");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("validates output tensors and bounds direct JSON responses", async () => {
    const { client, fetch } = setup();
    const request = { endpoint: input.endpoint, inputs: [] };
    for (const response of [null, [], { outputs: 1 }, { outputs: [{ dtype: "unknown" }] }, { outputs: [], parameters: { int64Val: [42] } }]) {
      fetch.mockResolvedValueOnce(Response.json(response));
      await expect(client.directPredict(request)).rejects.toThrow();
    }
    fetch.mockResolvedValueOnce(Response.json({}));
    expect(await client.directPredict(request)).toEqual({ outputs: [] });
    fetch.mockResolvedValueOnce(Response.json({ outputs: [] }));
    await expect(client.directPredict({ ...request, maxResponseBytes: 2 })).rejects.toMatchObject({ name: "ProviderResponseTooLargeError" });
  });
  it("preserves explanation attributions, predictions and native overrides", async () => {
    const { client, fetch } = setup();
    const response = { explanations: [{ attributions: [{ featureAttributions: { age: 0.8 }, outputIndex: [0], approximationError: 0.01 }] }], predictions: [{ score: 0.9 }], deployedModelId: "d1" };
    fetch.mockResolvedValueOnce(Response.json(response));
    const request = { endpoint: "projects/p/locations/us-central1/endpoints/e1", instances: [{ age: 42 }], parameters: false, deployedModelId: "d1", explanationSpecOverride: { parameters: { sampledShapleyAttribution: { pathCount: 20 } }, metadata: { inputs: { age: { inputBaselines: [0] } } } } };
    expect(await client.explain(request)).toEqual(response);
    expect(String(fetch.mock.lastCall![0])).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/e1:explain");
    const { endpoint, ...body } = request;
    expect(JSON.parse(fetch.mock.lastCall![1]!.body as string)).toEqual(body);
  });
  it("rejects mismatched explanation counts and malformed responses", async () => {
    const { client, fetch } = setup();
    for (const response of [{}, { explanations: [], predictions: [] }, { explanations: [null], predictions: [1] }, { explanations: [{}], predictions: 1 }, { explanations: [{}], predictions: [1], deployedModelId: 42 }]) {
      fetch.mockResolvedValueOnce(Response.json(response));
      await expect(client.explain({ endpoint: input.endpoint, instances: [1] })).rejects.toThrow("invalid response");
    }
  });
  it("bounds explanation responses and rejects invalid input before HTTP", async () => {
    const { client, fetch } = setup();
    await expect(client.explain({ endpoint: input.endpoint, instances: [] })).rejects.toThrow("instances");
    await expect(client.explain({ endpoint: input.endpoint, instances: [1], deployedModelId: "" })).rejects.toThrow("deployedModelId");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(Response.json({ explanations: [{}], predictions: [1] }));
    await expect(client.explain({ endpoint: input.endpoint, instances: [1], maxResponseBytes: 2 })).rejects.toMatchObject({ name: "ProviderResponseTooLargeError" });
  });
  it("maps serialized gRPC input to directRawPredict and decodes output", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(Response.json({ output: "/wCA" }));
    const result = await client.directRawPredict({ endpoint: input.endpoint, methodName: "/tensorflow.serving.PredictionService/Predict", input: new Uint8Array([0, 255, 128]) });
    expect(String(fetch.mock.lastCall![0])).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/e1:directRawPredict");
    expect(JSON.parse(fetch.mock.lastCall![1]!.body as string)).toEqual({ methodName: "/tensorflow.serving.PredictionService/Predict", input: "AP+A" });
    expect(result).toEqual({ output: new Uint8Array([255, 0, 128]), status: 200 });
  });
  it("rejects malformed direct output and enforces decoded byte limits", async () => {
    const { client, fetch } = setup();
    const request = { endpoint: input.endpoint, methodName: "/test.Service/Predict", input: new Uint8Array() };
    for (const response of [null, [], { output: 1 }, { output: "%%%" }]) {
      fetch.mockResolvedValueOnce(Response.json(response));
      await expect(client.directRawPredict(request)).rejects.toThrow();
    }
    fetch.mockResolvedValueOnce(Response.json({ output: "AQID" }));
    await expect(client.directRawPredict({ ...request, maxResponseBytes: 2 })).rejects.toMatchObject({ name: "ProviderResponseTooLargeError" });
    fetch.mockResolvedValueOnce(Response.json({ output: "" }));
    expect((await client.directRawPredict(request)).output).toEqual(new Uint8Array());
    fetch.mockResolvedValueOnce(Response.json({}));
    expect((await client.directRawPredict(request)).output).toEqual(new Uint8Array());
  });
  it("rejects invalid direct methods and bounds the JSON envelope", async () => {
    const { client, fetch } = setup();
    const request = { endpoint: input.endpoint, methodName: "/test.Service/Predict", input: new Uint8Array() };
    for (const methodName of ["Predict", "/test.Service", "/test.Service/Predict?x", "/test.Service/Predict\r\n"]) await expect(client.directRawPredict({ ...request, methodName })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Response("{}", { headers: { "content-length": "100000" } }));
    await expect(client.directRawPredict({ ...request, maxResponseBytes: 2 })).rejects.toMatchObject({ name: "ProviderResponseTooLargeError" });
  });
  it("streams binary chunks and response metadata on the native route", async () => {
    const { client, fetch } = setup();
    const events = [];
    for await (const event of client.streamRawPredict(input)) events.push(event);
    expect(String(fetch.mock.lastCall![0])).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/e1:streamRawPredict");
    expect(events).toEqual([
      { type: "response", status: 200, contentType: "application/octet-stream", endpointId: "e1", deployedModelId: "m1" },
      { type: "chunk", data: new Uint8Array([255, 0, 128]) }
    ]);
  });
  it("cancels the body when the consumer stops at the response event", async () => {
    const { client, fetch } = setup();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    for await (const event of client.streamRawPredict(input)) { expect(event.type).toBe("response"); break; }
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("enforces a cumulative byte limit across chunks", async () => {
    const { client, fetch } = setup();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3, 4])); }, cancel })));
    const iterator = client.streamRawPredict({ ...input, maxResponseBytes: 3 })[Symbol.asyncIterator]();
    await iterator.next();
    expect((await iterator.next()).value).toEqual({ type: "chunk", data: new Uint8Array([1, 2]) });
    await expect(iterator.next()).rejects.toMatchObject({ name: "ProviderResponseTooLargeError", receivedBytes: 4 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("checks declared response size before yielding headers", async () => {
    const { client, fetch } = setup();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { "content-length": "8" } }));
    const iterator = client.streamRawPredict({ ...input, maxResponseBytes: 3 })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ name: "ProviderResponseTooLargeError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(["deadline", "abort"])("interrupts a stalled body on %s", async mode => {
    const { client, fetch } = setup();
    const cancel = vi.fn();
    const controller = new AbortController();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const iterator = client.streamRawPredict({ ...input, timeoutMs: mode === "deadline" ? 40 : 5000, abortSignal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    if (mode === "abort") controller.abort(new Error("explicit abort"));
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("retries initial HTTP failure but never replays an interrupted body", async () => {
    const { client, fetch } = setup();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    fetch.mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new Uint8Array([1])); } })));
    const iterator = client.streamRawPredict({ ...input, maxRetries: 2, retryBackoffMs: 0 })[Symbol.asyncIterator]();
    await iterator.next();
    expect((await iterator.next()).value.type).toBe("chunk");
    controller.error(new Error("stream interrupted"));
    await expect(iterator.next()).rejects.toThrow("stream interrupted");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["endpoints/e1", "projects/p/locations/us-central1/endpoints/e1"])("preserves bytes and routing metadata for %s", async endpoint => {
    const { client, fetch } = setup();
    const result = await client.rawPredict({ ...input, endpoint });
    expect(String(fetch.mock.lastCall![0])).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/e1:rawPredict");
    const init = fetch.mock.lastCall![1]!;
    expect([...new Uint8Array(init.body as ArrayBuffer)]).toEqual([0, 255, 128]);
    expect(new Headers(init.headers).get("content-type")).toBe("application/octet-stream");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token");
    expect(init.redirect).toBe("error");
    expect(result).toEqual({ body: new Uint8Array([255, 0, 128]), status: 200, contentType: "application/octet-stream", endpointId: "e1", deployedModelId: "m1" });
  });
  it("sends text verbatim without JSON quoting and accepts empty responses", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await client.rawPredict({ ...input, body: "valor,ñ\n1,2", contentType: "text/csv; charset=utf-8" })).toEqual({ body: new Uint8Array(), status: 204 });
    expect(fetch.mock.lastCall![1]!.body).toBe("valor,ñ\n1,2");
  });
  it.each([true, false])("bounds response bytes with content-length=%s", async advertised => {
    const { client, fetch } = setup();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); }, cancel }), {
      headers: advertised ? { "content-length": "3" } : {}
    }));
    await expect(client.rawPredict({ ...input, maxResponseBytes: 2 })).rejects.toMatchObject({ name: "ProviderResponseTooLargeError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("retries HTTP failures with the same bytes but does not retry client errors", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    await client.rawPredict({ ...input, maxRetries: 1, retryBackoffMs: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1]!.body).toBe(fetch.mock.calls[1][1]!.body);
    fetch.mockReset().mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(client.rawPredict({ ...input, maxRetries: 2 })).rejects.toMatchObject({ status: 400, name: "ProviderHTTPError" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("bounds a pending authenticated request by its deadline", async () => {
    const { client, fetch } = setup();
    fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await expect(client.rawPredict({ ...input, timeoutMs: 20, maxRetries: 0 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects invalid resources, headers and limits before HTTP", async () => {
    const { client, fetch } = setup();
    for (const endpoint of ["https://example.com/e", "publishers/google/models/m", "endpoints/..", "endpoints/e?x=1", "endpoints/e#x"]) await expect(client.rawPredict({ ...input, endpoint })).rejects.toThrow();
    for (const maxResponseBytes of [0, -1, NaN, Infinity, 1.5]) await expect(client.rawPredict({ ...input, maxResponseBytes })).rejects.toThrow();
    await expect(client.rawPredict({ ...input, contentType: "text/plain\r\nx-test: a" })).rejects.toThrow();
    await expect(client.rawPredict({ ...input, abortSignal: AbortSignal.abort() })).rejects.toThrow();
    await expect(createVertex({ apiKey: "key", fetch }).endpoints.rawPredict(input)).rejects.toThrow("bearer");
    expect(fetch).not.toHaveBeenCalled();
  });
});
