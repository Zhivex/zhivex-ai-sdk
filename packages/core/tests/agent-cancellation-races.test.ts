import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { cancelAgentRun, cancelAgentRunTree, ConflictError, createAgent, createInMemoryAgentRunStore, runAgent, streamAgent, type AgentRunState, type AgentRunStore } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";

const state = (runId: string, parentRunId?: string, status: AgentRunState["status"] = "running"): AgentRunState => ({ schemaVersion: 1, runId, parentRunId, status, provider: "test", modelId: "test", messages: [], steps: [], toolResults: [], pendingApprovals: [], currentStep: 0, maxSteps: 2, outputText: "", metadata: { evidence: "keep" } });

describe("durable agent cancellation races", () => {
  for (const streaming of [false, true]) {
    it.each([false, true])(`honors cancellation during pending memory initialization (stream=${streaming}, load fails=%s)`, async failLoad => {
      const store = createInMemoryAgentRunStore();
      const model = createMockLanguageModel();
      const generate = vi.spyOn(model, "generate");
      const stream = vi.spyOn(model, "stream");
      const guardrail = vi.fn(async () => ({ triggered: false }));
      const memory = { load: vi.fn(async ({ runId }: { runId: string }) => {
        await cancelAgentRun(store, runId, { reason: "Cancelled during memory load" });
        if (failLoad) throw new Error("Offline memory load failed");
        return [{ role: "user" as const, parts: [{ type: "text" as const, text: "Remembered context" }] }];
      }), save: vi.fn(() => {}) };
      const agent = createAgent({ model, store, memory, inputGuardrails: [guardrail],
        hookFailurePolicy: { memory: "fail" }, policy: { leaseMode: "disabled" } });
      const input = { runId: "memory-cancellation", idempotencyKey: "memory-claim", prompt: "Work" };
      const invocation = streaming ? streamAgent(agent, input).collect() : runAgent(agent, input);
      await expect(invocation).resolves.toMatchObject({ status: "cancel_requested" });
      expect(await store.load(input.runId)).toMatchObject({ status: "cancel_requested", cancellationReason: "Cancelled during memory load" });
      expect((await store.load(input.runId))?.error).toBeUndefined();
      expect(memory.load).toHaveBeenCalledTimes(1);
      expect(memory.save).not.toHaveBeenCalled();
      expect(guardrail).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    });
  }

  it("retries cancellation after a concurrent checkpoint and preserves its evidence", async () => {
    const store = createInMemoryAgentRunStore(); await store.save(state("parent"));
    const save = store.save.bind(store); let raced = false;
    store.save = async (next, options) => {
      if (!raced && next.status === "cancel_requested") {
        raced = true; const current = await store.load(next.runId);
        await save({ ...current!, outputText: "checkpoint evidence" }, { expectedRevision: current!.revision });
      }
      return save(next, options);
    };
    await expect(cancelAgentRun(store, "parent")).resolves.toMatchObject({ status: "cancel_requested", outputText: "checkpoint evidence" });
  });
  it("bounds retries and propagates persistent conflicts and unrelated errors", async () => {
    const store = createInMemoryAgentRunStore(); await store.save(state("parent"));
    const save = vi.fn(() => { throw new ConflictError("checkpoint race"); }); store.save = save;
    await expect(cancelAgentRun(store, "parent")).rejects.toBeInstanceOf(ConflictError);
    expect(save.mock.calls.length).toBeGreaterThan(1); expect(save.mock.calls.length).toBeLessThanOrEqual(32);
    save.mockImplementation(() => { throw new Error("storage offline"); }); save.mockClear();
    await expect(cancelAgentRun(store, "parent")).rejects.toThrow("storage offline"); expect(save).toHaveBeenCalledTimes(1);
  });
  it("preserves terminal descendants while cancelling active descendants", async () => {
    const store = createInMemoryAgentRunStore(); await store.save(state("parent"));
    for (const status of ["completed", "failed", "cancelled", "timed_out"] as const) await store.save(state(status, "parent", status));
    await store.save(state("active", "completed"));
    const before = await store.findByParentRunId!("parent");
    await cancelAgentRunTree(store, "parent", { mode: "final" });
    for (const terminal of before) expect(await store.load(terminal.runId)).toEqual(terminal);
    expect(await store.load("active")).toMatchObject({ status: "cancelled" });
  });
  it("persists root intent before scanning and recovers a child arriving in the scan", async () => {
    const store = createInMemoryAgentRunStore(); await store.save(state("parent"));
    const find = store.findByParentRunId!.bind(store); let inserted = false;
    store.findByParentRunId = async id => {
      const result = await find(id);
      if (id === "parent" && !inserted) {
        expect(await store.load("parent")).toMatchObject({ status: "cancel_requested" });
        inserted = true; await store.save(state("late", "parent"));
      }
      return result;
    };
    const output = await cancelAgentRunTree(store, "parent");
    expect(output.children).toEqual(expect.arrayContaining([expect.objectContaining({ runId: "late", status: "cancel_requested" })]));
  });
  it.each([false, true])("prevents a late descendant from dispatching a model (stream=%s)", async streaming => {
    const store = createInMemoryAgentRunStore(); await store.save(state("root")); await store.save(state("terminal-parent", "root", "completed"));
    await cancelAgentRunTree(store, "root");
    const model = createMockLanguageModel(); const generate = vi.spyOn(model, "generate"); const stream = vi.spyOn(model, "stream");
    const agent = createAgent({ model, store }); const input = { runId: "late", parentRunId: "terminal-parent", prompt: "do work" };
    const output = streaming ? await streamAgent(agent, input).collect() : await runAgent(agent, input);
    expect(output.status).toBe("cancel_requested");
    expect(generate).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
    expect(await store.load("late")).toMatchObject({ status: "cancel_requested" });
  });
  it("detects cancellation during fresh idempotent child admission", async () => {
    const store = createInMemoryAgentRunStore(); await store.save(state("root"));
    const claim = store.claimIdempotencyKey!.bind(store);
    store.claimIdempotencyKey = async next => { const result = await claim(next); await cancelAgentRunTree(store, "root"); return result; };
    const model = createMockLanguageModel(); const generate = vi.spyOn(model, "generate");
    const output = await runAgent(createAgent({ model, store }), { prompt: "do work", runId: "late", parentRunId: "root", idempotencyKey: "late-claim" });
    expect(output.status).toBe("cancel_requested"); expect(generate).not.toHaveBeenCalled();
  });
  it.each([false, true])("keeps a cancellation checkpoint and paid response when cancellation races model completion (stream=%s)", async streaming => {
    const store = createInMemoryAgentRunStore();
    const usage = { inputTokens: 4, outputTokens: 3, totalTokens: 7 };
    const call = { id: "write-1", name: "write", input: {} };
    const model = createMockLanguageModel();
    model.generate = async () => {
      await cancelAgentRun(store, "running");
      return { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: call }] }], usage, finishReason: "tool-calls" };
    };
    model.stream = async () => (async function* () {
      await cancelAgentRun(store, "running");
      yield { type: "tool-call" as const, toolCall: call };
      yield { type: "finish" as const, usage, finishReason: "tool-calls" as const };
    })();
    const execute = vi.fn(() => "written");
    const agent = createAgent({ model, store, policy: { leaseMode: "disabled" }, tools: { write: { name: "write", schema: z.object({}), execute } } });
    const input = { runId: "running", prompt: "write" };
    const output = streaming ? await streamAgent(agent, input).collect() : await runAgent(agent, input);
    expect(output).toMatchObject({ status: "cancel_requested", usage });
    expect(await store.load("running")).toMatchObject({ status: "cancel_requested", usage, currentStep: 1 });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves durable cancellation when the provider fails before a worker poll (stream=%s)", async streaming => {
    const store = createInMemoryAgentRunStore(); const model = createMockLanguageModel();
    const fail = async () => { await cancelAgentRun(store, "failed-during-cancel"); throw new Error("provider offline"); };
    model.generate = fail; model.stream = fail;
    const agent = createAgent({ model, store, policy: { leaseMode: "disabled" } });
    const input = { runId: "failed-during-cancel", prompt: "work" };
    const output = streaming ? await streamAgent(agent, input).collect() : await runAgent(agent, input);
    expect(output.status).toBe("cancel_requested");
    expect(await store.load("failed-during-cancel")).toMatchObject({ status: "cancel_requested" });
  });

});
