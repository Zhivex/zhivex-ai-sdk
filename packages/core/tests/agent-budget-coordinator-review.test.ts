import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, createAgent, createFileAgentRunStore, createInMemoryAgentRunStore, createTextMessage, tool } from "../src/index.js";
import { createAgentBudgetCoordinator } from "../src/agent-budget-coordinator.js";
import { createMockLanguageModel } from "../src/testing.js";

const unit = { inputTokens: 8, outputTokens: 2, totalTokens: 10 };
const response = () => ({ text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop" as const, usage: unit });

describe("shared budget runtime integration review", () => {
  it("retains unknown reservations across durable store reopen and competing coordinators", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhivex-budget-reopen-"));
    const make = () => createAgentBudgetCoordinator({
      store: createFileAgentRunStore({ directory }), budgetId: "durable", limits: unit,
      scope: { tenantId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002", namespace: "project" }
    });
    try {
      const competing = await Promise.allSettled([make().reserve("one", unit), make().reserve("two", unit)]);
      expect(competing.filter(result => result.status === "fulfilled"), JSON.stringify(competing.map(result => result.status === "rejected" ? String(result.reason) : "ok"))).toHaveLength(1);
      const admitted = competing[0].status === "fulfilled" ? "one" : "two";
      await expect(make().settle(admitted)).rejects.toThrow("unknown");
      await expect(make().reserve("after-restart", unit)).rejects.toThrow("exceeds");
      await make().settle(admitted, unit);
      await make().settle(admitted, unit);
      await expect(make().reserve("after-confirmation", unit)).rejects.toThrow("exceeds");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("persists coordinator identity before the first primary provider dispatch", async () => {
    const store = createInMemoryAgentRunStore();
    const coordinator = createAgentBudgetCoordinator({ store, budgetId: "first-dispatch", limits: unit });
    const model = { ...createMockLanguageModel(), generate: async () => {
      const persisted = await store.load("primary-binding");
      expect(persisted?.budgetCoordinatorId).toBe(coordinator.id);
      return response();
    } };
    await new Agent({ model, store, policy: { budgetCoordinator: coordinator, modelReservation: unit } }).run({ runId: "primary-binding", prompt: "Hello" });
  });

  it("shares live child reservations with a competing auxiliary run before either provider can overspend", async () => {
    const store = createInMemoryAgentRunStore();
    const limits = { inputTokens: 48, outputTokens: 12, totalTokens: 60 };
    const parentCoordinator = createAgentBudgetCoordinator({ store, budgetId: "child-vs-aux", limits });
    const contenderCoordinator = createAgentBudgetCoordinator({ store, budgetId: "child-vs-aux", limits });
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let releaseChild!: () => void;
    const blocked = new Promise<void>(resolve => { releaseChild = resolve; });
    let childCalls = 0;
    const child = createAgent({ id: "child", store, policy: { budget: { maxInputTokens: 40, maxOutputTokens: 10, maxTotalTokens: 50 }, modelReservation: unit }, model: { ...createMockLanguageModel(), generate: async () => {
      childCalls++; signalStarted(); await blocked; return response();
    } } });
    const parentModel = createMockLanguageModel({ responses: [
      { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "delegate-1", name: "delegate", input: { prompt: "short task" } } }] }], finishReason: "tool-calls", usage: unit }, response()
    ] });
    const parent = new Agent({ model: parentModel, store, maxSteps: 2, subagents: [{ name: "delegate", agent: child }], policy: { budgetCoordinator: parentCoordinator, modelReservation: unit } });
    const running = parent.run({ runId: "parent", prompt: "Delegate" });
    await started;
    let auxiliaryCalls = 0;
    const competing = new Agent({ model: createMockLanguageModel({ responses: [response()] }), store, policy: { budgetCoordinator: contenderCoordinator, modelReservation: unit }, compaction: { maxMessages: 2, keepRecentMessages: 1, auxiliary: { provider: "fixture", modelId: "summary", fingerprint: "v1", reservation: unit }, compactor: () => { auxiliaryCalls++; return { summary: "Short", usage: unit }; } } });
    try {
      await expect(competing.run({ runId: "aux-contender", messages: [createTextMessage("user", "x".repeat(1000)), createTextMessage("assistant", "Earlier"), createTextMessage("user", "Continue")] })).rejects.toThrow("Shared budget reservation exceeds");
      expect(auxiliaryCalls).toBe(0);
    } finally { releaseChild(); }
    const result = await running;
    expect(result.status).toBe("completed");
    expect(childCalls).toBe(1);
    // Two main calls and one child consumed 30; released child headroom is reusable.
    await expect(parentCoordinator.reserve("remaining", { inputTokens: 24, outputTokens: 6, totalTokens: 30 })).resolves.toBeUndefined();
    await expect(parentCoordinator.reserve("over", { inputTokens: 0, outputTokens: 1, totalTokens: 1 })).rejects.toThrow("exceeds");
  });
  it("retains the parent child allocation when a later child model call has unknown consumption", async () => {
    const store = createInMemoryAgentRunStore();
    const coordinator = createAgentBudgetCoordinator({ store, budgetId: "child-late-failure", limits: { inputTokens: 48, outputTokens: 12, totalTokens: 60 } });
    let childCalls = 0;
    const child = createAgent({ id: "child", store, maxSteps: 2,
      policy: { budget: { maxInputTokens: 40, maxOutputTokens: 10, maxTotalTokens: 50 }, modelReservation: unit },
      tools: { work: tool({ name: "work", schema: z.object({}), execute: async () => "worked" }) },
      model: { ...createMockLanguageModel(), generate: async () => {
        childCalls++;
        if (childCalls === 2) throw new Error("provider disconnected after dispatch");
        return { messages: [{ role: "assistant" as const, parts: [{ type: "tool-call" as const, toolCall: { id: "work-1", name: "work", input: {} } }] }], finishReason: "tool-calls" as const, usage: unit };
      } }
    });
    const parent = new Agent({ store, maxSteps: 2, subagents: [{ name: "delegate", agent: child }], policy: { budgetCoordinator: coordinator, modelReservation: unit },
      model: createMockLanguageModel({ responses: [
        { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "delegate-fail", name: "delegate", input: { prompt: "short task" } } }] }], finishReason: "tool-calls", usage: unit }, response()
      ] })
    });
    await parent.run({ runId: "parent-late-failure", prompt: "Delegate" }).catch(() => undefined);
    expect(childCalls).toBe(2);
    // The original main 10 and child 50 allocation must remain held until reconciliation.
    await expect(coordinator.reserve("unsafe-reuse", unit)).rejects.toThrow("exceeds");
  });

});
