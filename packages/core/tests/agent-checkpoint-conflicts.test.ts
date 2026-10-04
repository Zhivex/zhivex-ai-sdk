import { describe, expect, it } from "vitest";
import { cancelAgentRun, ConflictError, createAgent, createInMemoryAgentRunStore, type AgentRunState } from "../src/index.js";
import { claimAgentExecution, persistState } from "../src/agent/state.js";
import { cloneState } from "../src/agent/common.js";
import { createMockLanguageModel } from "../src/testing.js";

const fixture = async () => {
  const store = createInMemoryAgentRunStore();
  const agent = createAgent({ model: createMockLanguageModel(), store });
  const baseline: AgentRunState = { schemaVersion: 1, revision: 0, runId: "checkpoint-race", status: "running",
    provider: "test", modelId: "test", messages: [], steps: [], toolResults: [], pendingApprovals: [],
    currentStep: 0, maxSteps: 3, outputText: "", metadata: { owner: "original" }, startedAt: 1 };
  await claimAgentExecution(agent, baseline);
  const response = (text: string): AgentRunState => {
    const next = cloneState(baseline);
    const message = { role: "assistant" as const, parts: [{ type: "text" as const, text }] };
    const receipt = { toolCallId: text, toolName: "write", output: { receipt: text }, isError: false };
    next.messages = [message];
    next.steps = [{ index: 1, status: "completed", request: { messages: [] }, response: { messages: [message], text }, toolResults: [receipt] }];
    next.toolResults = [receipt];
    next.currentStep = 1;
    next.outputText = text;
    next.usage = { inputTokens: 4, outputTokens: 3, totalTokens: 7 };
    return next;
  };
  return { store, agent, baseline, response };
};

describe("cancellation checkpoint conflict provenance", () => {
  it.each(["request", "final"] as const)("rejects a stale response after another checkpoint and %s cancellation", async mode => {
    const { store, agent, baseline, response } = await fixture();
    const pending = response("stale worker response");
    const newer = response("authoritative response");
    newer.metadata = { owner: "newer", receipt: "confirmed" };
    newer.memory = false;
    newer.usage = { inputTokens: 40, outputTokens: 20, totalTokens: 60 };
    newer.startedAt = 2;
    await store.save(newer, { expectedRevision: baseline.revision });
    await cancelAgentRun(store, baseline.runId, { mode, reason: "Stop" });
    const authoritative = await store.load(baseline.runId);
    await expect(persistState(agent, pending, undefined, baseline)).rejects.toBeInstanceOf(ConflictError);
    expect(await store.load(baseline.runId)).toEqual(authoritative);
  });

  it.each(["cancel_requested", "cancelled"] as const)("rejects an overlapping response atomically saved with %s", async status => {
    const { store, agent, baseline, response } = await fixture();
    const newer = response("other worker response");
    await store.save({ ...newer, status, cancelledAt: 100, cancellationReason: "Stop" }, { expectedRevision: baseline.revision });
    const authoritative = await store.load(baseline.runId);
    await expect(persistState(agent, response("pending response"), undefined, baseline)).rejects.toBeInstanceOf(ConflictError);
    expect(await store.load(baseline.runId)).toEqual(authoritative);
  });

  it.each(["cancel_requested", "cancelled"] as const)("preserves memory:false even when it is the only non-cancellation change (%s)", async status => {
    const { store, agent, baseline, response } = await fixture();
    await store.save({ ...baseline, memory: false, status, cancelledAt: 100 }, { expectedRevision: baseline.revision });
    const authoritative = await store.load(baseline.runId);
    await expect(persistState(agent, response("pending response"), undefined, baseline)).rejects.toBeInstanceOf(ConflictError);
    expect(await store.load(baseline.runId)).toEqual(authoritative);
  });

  it.each(["request", "final"] as const)("retains confirmed response evidence for a proven %s cancellation-only transition", async mode => {
    const { store, agent, baseline, response } = await fixture();
    const pending = response("confirmed response");
    await cancelAgentRun(store, baseline.runId, { mode, reason: "Stop" });
    await persistState(agent, pending, undefined, baseline);
    expect(await store.load(baseline.runId)).toMatchObject({ status: mode === "final" ? "cancelled" : "cancel_requested",
      cancellationReason: "Stop", messages: pending.messages, steps: pending.steps, toolResults: pending.toolResults, usage: pending.usage });
  });

  it("does not trust a mutable worker object as the saved baseline", async () => {
    const { store, agent, baseline, response } = await fixture();
    const pending = response("pending response");
    baseline.metadata = { owner: "changed after save" };
    await store.save({ ...baseline, status: "cancel_requested", cancelledAt: 100 }, { expectedRevision: baseline.revision });
    const authoritative = await store.load(baseline.runId);
    await expect(persistState(agent, pending, undefined, baseline)).rejects.toBeInstanceOf(ConflictError);
    expect(await store.load(baseline.runId)).toEqual(authoritative);
  });

  it("rejects an untracked or foreign-store baseline", async () => {
    const first = await fixture();
    const second = await fixture();
    await cancelAgentRun(second.store, second.baseline.runId);
    const authoritative = await second.store.load(second.baseline.runId);
    for (const baseline of [cloneState(second.baseline), first.baseline]) {
      await expect(persistState(second.agent, second.response("pending response"), undefined, baseline)).rejects.toBeInstanceOf(ConflictError);
      expect(await second.store.load(second.baseline.runId)).toEqual(authoritative);
    }
  });

  it("rejects a revision gap even if the final non-cancellation fields match the old baseline", async () => {
    const { store, agent, baseline, response } = await fixture();
    await store.save(baseline, { expectedRevision: baseline.revision });
    await cancelAgentRun(store, baseline.runId);
    const authoritative = await store.load(baseline.runId);
    await expect(persistState(agent, response("pending response"), undefined, baseline)).rejects.toBeInstanceOf(ConflictError);
    expect(await store.load(baseline.runId)).toEqual(authoritative);
  });

  it.each([false, true])("rechecks the full baseline after every retry (intervening checkpoint=%s)", async intervening => {
    const { store, agent, baseline, response } = await fixture();
    const save = store.save.bind(store);
    let conflicts = 0;
    let authoritative: AgentRunState | undefined;
    store.save = async (next, options) => {
      if (next.outputText === "pending response" && conflicts < 3) {
        const current = (await store.load(next.runId))!;
        conflicts++;
        const replacement = { ...current, status: "cancel_requested" as const, cancelledAt: 100,
          cancellationReason: `Intent ${conflicts}`, ...(intervening && conflicts === 2 ? { memory: false as const, metadata: { owner: "newer" } } : {}) };
        await save(replacement, { expectedRevision: current.revision });
        authoritative = await store.load(next.runId);
      }
      await save(next, options);
    };
    const pending = response("pending response");
    if (intervening) {
      await expect(persistState(agent, pending, undefined, baseline)).rejects.toBeInstanceOf(ConflictError);
      expect(conflicts).toBe(2);
      expect(await store.load(baseline.runId)).toEqual(authoritative);
    } else {
      await persistState(agent, pending, undefined, baseline);
      expect(conflicts).toBe(3);
      expect(await store.load(baseline.runId)).toMatchObject({ status: "cancel_requested", cancellationReason: "Intent 3", usage: pending.usage, steps: pending.steps });
    }
  });

  it("bounds repeated cancellation-only conflicts without accepting an unconfirmed write", async () => {
    const { store, agent, baseline, response } = await fixture();
    const save = store.save.bind(store);
    let attempts = 0;
    store.save = async (next, options) => {
      attempts++;
      const current = (await store.load(next.runId))!;
      await save({ ...current, status: "cancel_requested", cancelledAt: 100, cancellationReason: `Intent ${attempts}` }, { expectedRevision: current.revision });
      await save(next, options);
    };
    await expect(persistState(agent, response("pending response"), undefined, baseline)).rejects.toBeInstanceOf(ConflictError);
    expect(attempts).toBe(8);
    expect(await store.load(baseline.runId)).toMatchObject({ status: "cancel_requested", outputText: "", currentStep: 0, steps: [] });
  });
});
