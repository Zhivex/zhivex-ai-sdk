import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, createAgent, createInMemoryAgentRunStore, createTextMessage, tool } from "../src/index.js";
import { createAgentBudgetCoordinator } from "../src/agent-budget-coordinator.js";
import { createMockLanguageModel } from "../src/testing.js";
const unit = { inputTokens: 8, outputTokens: 2, totalTokens: 10 };
const done = () => ({ text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop" as const, usage: unit });
const call = (id: string, name: string, input: Record<string, string> = {}) => ({ messages: [{ role: "assistant" as const, parts: [{ type: "tool-call" as const, toolCall: { id, name, input } }] }], finishReason: "tool-calls" as const, usage: unit });

describe("PR114 shared budget recovery", () => {
  it.each([
    { fail: false, childTotal: 10 }, { fail: true, childTotal: 10 },
    { fail: false, childTotal: 11 }, { fail: true, childTotal: 11 }
  ])("reserves only remaining child allowance across repeated approval resumes ($fail, total=$childTotal)", async ({ fail, childTotal }) => {
    const childUsage = { ...unit, totalTokens: childTotal };
    const store = createInMemoryAgentRunStore();
    const coordinator = createAgentBudgetCoordinator({ store, budgetId: `approval-${fail}`, limits: { inputTokens: 48, outputTokens: 12, totalTokens: 60 } });
    let childCalls = 0; let toolCalls = 0;
    const child = createAgent({ id: "child", store, maxSteps: 3,
      policy: { budget: { maxInputTokens: 40, maxOutputTokens: 10, maxTotalTokens: 50 }, modelReservation: childUsage },
      tools: { work: tool({ name: "work", schema: z.object({}), requiresApproval: true, approvalMode: "interrupt", execute: () => { toolCalls++; return "worked"; } }) },
      model: { ...createMockLanguageModel(), generate: async () => {
        childCalls++;
        if (fail && childCalls === 2) throw new Error("unknown provider consumption");
        return { ...(childCalls <= 2 ? call(`work-${childCalls}`, "work") : done()), usage: childUsage };
      } }
    });
    const parent = new Agent({ store, maxSteps: 2, subagents: [{ name: "delegate", agent: child }], policy: { budgetCoordinator: coordinator, modelReservation: unit }, model: createMockLanguageModel({ responses: [call("delegate-1", "delegate", { prompt: "work" }), done()] }) });
    let result = await parent.run({ runId: `approval-parent-${fail}`, prompt: "Delegate" });
    expect(result.status).toBe("waiting_approval");
    const originalSubpool = result.state.childRuns![0]!.resumeState!.budgetCoordinatorId;
    const resume = () => parent.resume({ state: result.state, approvals: result.state.pendingApprovals.map(approval => ({ provider: approval.provider, approvalRequestId: approval.id, approve: true })) });
    if (fail) {
      await resume().catch(() => undefined);
      expect(childCalls).toBe(2);
      // Confirmed main and child usage plus the unknown remainder still hold all 60 tokens.
      await expect(coordinator.reserve("unsafe-reuse", unit)).rejects.toThrow("exceeds");
      return;
    }
    result = await resume();
    expect(result.status).toBe("waiting_approval");
    expect(result.state.childRuns![0]!.resumeState!.budgetCoordinatorId).toBe(originalSubpool);
    const concurrentResumes = await Promise.allSettled([resume(), resume()]);
    const completed = concurrentResumes.filter(entry => entry.status === "fulfilled");
    expect(completed).toHaveLength(1);
    expect(concurrentResumes.filter(entry => entry.status === "rejected")).toHaveLength(1);
    result = (completed[0] as PromiseFulfilledResult<typeof result>).value;
    expect(result.status).toBe("completed");
    expect(childCalls).toBe(3);
    expect(toolCalls).toBe(2);
    await expect(coordinator.reserve("remaining", { inputTokens: 8, outputTokens: 2, totalTokens: 60 - 20 - 3 * childTotal })).resolves.toBeUndefined();
    await expect(coordinator.reserve("too-much", unit)).rejects.toThrow("exceeds");
  });

  it.each([false, true])("releases auxiliary admission if checkpoint save fails before dispatch (write-then-throw=%s)", async writeThenThrow => {
    const store = createInMemoryAgentRunStore();
    const coordinator = createAgentBudgetCoordinator({ store, budgetId: `checkpoint-${writeThenThrow}`, limits: unit });
    const originalSave = store.save.bind(store); let failOnce = true; let paidCalls = 0;
    store.save = async (state, options) => {
      if (failOnce && state.compactionAttempts?.[0]?.status === "in-flight") {
        failOnce = false;
        if (writeThenThrow) await originalSave(state, options);
        throw new Error("checkpoint failed before dispatch");
      }
      await originalSave(state, options);
    };
    const agent = new Agent({ model: createMockLanguageModel(), store, policy: { budgetCoordinator: coordinator, modelReservation: unit }, compaction: { maxMessages: 2, auxiliary: { provider: "fixture", modelId: "summary", fingerprint: "v1", reservation: unit }, compactor: () => { paidCalls++; return { summary: "Short", usage: unit }; } } });
    await expect(agent.run({ runId: `checkpoint-${writeThenThrow}`, messages: [createTextMessage("user", "x".repeat(1000)), createTextMessage("assistant", "Before"), createTextMessage("user", "Continue")] })).rejects.toThrow("checkpoint failed before dispatch");
    expect(paidCalls).toBe(0);
    await expect(coordinator.reserve("other-operation", unit)).resolves.toBeUndefined();
    const failedState = (await store.load(`checkpoint-${writeThenThrow}`))!;
    expect(failedState.compactionAttempts?.[0]).toMatchObject({ status: "confirmed", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
    await expect(agent.resume({ state: failedState })).rejects.toThrow();
    expect(paidCalls).toBe(0);
  });
  it("retains shared auxiliary allocation after provider dispatch fails", async () => {
    const store = createInMemoryAgentRunStore();
    const coordinator = createAgentBudgetCoordinator({ store, budgetId: "dispatched", limits: unit });
    let paidCalls = 0;
    const agent = new Agent({ model: createMockLanguageModel(), store, policy: { budgetCoordinator: coordinator, modelReservation: unit }, compaction: { maxMessages: 2, auxiliary: { provider: "fixture", modelId: "summary", fingerprint: "v1", reservation: unit }, compactor: () => { paidCalls++; throw new Error("provider disconnected"); } } });
    await expect(agent.run({ messages: [createTextMessage("user", "x".repeat(1000)), createTextMessage("assistant", "Before"), createTextMessage("user", "Continue")] })).rejects.toThrow();
    expect(paidCalls).toBe(1);
    await expect(coordinator.reserve("unsafe-reuse", unit)).rejects.toThrow("exceeds");
  });

  it("preserves the checkpoint error and reservation when zero-settlement fails", async () => {
    const store = createInMemoryAgentRunStore();
    const coordinator = createAgentBudgetCoordinator({ store, budgetId: "cleanup-failed", limits: unit });
    coordinator.settle = async () => { throw new Error("budget store unavailable"); };
    const originalSave = store.save.bind(store); let failed = false; let paidCalls = 0;
    store.save = async (state, options) => {
      if (!failed && state.compactionAttempts?.[0]?.status === "in-flight") { failed = true; throw new Error("checkpoint write failed"); }
      await originalSave(state, options);
    };
    const agent = new Agent({ model: createMockLanguageModel(), store, policy: { budgetCoordinator: coordinator, modelReservation: unit }, compaction: { maxMessages: 2, auxiliary: { provider: "fixture", modelId: "summary", fingerprint: "v1", reservation: unit }, compactor: () => { paidCalls++; return { summary: "Short", usage: unit }; } } });
    await expect(agent.run({ messages: [createTextMessage("user", "x".repeat(1000)), createTextMessage("assistant", "Before"), createTextMessage("user", "Continue")] })).rejects.toThrow("checkpoint write failed");
    expect(paidCalls).toBe(0);
    await expect(coordinator.reserve("unsafe-reuse", unit)).rejects.toThrow("exceeds");
  });

});
