/** Offline consumer regression over the exact Bun-packed core/agents/sdk artifacts. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = mkdtempSync(join(tmpdir(), "zhivex-failed-child-consumer-"));
const dependencies: Record<string, string> = {};
const artifacts: Record<string, { version: string; sha256: string }> = {};
for (const name of ["core", "agents", "sdk"]) {
  const cwd = join(root, "packages", name);
  const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const filename = join(directory, `${name}.tgz`);
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", filename, "--quiet"], { cwd, stdio: "pipe" });
  dependencies[manifest.name] = filename;
  artifacts[manifest.name] = { version: manifest.version, sha256: createHash("sha256").update(readFileSync(filename)).digest("hex") };
}
// Reuse installed third-party fixtures; SDK packages themselves come only from tarballs.
const overrides = { ...dependencies };
for (const name of ["zod", "ws", "@opentelemetry/api"]) {
  overrides[name] = join(root, "node_modules", name);
  dependencies[name] = overrides[name];
}
writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "failed-child-consumer", private: true, type: "module", dependencies, overrides }));
execFileSync("bun", ["install", "--ignore-scripts"], { cwd: directory, stdio: "pipe" });
writeFileSync(join(directory, "verify.mjs"), `
import assert from 'node:assert/strict';
import { createAgent, runAgent, streamAgent, createInMemoryAgentRunStore, tool } from '@zhivex-ai/sdk';
import { getAgentBudgetStatus } from '@zhivex-ai/agents';
import { z } from 'zod';
const response = (names, usage) => ({ messages: [{ role: 'assistant', parts: names.map((name, i) => ({ type: 'tool-call', toolCall: { id: 'call-' + i, name, input: name === 'delegate' ? { prompt: 'go' } : {} } })) }], finishReason: 'tool-calls', usage });
const model = (names, usage) => ({ provider: 'fixture', modelId: 'offline', capabilities: { tools: true, streaming: true }, async generate() { return response(names, usage); }, async stream() { return (async function* () { for (const part of response(names, usage).messages[0].parts) yield { type: 'tool-call', toolCall: part.toolCall }; yield { type: 'finish', finishReason: 'tool-calls', usage }; })(); } });
for (const streaming of [false, true]) {
  const store = createInMemoryAgentRunStore();
  let effects = 0;
  const child = createAgent({ model: model(['work', 'work'], { inputTokens: 3, outputTokens: 2, totalTokens: 5 }), policy: { budget: { maxToolCalls: 1 } }, tools: { work: tool({ name: 'work', schema: z.object({}), execute: () => { effects++; } }) } });
  const parent = createAgent({ store, model: model(['delegate'], { inputTokens: 2, outputTokens: 1, totalTokens: 3 }), subagents: [{ name: 'delegate', agent: child }] });
  await assert.rejects(streaming ? streamAgent(parent, { runId: 'parent', prompt: 'go' }).collect() : runAgent(parent, { runId: 'parent', prompt: 'go' }), /maxToolCalls/);
  const state = await store.load('parent');
  assert.equal(state.status, 'failed');
  assert.equal(state.childRuns.length, 1);
  assert.equal(state.childRuns[0].status, 'failed');
  assert.equal(getAgentBudgetStatus(state, {}).consumption.totalTokens, 8);
  assert.equal(getAgentBudgetStatus(state, { includeChildRuns: false }).consumption.totalTokens, 3);
  assert.equal(effects, 0);
}
console.log('Installed tarball consumer: generate + stream, 8 tokens, zero effects.');
`);
execFileSync("bun", ["run", "verify.mjs"], { cwd: directory, stdio: "inherit" });
console.log(JSON.stringify({ directory, artifacts }, null, 2));
