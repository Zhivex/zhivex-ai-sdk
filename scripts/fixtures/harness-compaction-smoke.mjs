import assert from "node:assert/strict";
import { Agent } from "@zhivex-ai/agents";
import { createTextMessage } from "@zhivex-ai/sdk";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
const store = createInMemoryAgentRunStore();
const usage = { inputTokens: 40, outputTokens: 5, totalTokens: 45 };
let calls = 0;
const agent = new Agent({
  model: createMockLanguageModel(), store,
  compaction: {
    maxMessages: 2, keepRecentMessages: 1,
    auxiliary: { provider: "fixture", modelId: "summary", fingerprint: "v1", reservation: usage },
    compactor: () => { calls++; return { summary: "", usage }; }
  }
});
await assert.rejects(agent.run({ runId: "consumer-compaction", messages: [createTextMessage("user", "x".repeat(1000)), createTextMessage("assistant", "Previous answer"), createTextMessage("user", "Continue")] }), /empty summary/);
const state = await store.load("consumer-compaction");
assert.deepEqual(state.usage, usage);
assert.equal(state.compactionAttempts[0].status, "confirmed");
await assert.rejects(agent.resume({ state }), /already attempted/);
assert.equal(calls, 1);
console.log("durable auxiliary receipt consumer smoke passed");
