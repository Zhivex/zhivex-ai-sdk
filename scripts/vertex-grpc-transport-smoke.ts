import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run after bun run build. Works in Bun and Node with TypeScript stripping.
// Disposable TLS server; no cloud credentials or external service calls.
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--consumer")) throw new Error("Usage: vertex-grpc-transport-smoke.ts [--consumer <installed-consumer-directory>]");
const vertexDirectory = args.length === 2
  ? join(resolve(args[1]), "node_modules/@zhivex-ai/vertex")
  : fileURLToPath(new URL("../packages/vertex", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "vertex-grpc-transport-"));
const keyPath = join(directory, "key.pem");
const certPath = join(directory, "cert.pem");
const previousRoots = process.env.GRPC_DEFAULT_SSL_ROOTS_FILE_PATH;
let server: { forceShutdown(): void } | undefined;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  process.env.GRPC_DEFAULT_SSL_ROOTS_FILE_PATH = certPath;
  const vertexRequire = createRequire(join(vertexDirectory, "package.json"));
  const sdkPath = realpathSync(vertexRequire.resolve("@google-cloud/aiplatform"));
  const sdkRequire = createRequire(sdkPath);
  const { grpc } = sdkRequire("google-gax");
  const { protos } = sdkRequire("@google-cloud/aiplatform");
  const proto = protos.google.cloud.aiplatform.v1;
  const received: any[] = [];
  const authorization: string[] = [];
  let cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
  const service: Record<string, object> = {};
  for (const name of ["StreamDirectRawPredict", "StreamDirectPredict", "StreamingRawPredict", "StreamingPredict", "ServerStreamingPredict"]) {
    const schema = name === "ServerStreamingPredict" ? "StreamingPredict" : name;
    const request = proto[`${schema}Request`];
    const response = proto[`${schema}Response`];
    service[name] = {
      path: `/google.cloud.aiplatform.v1.PredictionService/${name}`,
      requestStream: name !== "ServerStreamingPredict", responseStream: true,
      requestSerialize: (value: object) => Buffer.from(request.encode(request.fromObject(value)).finish()),
      requestDeserialize: (value: Uint8Array) => request.decode(value),
      responseSerialize: (value: object) => Buffer.from(response.encode(response.fromObject(value)).finish()),
      responseDeserialize: (value: Uint8Array) => response.decode(value)
    };
  }
  const instance = new grpc.Server(); server = instance;
  const echo = (raw: boolean) => (call: any) => {
    authorization.push(...call.metadata.get("authorization").map(String));
    let stalled = false;
    call.on("cancelled", () => { if (stalled) cancelled(); });
    call.on("error", () => {});
    call.on("data", (frame: any) => {
      received.push(frame);
      if (frame.endpoint) {
        stalled = frame.methodName === "/test.Service/Stall";
        return;
      }
      call.write(raw ? { output: frame.input } : { outputs: frame.inputs, parameters: frame.parameters });
    });
    call.on("end", () => { if (!stalled) call.end(); });
  };
  instance.addService(service, { StreamDirectRawPredict: echo(true), StreamDirectPredict: echo(false), StreamingRawPredict: echo(true), StreamingPredict: echo(false), ServerStreamingPredict: (call: any) => {
    authorization.push(...call.metadata.get("authorization").map(String));
    received.push(call.request);
    call.on("error", () => {});
    call.write({ outputs: call.request.inputs, parameters: call.request.parameters });
    call.write({ outputs: [{ dtype: "STRING", stringVal: ["completed"] }] });
    call.end();
  } });
  const port = await new Promise<number>((resolve, reject) => instance.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createSsl(null, [{ private_key: readFileSync(keyPath), cert_chain: readFileSync(certPath) }]), (error: Error | null, port: number) => error ? reject(error) : resolve(port)));
  const { createVertex } = await import(pathToFileURL(join(vertexDirectory, "dist/index.js")).href);
  const vertex = createVertex({ projectId: "p", location: "us-central1", accessToken: "synthetic-local-token", allowUnsafeEndpoints: true, baseURL: `https://localhost:${port}/v1/projects/p/locations/us-central1` });
  const bytes = [];
  for await (const output of vertex.endpoints.streamDirectRawPredict({ endpoint: "endpoints/e1", methodName: "/test.Service/Predict", inputs: [new Uint8Array([0, 128, 255])], timeoutMs: 5000 })) bytes.push([...output]);
  assert.deepEqual(bytes, [[0, 128, 255]]);
  const tensors = [];
  for await (const output of vertex.endpoints.streamDirectPredict({ endpoint: "endpoints/e1", inputs: [{ inputs: [{ dtype: "INT64", shape: ["1"], int64Val: ["9223372036854775807"] }] }], timeoutMs: 5000 })) tensors.push(output);
  assert.equal(tensors.length, 1);
  assert.equal(tensors[0].outputs.length, 1);
  const tensor = tensors[0].outputs[0];
  assert.equal(tensor.dtype, "INT64");
  assert.deepEqual(tensor.shape, ["1"]);
  assert.deepEqual(tensor.int64Val, ["9223372036854775807"]);
  // The real gRPC loader materializes the protobuf bytes default; it is valid.
  assert.equal(tensor.tensorVal, "");
  assert.equal(received.length, 4);
  assert.equal(received[0].endpoint, "projects/p/locations/us-central1/endpoints/e1");
  assert.equal(received[0].methodName, "/test.Service/Predict");
  assert.deepEqual(authorization, ["Bearer synthetic-local-token", "Bearer synthetic-local-token"]);
  const streamedBytes = [];
  for await (const output of vertex.endpoints.streamingRawPredict({ endpoint: "endpoints/e1", methodName: "/test.Service/Predict", inputs: [new Uint8Array([1, 0, 255])], timeoutMs: 5000 })) streamedBytes.push([...output]);
  assert.deepEqual(streamedBytes, [[1, 0, 255]]);
  const streamedTensors = [];
  for await (const output of vertex.endpoints.streamingPredict({ endpoint: "endpoints/e1", inputs: [{ inputs: [{ dtype: "STRING", stringVal: ["hello"] }] }], timeoutMs: 5000 })) streamedTensors.push(output);
  assert.equal(streamedTensors.length, 1);
  assert.deepEqual(streamedTensors[0].outputs[0].stringVal, ["hello"]);
  assert.equal(received.length, 8);
  assert.deepEqual(authorization, Array(4).fill("Bearer synthetic-local-token"));
  const serverOutputs = [];
  for await (const output of vertex.endpoints.serverStreamingPredict({ endpoint: "publishers/google/models/test-model@001", inputs: [{ dtype: "STRING", stringVal: ["request"] }], timeoutMs: 5000 })) serverOutputs.push(output);
  assert.equal(serverOutputs.length, 2);
  assert.deepEqual(serverOutputs.map(value => value.outputs[0].stringVal), [["request"], ["completed"]]);
  assert.equal(received.length, 9);
  assert.equal(received[8].endpoint, "projects/p/locations/us-central1/publishers/google/models/test-model@001");
  assert.deepEqual(authorization, Array(5).fill("Bearer synthetic-local-token"));
  await assert.rejects(async () => {
    for await (const _ of vertex.endpoints.streamDirectRawPredict({ endpoint: "endpoints/e1", methodName: "/test.Service/Stall", inputs: [], timeoutMs: 250 })) {}
  }, /timed out|deadline/i);
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([cancellation, new Promise<never>((_, reject) => {
      cancellationTimer = setTimeout(() => reject(new Error("Server did not observe stream cancellation")), 2000);
    })]);
  } finally { clearTimeout(cancellationTimer); }
  console.log("Vertex official gRPC transport passed: TLS, bearer metadata, bidirectional and server-streaming messages, int64 precision and server-observed deadline cancellation.");
} finally {
  server?.forceShutdown();
  if (previousRoots === undefined) delete process.env.GRPC_DEFAULT_SSL_ROOTS_FILE_PATH;
  else process.env.GRPC_DEFAULT_SSL_ROOTS_FILE_PATH = previousRoots;
  rmSync(directory, { recursive: true, force: true });
}
