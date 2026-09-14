import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, createInMemoryAgentRunStore, runAgent, tool } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";
const text = { text: "done", messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "done" }] }], finishReason: "stop" as const };
it("overlaps declared ordinary tools but treats subagents as serial barriers", async () => {
  let active = 0, peak = 0, started = 0;
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const order: string[] = [];
  const read = (name: string) => tool({ name, independent: true, schema: z.object({}), execute: async () => {
    active++; peak = Math.max(peak, active); order.push(name); if (++started === 2) release(); await barrier; active--; return name;
  } });
  const childModel = createMockLanguageModel(); childModel.generate = async () => { expect(active).toBe(0); order.push("child"); return text; };
  const child = createAgent({ id: "child", model: childModel });
  const model = createMockLanguageModel({ responses: [{ messages: [{ role: "assistant", parts: ["a", "b", "child"].map(name => ({ type: "tool-call", toolCall: { id: name, name, input: name === "child" ? { prompt: "child task" } : {} } })) }], finishReason: "tool-calls" }, text] });
  const store = createInMemoryAgentRunStore();
  const agent = createAgent({ id: "parent", model, store, subagents: [{ name: "child", agent: child }], tools: { a: read("a"), b: read("b") }, toolExecution: { parallel: true, independentOnly: true, maxConcurrency: 2 }, maxSteps: 2 });
  const result = await runAgent(agent, { prompt: "do tasks" });
  expect(result.status).toBe("completed"); expect(peak).toBe(2); expect(order).toEqual(["a", "b", "child"]);
  expect(result.toolResults.map(x => x.toolName)).toEqual(["a", "b", "child"]);
  const resumed = await runAgent(agent, { runId: result.state.runId });
  expect(resumed.status).toBe("completed"); expect(order).toHaveLength(3);
});
it("preflights approvals before starting independent work", async () => {
  const execute = vi.fn(() => "done");
  const model = createMockLanguageModel({ responses: [{ messages: [{ role: "assistant", parts: ["a", "b"].map(name => ({ type: "tool-call", toolCall: { id: name, name, input: {} } })) }], finishReason: "tool-calls" }] });
  const agent = createAgent({ model, maxSteps: 2, subagents: [{ name: "child", agent: createAgent({ model: createMockLanguageModel() }) }], tools: {
    a: tool({ name: "a", independent: true, schema: z.object({}), execute }),
    b: tool({ name: "b", independent: true, schema: z.object({}), requiresApproval: true, approvalMode: "interrupt", execute })
  }, toolExecution: { parallel: true, independentOnly: true, maxConcurrency: 2 } });
  expect((await runAgent(agent, { prompt: "do tasks" })).status).toBe("waiting_approval");
  expect(execute).not.toHaveBeenCalled();
});

it("preserves completed independent tool journals across a failed checkpoint", async () => {
  const store = createInMemoryAgentRunStore(), save = store.save.bind(store);
  let crash = true;
  store.save = async (state, options) => { if (crash && state.toolResults.length === 2) { crash = false; throw new Error("checkpoint crash"); } return save(state, options); };
  const a = vi.fn(() => "a"), b = vi.fn(() => "b");
  const model = createMockLanguageModel({ responses: [{ messages: [{ role: "assistant", parts: ["a", "b"].map(name => ({ type: "tool-call", toolCall: { id: name, name, input: {} } })) }], finishReason: "tool-calls" }, text] });
  const agent = createAgent({ id: "restart-independent", model, store, maxSteps: 2, tools: { a: tool({ name: "a", independent: true, schema: z.object({}), execute: a }), b: tool({ name: "b", independent: true, schema: z.object({}), execute: b }) }, subagents: [{ name: "child", agent: createAgent({ model: createMockLanguageModel() }) }], toolExecution: { parallel: true, independentOnly: true, maxConcurrency: 2 } });
  await expect(runAgent(agent, { prompt: "hello", runId: "restart-run" })).rejects.toThrow("checkpoint crash");
  expect((await runAgent(agent, { runId: "restart-run" })).status).toBe("completed");
  expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1);
});
