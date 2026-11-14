import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { z } from "zod";

const coreDirectory = path.resolve(import.meta.dirname, "../../packages/core/src");
const baselineRef = process.argv.find(value => value.startsWith("--baseline-ref="))?.slice("--baseline-ref=".length);
let root = coreDirectory;
if (baselineRef) {
  root = mkdtempSync(path.join(os.tmpdir(), "zhivex-stream-benchmark-"));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  for (const file of ["generate-object.ts", "stream.ts", "middleware-runtime.ts"]) {
    const source = execFileSync("git", ["show", `${baselineRef}:packages/core/src/${file}`], {
      cwd: path.resolve(coreDirectory, "../../.."), encoding: "utf8"
    });
    const resolved = source.replace(/from "\.\/([^"\n]+)"/g, (_match, relative: string) =>
      `from ${JSON.stringify(path.join(coreDirectory, relative))}`);
    writeFileSync(path.join(root, file), resolved);
  }
}
const { streamObject } = await import(path.join(root, "generate-object.ts"));
const { streamSSE } = await import(path.join(root, "stream.ts"));
const { createInMemoryGenerateCache } = await import(path.join(root, "middleware-runtime.ts"));
const capabilities = { streaming: true, tools: false, structuredOutput: true, jsonMode: true, toolChoice: false, parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false };
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const measure = async (operation: () => Promise<unknown>) => {
  for (let i = 0; i < 2; i++) await operation();
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now(); await operation(); times.push(performance.now() - start);
  }
  return +median(times).toFixed(3);
};
async function objectRun(size: number, interval: number, serialize = false) {
  const payload = JSON.stringify({ text: "a".repeat(size) });
  const model = { provider: "benchmark", modelId: "benchmark", capabilities,
    async generate() { throw new Error("unused"); },
    async *stream() {
      for (let i = 0; i < payload.length; i += 64) yield { type: "text-delta", textDelta: payload.slice(i, i + 64) };
      yield { type: "finish", finishReason: "stop" };
    }
  };
  const result = streamObject({ model, prompt: "x", schema: z.object({ text: z.string() }), snapshotIntervalChars: interval,
    streamBuffer: { replayOverflow: "drop-oldest", maxHistory: 16 } });
  let bytes = 0, count = 0, text = "", snapshotText = "";
  for await (const event of result.eventStream) {
    count++;
    if (serialize) bytes += Buffer.byteLength(JSON.stringify(event));
    if (event.type === "text-delta") text += event.textDelta;
    if (event.type === "object-delta") snapshotText += event.textDelta;
  }
  if (text !== payload || snapshotText !== payload || (await result.collect()).object.text !== "a".repeat(size)) throw new Error("Object output changed");
  return { serializedBytes: bytes, events: count };
}
async function sseRun(size: number) {
  const bytes = new TextEncoder().encode(`data: ${"x".repeat(size)}\n\n`);
  let offset = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    const end = Math.min(offset + 64, bytes.length); controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } }));
  let received = 0;
  for await (const event of streamSSE(response)) received += event.data.length;
  if (received !== size) throw new Error("SSE output changed");
}
async function cacheRun(bounded: boolean) {
  const cache = createInMemoryGenerateCache(bounded ? { maxEntries: 128, maxBytes: 256 * 1024 } : {});
  for (let i = 0; i < 2000; i++) cache.set(String(i), { text: `${i}:${"x".repeat(1024)}` });
  let entries = 0, bytes = 0;
  for (let i = 0; i < 2000; i++) {
    const entry = cache.get(String(i));
    if (entry) { entries++; bytes += Buffer.byteLength(JSON.stringify(entry)) + Buffer.byteLength(String(i)); }
  }
  return { retainedEntries: entries, retainedSerializedBytes: bytes };
}
const objects = [];
for (const size of [16384, 32768, 65536]) for (const interval of [1, 4096]) {
  objects.push({ size, snapshotIntervalChars: interval, medianMs: await measure(() => objectRun(size, interval)), ...await objectRun(size, interval, true) });
}
const sse = [];
for (const size of [131072, 262144, 524288]) sse.push({ size, medianMs: await measure(() => sseRun(size)) });
const cache = [];
for (const bounded of [false, true]) cache.push({ bounded, medianMs: await measure(() => cacheRun(bounded)), ...await cacheRun(bounded) });
console.log(JSON.stringify({ baselineRef: baselineRef ?? null, runtime: process.versions.bun, warmups: 2, samples: 5, chunkBytes: 64, objects, sse, cache }, null, 2));
