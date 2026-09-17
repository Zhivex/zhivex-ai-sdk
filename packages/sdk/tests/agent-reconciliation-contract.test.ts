import { normalizeAgentRunState } from "../../core/src/index.js";
import { expect, it } from "vitest";
import { createAgent, createInMemoryAgentRunStore, createTextMessage, reconcileAgentToolExecution, runAgentEvaluation, type AgentRunState, type AgentTaskOutcome, type AgentToolReconciliationEvidence, type LanguageModel } from "../src/index.js";
import { reconcileAgentToolExecution as facade } from "../../agents/src/beta.js";
it("exports reconciliation and excludes completed pending tasks from evaluations", async () => {
  expect(facade).toBe(reconcileAgentToolExecution);
  const taskOutcome: AgentTaskOutcome = { status: "needs_reconciliation", operations: [{ toolCallId: "t", toolName: "write", idempotencyKey: "key", diagnosticCode: "INDETERMINATE_TOOL_EXECUTION" }] };
  const state: AgentRunState = { schemaVersion: 1, runId: "r", provider: "test", modelId: "test", status: "completed", messages: [], steps: [], toolResults: [], currentStep: 0, maxSteps: 2, outputText: "done", pendingApprovals: [], taskOutcome };
  const store = createInMemoryAgentRunStore();
  await store.save(state);
  const evidence: AgentToolReconciliationEvidence = { operationId: "op", runId: "r", toolCallId: "t", toolName: "write", idempotencyKey: "key", input: {}, output: true, source: "audit", proof: "receipt" };
  await store.claimToolExecution!({ ...evidence, revision: 0, updatedAt: Date.now(), status: "pending" });
  const model = { provider: "test", modelId: "test", capabilities: {}, generate: async () => ({ messages: [createTextMessage("assistant", "done")], text: "done", finishReason: "stop" }) } as LanguageModel;
  const evaluation = await runAgentEvaluation([{ name: "pending", input: { state } }], { agent: createAgent({ model, store }) });
  expect(evaluation.ok).toBe(false);
  expect(evaluation.cases[0]?.output.status).toBe("completed");
  expect(normalizeAgentRunState(JSON.parse(JSON.stringify(state))).taskOutcome).toEqual(taskOutcome);
  expect(() => normalizeAgentRunState({ ...state, taskOutcome: { status: "resolved", operations: taskOutcome.operations } })).toThrow();
});
