// Measures agent tool loops whose history grows by one 4 KiB tool result per
// step, with and without the in-memory run store. Run after `bun run build`.
import { z } from "zod";
import { createAgent, createInMemoryAgentRunStore, createTextMessage, runAgent, tool } from "../../packages/core/dist/index.js";
import { createMockLanguageModel } from "../../packages/core/dist/testing.js";

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
const payload = "a".repeat(4096);

const runOnce = async (steps, withStore) => {
  const model = createMockLanguageModel();
  let calls = 0;
  model.generate = async () => (++calls < steps)
    ? { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: `call-${calls}`, name: "inspect", input: {} } }] }], finishReason: "tool-calls", usage }
    : { text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop", usage };
  const agent = createAgent({
    id: "checkpoint-scaling", model, maxSteps: steps,
    store: withStore ? createInMemoryAgentRunStore() : undefined,
    policy: { maxStateBytes: 256 * 1024 * 1024 },
    tools: { inspect: tool({ name: "inspect", schema: z.object({}), execute: () => payload }) }
  });
  const result = await runAgent(agent, { prompt: payload });
  if (result.status !== "completed" || result.outputText !== "done" || result.steps.length !== steps) {
    throw new Error(`Unexpected agent result: ${result.status}`);
  }
};

const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const withStore of [false, true]) {
  for (const steps of [50, 100, 200]) {
    await runOnce(steps, withStore);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await runOnce(steps, withStore);
      samples.push(performance.now() - start);
    }
    results.push({ store: withStore ? "in-memory" : "none", steps, medianMs: +median(samples).toFixed(1) });
  }
}
console.log(JSON.stringify({ runtime: `node ${process.version}`, results }, null, 2));
