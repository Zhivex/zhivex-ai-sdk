import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Agent, applySafetyPolicyToAgent, cancelAgentRun, createInMemoryAgentRunStore, createFileAgentRunStore, createMockLanguageModel,
  createProductionSafetyPolicy, generateText, normalizeAgentRunState, streamText, tool
} from "../src/index.js";
import { createAgentAbortContext } from "../src/agent/lifecycle.js";
import { withTimeoutSignal } from "../src/runtime.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const call = (id: number) => ({ id: `call-${id}`, name: "read", input: {} });
const tools = { read: tool({ name: "read", schema: z.object({}), execute: () => "ok" }) };
const model = (count = 12) => createMockLanguageModel({
  responses: Array.from({ length: count + 1 }, (_, i) => i < count
    ? { messages: [{ role: "assistant" as const, parts: [{ type: "tool-call" as const, toolCall: call(i) }] }], finishReason: "tool-calls" as const }
    : { text: "done", finishReason: "stop" as const }),
  streamEvents: Array.from({ length: count + 1 }, (_, i) => [
    ...(i < count ? [{ type: "tool-call" as const, toolCall: call(i) }] : [{ type: "text-delta" as const, textDelta: "done" }]),
    { type: "finish" as const, finishReason: i < count ? "tool-calls" as const : "stop" as const }
  ])
});

describe("explicit unlimited cumulative steps", () => {
  it.each([false, true])("runs beyond existing defaults, streaming=%s", async streaming => {
    const options = { model: model(), tools, prompt: "read", maxSteps: "unlimited" as const, timeoutMs: 500, toolExecution: { timeoutMs: 500 } };
    const output = streaming ? await streamText(options).collect() : await generateText(options);
    expect(output.text).toBe("done");
    expect(output.steps).toHaveLength(13);
    expect(output.steps.every(step => step.request.timeoutMs === 500)).toBe(true);
  });

  it.each([undefined, 2])("preserves the bounded/default ceiling %s", async maxSteps => {
    const output = await generateText({ model: model(), tools, prompt: "read", maxSteps });
    expect(output.steps).toHaveLength(maxSteps ?? 1);
    const result = await new Agent({ model: model(), tools, maxSteps }).run({ prompt: "read" });
    expect(result.status).toBe("failed");
    expect(result.state.currentStep).toBe(maxSteps ?? 1);
  });

  it.each([0, -1, 1.5, Infinity, NaN, null, "infinite", "12", {}])("rejects malformed opt-in %s before dispatch", async value => {
    const provider = model();
    const spy = vi.spyOn(provider, "generate");
    await expect(generateText({ model: provider, prompt: "read", maxSteps: value as any })).rejects.toThrow(/maxSteps/);
    await expect(new Agent({ model: provider }).run({ prompt: "read", maxSteps: value as any })).rejects.toThrow(/maxSteps/);
    expect(() => streamText({ model: provider, prompt: "read", maxSteps: value as any })).toThrow(/maxSteps/);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([false, true])("allows cancellation of an unbounded loop, streaming=%s", async streaming => {
    const controller = new AbortController();
    const options = { model: model(), tools, prompt: "read", maxSteps: "unlimited" as const, abortSignal: controller.signal,
      onBeforeModelStep: ({ step }: { step: number }) => { if (step === 3) controller.abort(new Error("user-stop")); } };
    await expect(streaming ? streamText(options).collect() : generateText(options)).rejects.toThrow("user-stop");
  });

  it.each([false, true])("preserves compaction, telemetry and explicit budgets, streaming=%s", async streaming => {
    const agent = new Agent({ model: model(), tools, maxSteps: "unlimited",
      compaction: { maxMessages: 5, keepRecentMessages: 2, compactor: () => ({ summary: "Earlier reads" }) } });
    const output = streaming ? await agent.stream({ prompt: "read" }).collect() : await agent.run({ prompt: "read" });
    expect(output.status).toBe("completed");
    expect(output.state.maxSteps).toBe("unlimited");
    expect(output.state.currentStep).toBe(13);
    expect(output.state.compactions!.length).toBeGreaterThan(0);
    expect(normalizeAgentRunState(JSON.parse(JSON.stringify(output.state))).maxSteps).toBe("unlimited");
    const bounded = new Agent({ model: model(), tools, maxSteps: "unlimited", policy: { budget: { maxSteps: 2 } } });
    await expect(bounded.run({ prompt: "read" })).rejects.toThrow(/budget/i);
    const safe = applySafetyPolicyToAgent({ model: model(), maxSteps: "unlimited" }, createProductionSafetyPolicy());
    expect(typeof safe.maxSteps).toBe("number");
  });

  it.each([1, "unlimited"] as const)("retains child-specific step ceilings %s", async childMaxSteps => {
    const child = new Agent({ model: model(2), tools, maxSteps: childMaxSteps });
    const parentModel = createMockLanguageModel({ responses: [
      { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "delegate-1", name: "delegate", input: { prompt: "read" } } }] }], finishReason: "tool-calls" },
      { text: "done", finishReason: "stop" }
    ] });
    const output = await new Agent({ model: parentModel, maxSteps: "unlimited", subagents: [{ name: "delegate", agent: child }] }).run({ prompt: "delegate" });
    expect(output.state.childRuns?.[0]?.steps).toBe(childMaxSteps === "unlimited" ? 3 : 1);
    expect(output.state.childRuns?.[0]?.status).toBe(childMaxSteps === "unlimited" ? "completed" : "failed");
  });

  it("persists explicit opt-in across approval pause, store reopen and resume without repeating effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unlimited-agent-"));
    let effects = 0;
    const approvedTools = { read: tool({ name: "read", schema: z.object({}), requiresApproval: true, approvalMode: "interrupt", execute: () => ++effects }) };
    try {
      const first = await new Agent({ model: model(1), tools: approvedTools, maxSteps: "unlimited", store: createFileAgentRunStore({ directory }) }).run({ prompt: "read", runId: "unbounded" });
      expect(first.status).toBe("waiting_approval");
      expect(effects).toBe(0);
      const store = createFileAgentRunStore({ directory });
      const state = (await store.load("unbounded"))!;
      expect(state.maxSteps).toBe("unlimited");
      const resumed = await new Agent({ model: model(0), tools: approvedTools, store }).resume({ state,
        approvals: state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) });
      expect(resumed.status).toBe("completed");
      expect(resumed.state.currentStep).toBe(2);
      expect(resumed.state.maxSteps).toBe("unlimited");
      expect(effects).toBe(1);
      for (const maxSteps of [null, Infinity, "infinite", 0]) {
        expect(() => normalizeAgentRunState({ ...resumed.state, maxSteps } as any)).toThrow(/maxSteps/);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([false, true])("retains final cancellation reason and checkpoint, streaming=%s", async streaming => {
    const store = createInMemoryAgentRunStore();
    const stoppingTools = { read: tool({ name: "read", schema: z.object({}), execute: async () => {
      await cancelAgentRun(store, "stop-unlimited", { mode: "final", reason: "Operator stopped task" });
      return "read";
    } }) };
    const agent = new Agent({ model: model(), store, tools: stoppingTools, maxSteps: "unlimited" });
    const input = { prompt: "read", runId: "stop-unlimited" };
    const result = streaming ? await agent.stream(input).collect() : await agent.run(input);
    expect(result.status).toBe("cancelled");
    const state = await store.load(input.runId);
    expect(state).toMatchObject({ status: "cancelled", maxSteps: "unlimited", cancellationReason: "Operator stopped task" });
    expect(state!.currentStep).toBeGreaterThanOrEqual(1);
    expect(state!.steps).toHaveLength(state!.currentStep);
  });

  it("retains a finite run-policy timeout with unlimited steps", async () => {
    const provider = { ...model(), generate: () => new Promise<never>(() => {}) };
    await expect(new Agent({ model: provider, maxSteps: "unlimited", policy: { timeoutMs: 5 } }).run({ prompt: "wait" })).resolves.toMatchObject({ status: "timed_out", state: { maxSteps: "unlimited" } });
  });

  it("omission already disables only the run-policy timer, retaining cancellation and finite operation validation", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const context = createAgentAbortContext(controller.signal, {});
    try {
      vi.advanceTimersByTime(2 * 86400000);
      expect(context.timeoutPromise).toBeUndefined();
      expect(context.signal?.aborted).toBe(false);
      controller.abort();
      expect(context.signal?.aborted).toBe(true);
      for (const timeoutMs of [Infinity, 86400001, "unlimited", null]) {
        expect(() => withTimeoutSignal({ timeoutMs: timeoutMs as any })).toThrow(/timeoutMs/);
      }
    } finally { context.cleanup(); vi.useRealTimers(); }
  });
});
