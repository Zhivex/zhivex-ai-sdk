import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, createFileAgentRunStore, createInMemoryAgentRunStore, createTextMessage, normalizeAgentRunState, reconcileAgentToolExecution, runAgent, tool, type AgentRunState, type AgentRunStore, type AgentToolReconciliationEvidence, type LanguageModel } from "../src/index.js";
import { refreshAgentTaskOutcome } from "../src/agent-reconciliation.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const base = (): AgentRunState => ({ schemaVersion: 1, runId: "run", provider: "fixture", modelId: "fixture", status: "completed", messages: [], steps: [], toolResults: [], currentStep: 0, maxSteps: 8, outputText: "tool_error", pendingApprovals: [] });
async function fixture(file = false) {
  const directory = file ? await mkdtemp(join(tmpdir(), "reconcile-")) : undefined;
  if (directory) directories.push(directory);
  const store = directory ? createFileAgentRunStore({ directory }) : createInMemoryAgentRunStore();
  await store.save(base());
  await store.claimToolExecution!({ runId: "run", toolCallId: "durable", providerToolCallId: "provider", toolName: "mutate", idempotencyKey: "run:durable", input: { operation_id: "op" }, status: "pending", revision: 0, updatedAt: Date.now() });
  const evidence: AgentToolReconciliationEvidence = { operationId: "op", runId: "run", toolCallId: "durable", toolName: "mutate", idempotencyKey: "run:durable", input: { operation_id: "op" }, output: { applied: true }, source: "fixture-audit", proof: { receipt: "signed" } };
  return { store, evidence };
}
describe("external effect reconciliation", () => {
  it.each([false, true])("retains pending outcome and repairs crash between decision and projection (file=%s)", async file => {
    const { store, evidence } = await fixture(file);
    const state = (await store.load("run"))!;
    await refreshAgentTaskOutcome(state, store);
    expect(state.status).toBe("completed");
    expect(state.taskOutcome?.status).toBe("needs_reconciliation");
    await store.save(state);
    const broken: AgentRunStore = { ...store, save() { throw new Error("crash after journal"); } };
    await expect(reconcileAgentToolExecution({ store: broken, evidence, verifyEvidence: () => true })).rejects.toThrow("crash after journal");
    expect((await store.loadToolExecution!("run", "durable"))?.status).toBe("completed");
    const pendingProjection = (await store.load("run"))!;
    await refreshAgentTaskOutcome(pendingProjection, store);
    expect(pendingProjection.taskOutcome?.status).toBe("needs_reconciliation");
    const recovered = await reconcileAgentToolExecution({ store, evidence, verifyEvidence: () => true });
    expect(recovered.status).toBe("queued");
    expect(recovered.taskOutcome?.status).toBe("in_progress");
    expect(recovered.reconciliations?.[0].previousOutcome?.status).toBe("needs_reconciliation");
    expect(recovered.reconciliations?.[0].previousOutputText).toBe("tool_error");
    expect(normalizeAgentRunState(JSON.parse(JSON.stringify(recovered)))).toEqual(recovered);
    expect(await reconcileAgentToolExecution({ store, evidence, verifyEvidence: () => true })).toEqual(recovered);
  });
  it("rejects foreign, altered, absent, untrusted and contradictory evidence", async () => {
    const { store, evidence } = await fixture();
    for (const patch of [{ toolName: "other" }, { input: { operation_id: "other" } }, { scope: { tenantId: "other" } }, { output: undefined }]) {
      await expect(reconcileAgentToolExecution({ store, evidence: { ...evidence, ...patch } as AgentToolReconciliationEvidence, verifyEvidence: () => true })).rejects.toThrow();
    }
    await expect(reconcileAgentToolExecution({ store, evidence, verifyEvidence: () => false })).rejects.toThrow("not verified");
    expect((await store.loadToolExecution!("run", "durable"))?.status).toBe("running");
    await reconcileAgentToolExecution({ store, evidence, verifyEvidence: () => true });
    await expect(reconcileAgentToolExecution({ store, evidence: { ...evidence, output: false }, verifyEvidence: () => true })).rejects.toThrow("Contradictory");
  });
  it("serializes concurrent reconcilers and journal CAS in FileAgentRunStore", async () => {
    const { store, evidence } = await fixture(true);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => reconcileAgentToolExecution({ store, evidence, verifyEvidence: () => true })));
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    expect((await store.load("run"))?.reconciliations).toHaveLength(1);
    const entry = (await store.loadToolExecution!("run", "durable"))!;
    const writes = await Promise.allSettled([1, 2].map(() => store.saveToolCall!(entry, { expectedRevision: entry.revision })));
    expect(writes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it("refuses an active worker and fences expired ownership", async () => {
    const { store, evidence } = await fixture(true);
    await store.acquireLease!("run", { ownerId: "worker", ttlMs: 10000 });
    await expect(reconcileAgentToolExecution({ store, evidence, verifyEvidence: () => true })).rejects.toThrow("owned");
    await expect(store.save(base(), { expectedRevision: 0, leaseOwnerId: "wrong" })).rejects.toThrow("ownership");
    await store.releaseLease!("run", "worker");
    const lost: AgentRunStore = { ...store, renewLease: () => undefined };
    await expect(reconcileAgentToolExecution({ store: lost, evidence, verifyEvidence: () => true })).rejects.toThrow("ownership");
  });
  it("does not classify an ordinary recoverable tool error as indeterminate", async () => {
    const state = base();
    state.toolResults = [{ toolCallId: "x", toolName: "read", isError: true, error: { message: "retry later" } }];
    await refreshAgentTaskOutcome(state);
    expect(state.taskOutcome?.status).toBe("resolved");
    state.approvalHistory = [{ requestId: "a", kind: "local-tool", provider: "fixture", approve: false }];
    await refreshAgentTaskOutcome(state);
    expect(state.taskOutcome?.status).toBe("denied");
  });
  it("continues using confirmed results without another mutation even if the model repeats the call", async () => {
    const { store, evidence } = await fixture();
    const state = await reconcileAgentToolExecution({ store, evidence, verifyEvidence: () => true });
    let calls = 0, mutations = 0;
    const model = { provider: "fixture", modelId: "fixture", capabilities: { tools: true }, generate: async () => ++calls === 1 ? { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "new-id", name: "mutate", input: evidence.input } }] }], finishReason: "tool-calls" } : { messages: [createTextMessage("assistant", "applied")], text: "applied", finishReason: "stop" } } as LanguageModel;
    const agent = createAgent({ store, model, maxSteps: 8, tools: { mutate: tool({ name: "mutate", schema: z.object({ operation_id: z.string() }), execute() { mutations++; return {}; } }) } });
    const result = await runAgent(agent, { state });
    expect(result.status).toBe("completed");
    expect(result.taskOutcome?.status).toBe("resolved");
    expect(result.outputText).toBe("applied");
    expect(mutations).toBe(0);
  });
});
