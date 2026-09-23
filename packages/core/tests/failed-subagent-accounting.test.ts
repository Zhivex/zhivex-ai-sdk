import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  cancelAgentRun, createAgent, createSubAgentTool, createFileAgentRunStore, createInMemoryAgentRunStore,
  createTextMessage, getAgentBudgetStatus, runAgent, streamAgent, tool,
  type AgentRunState, type AgentRunStore, type LanguageModel, type GenerateResult
} from "../src/index.js";
import { reconcileChildRuns } from "../src/agent/children.js";

const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
const calls = (names: string[]): GenerateResult => ({
  messages: [{ role: "assistant", parts: names.map((name, index) => ({ type: "tool-call", toolCall: { id: `call-${index}`, name, input: name === "delegate" ? { prompt: "review" } : {} } })) }],
  finishReason: "tool-calls", usage
});
const model = (generate: LanguageModel["generate"]): LanguageModel => ({
  provider: "test", modelId: "fixture",
  capabilities: { streaming: true, tools: true, structuredOutput: false, jsonMode: false, toolChoice: true, parallelToolCalls: true, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false },
  generate,
  async stream(input) {
    const result = await generate(input);
    return (async function* () {
      for (const message of result.messages) for (const part of message.parts) {
        if (part.type === "tool-call") yield { type: "tool-call" as const, toolCall: part.toolCall };
      }
      yield { type: "finish" as const, finishReason: result.finishReason, usage: result.usage };
    })();
  }
});

for (const durable of [false, true]) for (const streaming of [false, true]) {
  it(`preserves 3 + 5 tokens and one failed child (${durable ? "file" : "memory"}, streaming=${streaming})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "child-accounting-"));
    try {
      const store = durable ? createFileAgentRunStore({ directory }) : createInMemoryAgentRunStore();
      const execute = vi.fn(() => "ok");
      const child = createAgent({ id: "child", model: model(async () => calls(["first", "second"])),
        policy: { budget: { maxToolCalls: 1 } }, tools: Object.fromEntries(["first", "second"].map(name => [name, tool({ name, schema: z.object({}), execute })])) });
      const parent = createAgent({ id: "parent", store, model: model(async () => ({ ...calls(["delegate"]), usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } })), subagents: [{ name: "delegate", agent: child }] });
      const input = { runId: "parent", prompt: "go", scope: { tenantId: "one" } };
      await expect(streaming ? streamAgent(parent, input).collect() : runAgent(parent, input)).rejects.toThrow();
      const persisted = await store.load("parent", input.scope);
      expect(persisted?.status).toBe("failed");
      expect(persisted?.childRuns).toHaveLength(1);
      expect(persisted?.childRuns?.[0]).toMatchObject({ status: "failed", parentRunId: "parent", usage });
      expect(execute).not.toHaveBeenCalled();
      expect(getAgentBudgetStatus(persisted!, { includeChildRuns: true }).consumption.totalTokens).toBe(8);
      expect(getAgentBudgetStatus(persisted!, { includeChildRuns: false }).consumption.totalTokens).toBe(3);
      expect(getAgentBudgetStatus(persisted!, {}).unknownUsageRunIds).toEqual([]);
      // Simulate a missing parent link and a fresh store instance after restart.
      const reopened = durable ? createFileAgentRunStore({ directory }) : store;
      persisted!.childRuns = [];
      await reconcileChildRuns(persisted!, reopened);
      await reconcileChildRuns(persisted!, reopened);
      expect(persisted!.childRuns).toHaveLength(1);
      expect(getAgentBudgetStatus(persisted!, {}).consumption.totalTokens).toBe(8);
      expect(execute).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

it("retains provider failure identity even if saving the failure also throws", async () => {
  const base = createInMemoryAgentRunStore();
  const primary = new Error("provider failed");
  const store: AgentRunStore = { ...base, async save(state, options) {
    if (state.status === "failed") throw new Error("save failed");
    return base.save(state, options);
  } };
  const child = createAgent({ store, model: model(async () => { throw primary; }) });
  const onFinish = vi.fn(() => { throw new Error("callback failed"); });
  const delegate = createSubAgentTool({ agent: child, onFinish });
  await expect(delegate.execute!({ prompt: "go" })).rejects.toBe(primary);
  expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: { message: "provider failed" } }));
});

it("deduplicates nested descendants and reports unknown usage without inventing it", async () => {
  const store = createInMemoryAgentRunStore();
  const result = await runAgent(createAgent({ store, model: model(async () => ({ messages: [createTextMessage("assistant", "ok")], usage, finishReason: "stop" })) }), { runId: "root", prompt: "go" });
  const child = { runId: "child", status: "failed" as const, outputText: "", steps: 1, toolCalls: 0, toolErrors: 0, usage };
  const grandchild = { ...child, runId: "grandchild", usage: undefined };
  result.state.childRuns = [{ ...child, childRuns: [grandchild] }, grandchild, child];
  expect(getAgentBudgetStatus(result.state, {}).consumption.totalTokens).toBe(10);
  expect(getAgentBudgetStatus(result.state, {}).unknownUsageRunIds).toEqual(["grandchild"]);
  expect(getAgentBudgetStatus(result.state, { includeChildRuns: false }).unknownUsageRunIds).toEqual([]);
  const foreign: AgentRunState = { ...result.state, runId: "foreign", parentRunId: "root", scope: { tenantId: "other" } };
  await reconcileChildRuns(result.state, { ...store, findByParentRunId: async () => [foreign] });
  expect(result.state.childRuns.some(child => child.runId === "foreign")).toBe(false);
});

for (const outcome of ["success", "provider", "tool", "timeout", "cancel"] as const) {
  it(`keeps terminal linkage for ${outcome} after confirmed usage`, async () => {
    const store = createInMemoryAgentRunStore();
    let requests = 0;
    const child = createAgent({ id: "child", maxSteps: 2,
      policy: { timeoutMs: outcome === "timeout" ? 30 : undefined, cancellationPollMs: 5 },
      model: model(async input => {
        if (++requests === 1) return calls(["work"]);
        if (outcome === "provider") throw new Error("provider failed");
        if (outcome === "timeout" || outcome === "cancel") {
          if (outcome === "cancel") {
            const [state] = await store.findByParentRunId!("parent");
            await cancelAgentRun(store, state.runId, { mode: "final" });
          }
          return await new Promise((_, reject) => {
            if (input.abortSignal?.aborted) reject(input.abortSignal.reason);
            else input.abortSignal?.addEventListener("abort", () => reject(input.abortSignal?.reason), { once: true });
          });
        }
        return { messages: [createTextMessage("assistant", "done")], finishReason: "stop" };
      }),
      tools: { work: tool({ name: "work", schema: z.object({}), execute: () => {
        if (outcome === "tool") throw new Error("tool failed");
        return "ok";
      } }) }
    });
    const parent = createAgent({ store, maxSteps: 1, model: model(async () => calls(["delegate"])), subagents: [{ name: "delegate", agent: child }] });
    await runAgent(parent, { runId: "parent", prompt: "go" });
    const persisted = (await store.load("parent"))!;
    const [storedChild] = await store.findByParentRunId!("parent");
    expect(persisted.childRuns).toHaveLength(1);
    expect(persisted.childRuns![0].status).toBe(storedChild.status);
    expect(storedChild.status).toBe(outcome === "provider" ? "failed" : outcome === "timeout" ? "timed_out" : outcome === "cancel" ? "cancelled" : "completed");
    expect(getAgentBudgetStatus(persisted, {}).consumption.totalTokens).toBe(10);
    if (outcome === "tool") expect(persisted.childRuns![0].toolErrors).toBe(1);
  });
}

it("keeps concurrent children and real grandchildren exactly once", async () => {
  const store = createInMemoryAgentRunStore();
  const leaf = createAgent({ model: model(async () => ({ messages: [createTextMessage("assistant", "ok")], usage, finishReason: "stop" })) });
  const middle = createAgent({ maxSteps: 1, model: model(async () => calls(["delegate"])), subagents: [{ name: "delegate", agent: leaf }] });
  const root = createAgent({ store, maxSteps: 1, toolExecution: { parallel: true, independentOnly: true }, model: model(async () => calls(["delegate", "delegate"])), subagents: [{ name: "delegate", agent: middle }] });
  const result = await runAgent(root, { prompt: "go" });
  expect(result.state.childRuns).toHaveLength(2);
  expect(result.state.childRuns?.every(child => child.childRuns?.length === 1)).toBe(true);
  expect(getAgentBudgetStatus(result.state, {}).consumption.totalTokens).toBe(25);
  await reconcileChildRuns(result.state, store);
  expect(getAgentBudgetStatus(result.state, {}).consumption.totalTokens).toBe(25);
});

it("does not reexecute a failed idempotent child on recovery", async () => {
  const store = createInMemoryAgentRunStore();
  const generate = vi.fn(async () => { throw new Error("original failure"); });
  const onFinish = vi.fn();
  const delegate = createSubAgentTool({ parentRunId: "parent", agent: createAgent({ store, model: model(generate) }), onFinish });
  const context = { toolCall: { id: "call", name: delegate.name, input: { prompt: "go" } }, step: 1 };
  await expect(delegate.execute!({ prompt: "go" }, context)).rejects.toThrow("original failure");
  await expect(delegate.execute!({ prompt: "go" }, context)).rejects.toThrow("original failure");
  expect(generate).toHaveBeenCalledTimes(1);
  expect(onFinish.mock.calls[0][0].runId).toBe(onFinish.mock.calls[1][0].runId);
});

it("keeps confirmed failed usage without a store", async () => {
  const onFinish = vi.fn();
  const execute = vi.fn();
  const delegate = createSubAgentTool({ onFinish, agent: createAgent({
    model: model(async () => calls(["work", "work"])), policy: { budget: { maxToolCalls: 1 } },
    tools: { work: tool({ name: "work", schema: z.object({}), execute }) }
  }) });
  await expect(delegate.execute!({ prompt: "go" })).rejects.toThrow();
  expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", usage }));
  expect(execute).not.toHaveBeenCalled();
});

it("does not replace an observed failed child with an older running checkpoint", async () => {
  const base = createInMemoryAgentRunStore();
  const store: AgentRunStore = { ...base, async save(state, options) {
    if (state.agentId === "child" && state.status === "failed") throw new Error("child save unavailable");
    return base.save(state, options);
  } };
  const child = createAgent({ id: "child", model: model(async () => calls(["work", "work"])), policy: { budget: { maxToolCalls: 1 } }, tools: { work: tool({ name: "work", schema: z.object({}), execute: () => "ok" }) } });
  const parent = createAgent({ store, model: model(async () => calls(["delegate"])), subagents: [{ name: "delegate", agent: child }] });
  await expect(runAgent(parent, { runId: "parent", prompt: "go" })).rejects.toThrow("maxToolCalls");
  const state = (await store.load("parent"))!;
  expect(state.childRuns?.[0]).toMatchObject({ status: "failed", usage });
  expect(getAgentBudgetStatus(state, {}).consumption.totalTokens).toBe(10);
});

it("retains billable response usage if saving that response fails", async () => {
  const base = createInMemoryAgentRunStore();
  let failed = false;
  const store: AgentRunStore = { ...base, async save(state, options) {
    if (!failed && state.agentId === "child" && state.usage) {
      failed = true;
      throw new Error("response checkpoint failed");
    }
    return base.save(state, options);
  } };
  const execute = vi.fn(() => "ok");
  const child = createAgent({ id: "child", model: model(async () => calls(["work"])), tools: { work: tool({ name: "work", schema: z.object({}), execute }) } });
  const parent = createAgent({ store, maxSteps: 1, model: model(async () => calls(["delegate"])), subagents: [{ name: "delegate", agent: child }] });
  const result = await runAgent(parent, { runId: "parent", prompt: "go" });
  expect(result.state.childRuns?.[0]).toMatchObject({ status: "failed", usage });
  expect(getAgentBudgetStatus(result.state, {}).consumption.totalTokens).toBe(10);
  expect(execute).not.toHaveBeenCalled();
});
