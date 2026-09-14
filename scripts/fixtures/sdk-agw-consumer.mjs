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
const input = { prompt: "hello", idempotencyKey: "installed-group" };
const first = await runAgentGroup(members, input);
assert.equal(first.status, "completed");
const ids = first.outputs.map(x => x.output.state.runId);
assert.equal(new Set(ids).size, 2);
const second = await runAgentGroup([...members].reverse(), input);
assert.deepEqual(second.outputs.map(x => x.output.state.runId), ids.reverse());
console.log("INSTALLED_SDK_AGW_FOUNDATIONS_OK");
