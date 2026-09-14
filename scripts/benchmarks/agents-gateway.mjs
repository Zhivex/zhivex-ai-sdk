import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createAgent, createInMemoryAgentRunStore, createTextMessage, runAgent, runAgentGroup, tool } from "../../packages/core/dist/index.js";
import { createMockLanguageModel } from "../../packages/core/dist/testing.js";
import { createGateway } from "../../packages/gateway/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scenarios = ["text", "stream", "tools", "group", "fallback", "compaction", "checkpoints"];
export const percentile = (values, fraction) => {
  if (!values.length || values.some(x => !Number.isFinite(x) || x < 0) || fraction < 0 || fraction > 1) throw new Error("Invalid percentile input");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
};
export const coveredTime = intervals => {
  let end = -Infinity;
  let total = 0;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
};
export const validateFixture = fixture => {
  if (!scenarios.includes(fixture.scenario)) throw new Error("Unknown scenario");
  for (const [field, max] of [["steps", 100], ["concurrency", 16], ["payloadBytes", 4096]]) {
    if (!Number.isSafeInteger(fixture[field]) || fixture[field] < 1 || fixture[field] > max) throw new Error(`Invalid ${field}`);
  }
  if (!Number.isSafeInteger(fixture.seed) || fixture.seed < 0 || fixture.seed > 0xffffffff) throw new Error("Invalid seed");
  return fixture;
};

export async function runTrial(fixture) {
  validateFixture(fixture);
  const modelIntervals = [], storeIntervals = [], firstTokens = [];
  let modelCalls = 0, failedAttempts = 0, checkpoints = 0, checkpointBytes = 0, effects = 0;
  const payload = String.fromCharCode(97 + fixture.seed % 26).repeat(fixture.payloadBytes);
  const response = { text: "correct", messages: [createTextMessage("assistant", "correct")], finishReason: "stop", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
  const store = createInMemoryAgentRunStore();
  const wrappedStore = new Proxy(store, { get(target, key) {
    const value = target[key];
    if (typeof value !== "function") return value;
    return async (...args) => {
      const start = performance.now();
      try {
        if (key === "save" || key === "claimIdempotencyKey") {
          checkpoints++;
          checkpointBytes += Buffer.byteLength(JSON.stringify(args[0]));
        }
        return await value.apply(target, args);
      } finally { storeIntervals.push([start, performance.now()]); }
    };
  } });
  const makeModel = (withTools = false) => {
    const model = createMockLanguageModel();
    let calls = 0;
    model.generate = async () => {
      const start = performance.now(); modelCalls++; calls++;
      try {
        if (withTools && calls < fixture.steps) return { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: `call-${calls}`, name: "inspect", input: {} } }] }], finishReason: "tool-calls", usage: response.usage };
        return structuredClone(response);
      } finally { modelIntervals.push([start, performance.now()]); }
    };
    model.stream = async () => (async function* () {
      const start = performance.now(); modelCalls++;
      try { yield { type: "text-delta", textDelta: "correct" }; yield { type: "finish", finishReason: "stop", usage: response.usage }; }
      finally { modelIntervals.push([start, performance.now()]); }
    })();
    return model;
  };
  const makeAgent = id => createAgent({ id, model: makeModel(true), maxSteps: fixture.steps,
    store: ["group", "checkpoints", "compaction"].includes(fixture.scenario) ? wrappedStore : undefined,
    policy: { maxStateBytes: 64 * 1024 * 1024 },
    tools: { inspect: tool({ name: "inspect", schema: z.object({}), execute: () => { effects++; return payload; } }) },
    ...(fixture.scenario === "compaction" ? { compaction: { maxMessages: 4, keepRecentMessages: 2, compactor: () => ({ summary: "Inspected fixture." }) } } : {})
  });
  const cpuStart = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  if (fixture.scenario === "group") {
    const group = Array.from({ length: fixture.concurrency }, (_, i) => ({ name: `member-${i}`, agent: makeAgent(`member-${i}`) }));
    const output = await runAgentGroup(group, { prompt: payload, idempotencyKey: "benchmark-group" });
    assert.equal(output.status, "completed");
    assert.equal(new Set(output.outputs.map(x => x.output.state.runId)).size, fixture.concurrency);
    for (const member of output.outputs) assert.equal(member.output.outputText, "correct");
  } else await Promise.all(Array.from({ length: fixture.concurrency }, async (_, i) => {
    if (["tools", "checkpoints", "compaction"].includes(fixture.scenario)) {
      const result = await runAgent(makeAgent(`agent-${i}`), { prompt: payload });
      assert.equal(result.status, "completed"); assert.equal(result.outputText, "correct");
      assert.equal(result.usage.totalTokens, 110 * fixture.steps);
      if (fixture.scenario === "compaction" && fixture.steps > 2) assert.ok(result.state.compactions.length > 0);
      return;
    }
    const model = makeModel();
    const failing = { ...model, generate: async () => {
      const begin = performance.now(); failedAttempts++;
      modelIntervals.push([begin, performance.now()]);
      throw new Error("503 fixture unavailable");
    } };
    const gateway = createGateway({ adapters: { gemini: { name: "mock", languageModel: () => model }, bedrock: { name: "failure", languageModel: () => failing } }, maxRetries: 0 });
    for (let step = 0; step < fixture.steps; step++) {
      const request = { primary: { provider: fixture.scenario === "fallback" ? "bedrock" : "gemini", modelId: "fixture" }, messages: [{ role: "user", content: payload }], ...(fixture.scenario === "fallback" ? { fallbacks: [{ provider: "gemini", modelId: "fixture" }] } : {}) };
      let result;
      if (fixture.scenario === "stream") {
        const beforeStream = performance.now(); let first = true;
        const stream = gateway.streamText(request);
        for await (const event of stream.eventStream) if (first && event.type === "text-delta") { firstTokens.push(performance.now() - beforeStream); first = false; }
        result = await stream.collect();
        assert.equal(first, false);
      } else result = await gateway.generate(request);
      assert.equal(result.text, "correct"); assert.equal(result.usage.totalTokens, 110);
      if (fixture.scenario === "fallback") assert.equal(result.attempts.filter(x => x.errorMessage).length, 1);
    }
  }));
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  assert.equal(modelCalls, fixture.steps * fixture.concurrency);
  assert.equal(effects, ["tools", "group", "compaction", "checkpoints"].includes(fixture.scenario) ? (fixture.steps - 1) * fixture.concurrency : 0);
  assert.equal(failedAttempts, fixture.scenario === "fallback" ? fixture.steps * fixture.concurrency : 0);
  const externalWallMs = coveredTime([...modelIntervals, ...storeIntervals]);
  return { wallMs, cpuMs: (cpu.user + cpu.system) / 1000, rssBefore, rssAfter: process.memoryUsage().rss,
    modelMs: modelIntervals.reduce((sum, [a, b]) => sum + b - a, 0), storeMs: storeIntervals.reduce((sum, [a, b]) => sum + b - a, 0),
    sdkAndHarnessWallMs: Math.max(0, wallMs - externalWallMs), checkpointBytes, checkpoints, modelCalls, failedAttempts, effects,
    ttftMs: firstTokens.length ? percentile(firstTokens, .95) : null, correctTasks: fixture.concurrency };
}

export async function main(args = process.argv.slice(2)) {
  const values = Object.fromEntries(args.map(arg => { if (!/^--[a-z-]+=.+$/.test(arg)) throw new Error(`Invalid argument ${arg}`); return arg.slice(2).split(/=(.*)/s).slice(0, 2); }));
  for (const key of Object.keys(values)) if (!["matrix", "repetitions", "warmup", "seed", "output"].includes(key)) throw new Error(`Unknown option ${key}`);
  const matrix = values.matrix ?? "pilot";
  if (!["pilot", "full"].includes(matrix)) throw new Error("matrix must be pilot or full");
  const repetitions = Number(values.repetitions ?? 5), warmup = Number(values.warmup ?? 1), seed = Number(values.seed ?? 42);
  if (!Number.isSafeInteger(repetitions) || repetitions < 2 || repetitions > 20 || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 5) throw new Error("Invalid repetitions/warmup");
  const fixtures = scenarios.flatMap(scenario => (matrix === "full" ? [1, 10, 100] : [1, 10]).flatMap(steps =>
    (matrix === "full" ? [64, 1024] : [64]).flatMap(payloadBytes => (matrix === "full" ? [1, 4, 16] : [1, 4]).map(concurrency => validateFixture({ scenario, steps, payloadBytes, concurrency, seed })))));
  const rows = [];
  const deadline = performance.now() + 10 * 60_000;
  for (const fixture of fixtures) {
    const trials = [];
    for (let i = 0; i < warmup + repetitions; i++) {
      if (performance.now() > deadline) throw new Error("Benchmark exceeded ten-minute budget");
      const trial = await runTrial(fixture);
      if (i >= warmup) trials.push(trial);
    }
    const p50Ms = percentile(trials.map(x => x.wallMs), .5), p95Ms = percentile(trials.map(x => x.wallMs), .95);
    rows.push({ fixture, p50Ms, p95Ms, throughputTasksPerSecond: trials.reduce((s, x) => s + x.correctTasks, 0) / trials.reduce((s, x) => s + x.wallMs / 1000, 0),
      observedSpreadRatio: p95Ms / p50Ms, trials });
  }
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const hash = async file => createHash("sha256").update(await readFile(resolve(root, file))).digest("hex");
  const report = { schemaVersion: 1, mode: "offline", createdAt: new Date().toISOString(), matrix, repetitions, warmup, seed,
    sourceSha: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])), runtime: { node: process.versions.node, bun: process.versions.bun ?? null },
    environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    hashes: { runner: await hash("scripts/benchmarks/agents-gateway.mjs"), lockfile: await hash("bun.lock"), catalog: await hash("packages/core/src/catalog.ts"), coreRuntime: await hash("packages/core/dist/agent.js"), gatewayRuntime: await hash("packages/gateway/dist/index.js") },
    limitations: ["Deterministic mocks, no provider/network latency or monetary cost", "In-memory store; checkpointBytes measures logical serialized state at write boundaries, not disk I/O", "SDK residual includes fixture orchestration and instrumentation", "RSS endpoints are process-wide, not peak per request", "Model/store durations are sums; overlaps are removed only for residual wall time", "Stream ttftMs is within-trial p95 of first text latency", "Proposed regression bands require a second run; never a product performance promise"], rows };
  const output = resolve(values.output ?? "artifacts/agents-gateway-benchmark.json"); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  const markdown = [`# Agents/Gateway offline baseline`, ``, `Runtime: ${JSON.stringify(report.runtime)}. Source: ${report.sourceSha}; dirty=${report.dirty}.`, ``, `| Scenario | Steps | Bytes | Concurrency | p50 ms | p95 ms | Tasks/s | Observed p95/p50 |`, `|---|---:|---:|---:|---:|---:|---:|---:|`, ...rows.map(x => `| ${x.fixture.scenario} | ${x.fixture.steps} | ${x.fixture.payloadBytes} | ${x.fixture.concurrency} | ${x.p50Ms.toFixed(3)} | ${x.p95Ms.toFixed(3)} | ${x.throughputTasksPerSecond.toFixed(1)} | ${x.observedSpreadRatio.toFixed(2)} |`), ``, ...report.limitations.map(x => `- ${x}`)].join("\n");
  await writeFile(output.replace(/\.json$/, "") + ".md", markdown + "\n");
  console.log(JSON.stringify({ output, scenarios: rows.length, correctTrials: rows.length * repetitions, mode: report.mode }));
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
