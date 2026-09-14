import { expect, it } from "vitest";
import { createAgent, createInMemoryAgentRunStore, runAgent, ValidationError } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";
const response = { text: "done", messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "done" }] }], finishReason: "stop" as const };
it("hands isolated snapshots and the next revision to the store", async () => {
  const store = createInMemoryAgentRunStore(), save = store.save.bind(store);
  const revisions: number[] = [];
  store.save = async (state, options) => {
    expect(state.revision).toBe(options!.expectedRevision! + 1); revisions.push(state.revision!);
    await save(state, options); state.messages.length = 0; state.outputText = "mutated store argument";
  };
  const result = await runAgent(createAgent({ model: createMockLanguageModel({ responses: [response] }), store }), { prompt: "hello" });
  expect(result.outputText).toBe("done"); expect(result.messages.length).toBeGreaterThan(0);
  expect(result.state.revision).toBe(revisions.at(-1));
});
it("rejects an oversized checkpoint before passing its serialized representation to the store", async () => {
  const store = createInMemoryAgentRunStore(), save = store.save.bind(store);
  const limit = 1000; const sizes: number[] = [];
  store.save = async (state, options) => { const bytes = Buffer.byteLength(JSON.stringify(state)); sizes.push(bytes); expect(bytes).toBeLessThanOrEqual(limit); return save(state, options); };
  const agent = createAgent({ model: createMockLanguageModel({ responses: [{ ...response, messages: [{ role: "assistant", parts: [{ type: "text", text: "x".repeat(5000) }] }], text: "x".repeat(5000) }] }), store, policy: { maxStateBytes: limit } });
  await expect(runAgent(agent, { prompt: "hello" })).rejects.toBeInstanceOf(ValidationError);
  expect(sizes.length).toBeGreaterThan(0);
});
