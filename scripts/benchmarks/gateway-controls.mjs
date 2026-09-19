// Offline relative overhead and cache-effectiveness fixture; no credentials or network.
// Run after bun run build: bun scripts/benchmarks/gateway-controls.mjs /tmp/gateway-controls.json
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createGateway, createGatewayAdmissionController, createGatewayBudgetStore, createGatewayMetrics, createGatewayRoutingPolicy } from '../../packages/gateway/dist/index.js';
import { createModelCatalog, createInMemoryGenerateCache } from '../../packages/core/dist/index.js';
import { createMockLanguageModel } from '../../packages/core/dist/testing.js';
const target = { provider: 'gemini', modelId: 'fixture' };
const usage = { inputTokens: 10, outputTokens: 10, totalTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0 };
const catalog = createModelCatalog([{ ...target, inputCostPer1kTokens: 1, outputCostPer1kTokens: 1 }], { snapshotVersion: 'fixture', pricing: { version: '1', currency: 'USD', unit: 'per_1k_tokens' } });
const rows = [];
for (const variant of ['default', 'controls', 'exact-cache', 'shared-misses']) {
  const trials = [];
  for (let trial = 0; trial < 6; trial++) {
    let providerCalls = 0;
    const model = { ...createMockLanguageModel(), ...target, generate: async () => {
      providerCalls++;
      if (variant === 'shared-misses') await new Promise(resolve => setTimeout(resolve, 5));
      return { text: 'correct', messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'correct' }] }], usage, finishReason: 'stop' };
    } };
    const gateway = createGateway({ adapters: { gemini: { name: 'fixture', languageModel: () => model } },
      ...(variant !== 'default' ? {
        timeoutMs: 10000, modelCatalog: catalog, metrics: createGatewayMetrics(), costAccounting: {},
        adaptiveRouting: createGatewayRoutingPolicy('interactive', { latencyMetric: 'total' }),
        admission: createGatewayAdmissionController({ maxConcurrent: 16, maxQueue: 128, requestsPerMinute: 1000, tokensPerMinute: 100000 }),
        budget: { store: createGatewayBudgetStore({ limit: 100, currency: 'USD' }), currency: 'USD', reserveAmount: .1 },
        observerMode: 'background', onAttempt() {}
      } : {}),
      ...(['exact-cache', 'shared-misses'].includes(variant) ? { cache: { scope: 'fixture', store: createInMemoryGenerateCache() } } : {})
    });
    const request = { primary: target, messages: [{ role: 'user', content: 'fixture' }], maxTokens: 20, cacheScope: 'tenant', budgetScope: 'tenant' };
    const cpu = process.cpuUsage(), start = performance.now();
    const run = async () => assert.equal((await gateway.generate(request)).text, 'correct');
    if (variant === 'shared-misses') await Promise.all(Array.from({ length: 100 }, run));
    else for (let i = 0; i < 100; i++) await run();
    await gateway.flushObservers(); await gateway.flushControls();
    const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
    assert.equal(providerCalls, variant === 'default' || variant === 'controls' ? 100 : 1);
    assert.equal(gateway.diagnostics().settlementFailures, 0);
    if (trial) trials.push({ wallMs, cpuMs: (used.user + used.system) / 1000, providerCalls, correctTasks: 100 });
  }
  const sorted = trials.map(value => value.wallMs).sort((a, b) => a - b);
  rows.push({ variant, trials, p50BatchMs: sorted[2], p95BatchMs: sorted[4] });
}
const hashes = {};
for (const file of ['index', 'execution', 'admission', 'budget', 'adaptive-routing', 'metrics', 'operation', 'target']) {
  hashes[file] = createHash('sha256').update(await readFile(new URL(`../../packages/gateway/dist/${file}.js`, import.meta.url))).digest('hex');
}
const report = { mode: 'offline', runtime: process.version, bun: process.versions.bun, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), hashes,
  limitations: ['Synthetic same-prompt batches, 100 tasks, one warmup and five measured trials.', 'Shared misses includes an artificial 5ms upstream wait and concurrent consumers; other variants are sequential.', 'Local host noise and harness work included; no live-provider or competitive performance claim.'], rows };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(rows.map(({ variant, p50BatchMs, p95BatchMs, trials }) => ({ variant, p50BatchMs, p95BatchMs, providerCalls: trials[0].providerCalls })), null, 2));
