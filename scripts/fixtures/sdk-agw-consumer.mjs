import assert from "node:assert/strict";
import { z } from "zod";
import { createAgent, createInMemoryAgentRunStore, runAgentGroup } from "@zhivex-ai/sdk";
import { createGateway } from "@zhivex-ai/gateway";
import { createMockLanguageModel } from "@zhivex-ai/core/testing";

const usage = { inputTokens: 100, cachedInputTokens: 80, cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 5, totalTokens: 120, speed: "fast" };
const text = '{"answer":"ok"}';
const response = { text, messages: [{ role: "assistant", parts: [{ type: "text", text }] }], finishReason: "stop", usage };
for (const operation of ["generate", "generateObject", "streamText", "streamObject"]) {
  const model = createMockLanguageModel({ responses: [response], streamEvents: [[{ type: "text-delta", textDelta: text }, { type: "finish", finishReason: "stop", usage }]] });
  const gateway = createGateway({ adapters: { gemini: { name: "mock", languageModel: () => model } } });
  const request = { primary: { provider: "gemini", modelId: "mock" }, messages: [{ role: "user", content: "hello" }], schema: z.object({ answer: z.string() }) };
  const result = operation.startsWith("stream") ? await gateway[operation](request).collect() : await gateway[operation](request);
  assert.deepEqual(result.usage, { ...usage, estimated: false });
}
const store = createInMemoryAgentRunStore();
const members = ["a", "b"].map(id => ({ agent: createAgent({ id, store, model: createMockLanguageModel({ responses: [response] }) }) }));
const input = { prompt: "hello", idempotencyKey: "installed-group", maxConcurrency: 1 };
const first = await runAgentGroup(members, input);
assert.equal(first.status, "completed");
const ids = first.outputs.map(x => x.output.state.runId);
assert.equal(new Set(ids).size, 2);
const second = await runAgentGroup([...members].reverse(), input);
assert.deepEqual(second.outputs.map(x => x.output.state.runId), ids.reverse());
console.log("INSTALLED_SDK_AGW_FOUNDATIONS_OK");
const { calculateModelCost, createModelCatalog } = await import("@zhivex-ai/sdk");
const { createGatewayMetrics } = await import("@zhivex-ai/gateway");
const catalog = createModelCatalog([{ provider: "gemini", modelId: "fixture", inputCostPer1kTokens: 1, outputCostPer1kTokens: 2 }], { snapshotVersion: "1", pricing: { version: "1", unit: "per_1k_tokens", currency: "USD" } });
assert.equal(calculateModelCost({ catalog, provider: "gemini", modelId: "fixture", usage: { inputTokens: 1000, outputTokens: 1000 }, cacheAssumption: "none" }).amount, 3);
const metrics = createGatewayMetrics();
const metricGateway = createGateway({ adapters: { gemini: { name: "mock", languageModel: () => createMockLanguageModel({ responses: [response] }) } }, metrics, modelCatalog: catalog, costAccounting: {} });
const metricResult = await metricGateway.generate({ primary: { provider: "gemini", modelId: "fixture" }, messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
assert.equal(metrics.snapshot({ provider: "gemini", modelId: "fixture" }).inFlight, 0);
assert.equal(metricResult.attempts[0].cost.status, "unknown"); // fast-tier price is deliberately unavailable
console.log("INSTALLED_SDK_AGW_METRICS_COST_OK");
const { createGatewayCircuitBreaker } = await import("@zhivex-ai/gateway");
const breaker = createGatewayCircuitBreaker({ failureThreshold: 1 });
breaker.acquire({ provider: "gemini", modelId: "fixture" }).end("retryable-error");
assert.equal(breaker.snapshot({ provider: "gemini", modelId: "fixture" }).state, "open");
const configuredModel = createMockLanguageModel({ capabilities: { toolHistory: "native" }, responses: [response] });
const configured = createAgent({ id: "installed-configured", model: configuredModel, contextSchema: z.object({ tenant: z.string() }), store: createInMemoryAgentRunStore() });
const configuredGateway = createGateway({ adapters: { gemini: { name: "mock", languageModel: () => configuredModel } } });
const configuredResult = await configuredGateway.runAgent({ agent: configured, context: { tenant: "installed" }, primary: { provider: "gemini", modelId: "fixture" }, messages: [
  { role: "user", parts: [{ type: "text", text: "continue" }] },
  { role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "old", name: "done", input: {} } }] },
  { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "old", toolName: "done", output: "finished", isError: false } }] }
] });
assert.equal(configuredResult.status, "completed");
assert.ok(configuredResult.state.metadata.gatewayAgentRouteBinding);
console.log("INSTALLED_SDK_AGW_COMPOSITION_OK");
