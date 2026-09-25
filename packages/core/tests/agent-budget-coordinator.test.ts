import { describe, expect, it } from "vitest";
import { createAgentBudgetCoordinator } from "../src/agent-budget-coordinator.js";
import { Agent, createInMemoryAgentRunStore, createTextMessage } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";
const tokens = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
describe("CAS shared token admission", () => {
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
