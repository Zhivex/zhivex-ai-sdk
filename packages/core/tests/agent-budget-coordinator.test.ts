import { describe, expect, it } from "vitest";
import { createAgentBudgetCoordinator } from "../src/agent-budget-coordinator.js";
import { Agent, createInMemoryAgentRunStore, createTextMessage } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";
const tokens = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
describe("CAS shared token admission", () => {
  it("persists independent remainder ceilings while validating receipts and retaining unknown usage", async () => {
    const store = createInMemoryAgentRunStore();
    const limits = { inputTokens: 40, outputTokens: 10, totalTokens: 50 };
    const reopen = () => createAgentBudgetCoordinator({ store, budgetId: "remainder", limits });
    const budget = reopen();
    await budget.reserve("first", { inputTokens: 8, outputTokens: 2, totalTokens: 11 });
    await budget.settle("first", { inputTokens: 8, outputTokens: 2, totalTokens: 11 });
    const remaining = { inputTokens: 32, outputTokens: 8, totalTokens: 39 };
    await budget.reserve("remaining", remaining);
    await expect(reopen().settle("remaining", remaining)).rejects.toThrow("ceilings");
    await expect(reopen().settle("remaining")).rejects.toThrow("unknown");
    for (const dimension of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      await expect(reopen().reserve(`over-${dimension}`, {
        inputTokens: 0, outputTokens: 0, totalTokens: 0, [dimension]: 1
      })).rejects.toThrow(`exceeds ${dimension}`);
    }
    await reopen().settle("remaining", { inputTokens: 8, outputTokens: 2, totalTokens: 11 });
    await reopen().reserve("released", { inputTokens: 24, outputTokens: 6, totalTokens: 28 });
    await expect(reopen().reserve("over-total", { inputTokens: 0, outputTokens: 0, totalTokens: 1 })).rejects.toThrow("exceeds totalTokens");
  });

  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid ceilings (%s)", async invalid => {
    const budget = createAgentBudgetCoordinator({ store: createInMemoryAgentRunStore(), budgetId: "invalid", limits: tokens });
    for (const dimension of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      await expect(budget.reserve(dimension, { ...tokens, [dimension]: invalid })).rejects.toThrow("ceilings");
    }
  });

  it("admits only one competing reservation across independent coordinators", async () => {
    const store = createInMemoryAgentRunStore();
    const a = createAgentBudgetCoordinator({ store, budgetId: "race", limits: tokens });
    const b = createAgentBudgetCoordinator({ store, budgetId: "race", limits: tokens });
    const results = await Promise.allSettled([a.reserve("child", tokens), b.reserve("aux", tokens)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("retains unknown allocations, settles idempotently and snapshots limits", async () => {
    const store = createInMemoryAgentRunStore(); const limits = { ...tokens };
    const budget = createAgentBudgetCoordinator({ store, budgetId: "unknown", limits });
    limits.totalTokens = 10000;
    await budget.reserve("one", tokens);
    await expect(budget.settle("one")).rejects.toThrow("unknown");
    await expect(budget.reserve("two", { inputTokens: 0, outputTokens: 1, totalTokens: 1 })).rejects.toThrow("exceeds");
    await budget.settle("one", { inputTokens: 40, outputTokens: 5, totalTokens: 45 });
    await budget.settle("one", { inputTokens: 40, outputTokens: 5, totalTokens: 45 });
    await budget.reserve("two", { inputTokens: 60, outputTokens: 15, totalTokens: 75 });
  });
  it("counts primary and auxiliary reservations in the same pool", async () => {
    const store = createInMemoryAgentRunStore();
    const coordinator = createAgentBudgetCoordinator({ store, budgetId: "both", limits: { inputTokens: 140, outputTokens: 25, totalTokens: 165 } });
    const model = createMockLanguageModel({ responses: [{ text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop", usage: tokens }] });
    const auxiliary = { inputTokens: 40, outputTokens: 5, totalTokens: 45 };
    const agent = new Agent({ model, store, policy: { budgetCoordinator: coordinator, modelReservation: tokens }, compaction: { maxMessages: 2, auxiliary: { provider: "fixture", modelId: "summary", fingerprint: "v1", reservation: auxiliary }, compactor: () => ({ summary: "Short", usage: auxiliary }) } });
    const result = await agent.run({ messages: [createTextMessage("user", "x".repeat(1000)), createTextMessage("assistant", "old"), createTextMessage("user", "Continue")] });
    expect(result.usage).toEqual({ inputTokens: 140, outputTokens: 25, totalTokens: 165 });
    await expect(coordinator.reserve("extra", { inputTokens: 0, outputTokens: 1, totalTokens: 1 })).rejects.toThrow("exceeds");
  });
  it("isolates shared allocations from ordinary run retention", async () => {
    const store = createInMemoryAgentRunStore();
    const scope = { tenantId: "tenant", userId: "u", namespace: "runs" };
    const coordinator = createAgentBudgetCoordinator({ store, budgetId: "retained", scope, limits: tokens });
    await coordinator.reserve("pending", tokens);
    await store.deleteExpired!({ before: Date.now() + 1000, statuses: ["completed"] }, scope);
    const reloaded = createAgentBudgetCoordinator({ store, budgetId: "retained", scope, limits: tokens });
    await expect(reloaded.reserve("second", tokens)).rejects.toThrow("exceeds");
  });

});
