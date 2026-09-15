import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgent, createFileAgentRunStore, createInMemoryAgentRunStore, runAgentGroup, ValidationError, ConflictError, type AgentRunStore } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";

const members = (store: AgentRunStore) => ["a", "b"].map(id => {
  const model = createMockLanguageModel();
  model.generate = vi.fn(async () => ({ text: "ok", messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "ok" }] }], finishReason: "stop" as const }));
  return { name: id, agent: createAgent({ id, store, model }) };
});

describe("agent group identities", () => {
  it("isolates members, reuses runs after reordering, and separates scopes", async () => {
    const group = members(createInMemoryAgentRunStore());
    const input = { prompt: "hello", idempotencyKey: "group", scope: { tenantId: "one" } };
    const first = await runAgentGroup(group, input);
    expect(first.status).toBe("completed");
    const ids = first.outputs.map(x => x.output!.state.runId);
    expect(new Set(ids).size).toBe(2);
    const second = await runAgentGroup([...group].reverse(), input);
    expect(second.outputs.map(x => x.output!.state.runId)).toEqual([...ids].reverse());
    for (const member of group) expect(member.agent.model.generate).toHaveBeenCalledTimes(1);
    const other = await runAgentGroup(group, { ...input, scope: { tenantId: "two" } });
    expect(other.outputs.every(x => !ids.includes(x.output!.state.runId))).toBe(true);
  });

  it("rejects ambiguous identities and explicit key collisions before effects", async () => {
    const group = members(createInMemoryAgentRunStore());
    await expect(runAgentGroup([group[0]!, group[0]!], { prompt: "hello", idempotencyKey: "group" })).rejects.toBeInstanceOf(ValidationError);
    await expect(runAgentGroup(group.map(x => ({ ...x, input: { idempotencyKey: "same" } })), { prompt: "hello" })).rejects.toBeInstanceOf(ConflictError);
    for (const member of group) expect(member.agent.model.generate).not.toHaveBeenCalled();
  });

  it("preserves explicit keys and rejects their reuse by a different member", async () => {
    const group = members(createInMemoryAgentRunStore());
    const first = await runAgentGroup([{ ...group[0]!, input: { idempotencyKey: "explicit" } }], { prompt: "hello" });
    expect(first.outputs[0]!.output!.state.idempotencyKey).toBe("explicit");
    const second = await runAgentGroup([{ ...group[1]!, input: { idempotencyKey: "explicit" } }], { prompt: "hello" });
    expect(second.status).toBe("failed");
    expect(second.outputs[0]!.error?.message).toContain("different member");
    expect(group[1]!.agent.model.generate).not.toHaveBeenCalled();
  });

  it("reopens a durable store and reuses each completed run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-group-"));
    try {
      const first = await runAgentGroup(members(createFileAgentRunStore({ directory: dir })), { prompt: "hello", idempotencyKey: "restart" });
      const restarted = members(createFileAgentRunStore({ directory: dir }));
      const second = await runAgentGroup(restarted, { prompt: "hello", idempotencyKey: "restart" });
      expect(second.outputs.map(x => x.output!.state.runId)).toEqual(first.outputs.map(x => x.output!.state.runId));
      for (const member of restarted) expect(member.agent.model.generate).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it("aggregates every pair of real run states without premature completion", async () => {
  const store = createInMemoryAgentRunStore();
  const seed = await runAgentGroup(members(store), { prompt: "hello" });
  const base = seed.outputs[0]!.output!.state;
  const precedence = ["failed", "timed_out", "cancel_requested", "running", "queued", "waiting_approval", "cancelled", "completed"] as const;
  for (const left of precedence) for (const right of precedence) {
    const group = [left, right].map((status, i) => {
      const state = { ...base, status, runId: `state-${i}` };
      const model = createMockLanguageModel();
      model.generate = vi.fn(model.generate);
      return { agent: createAgent({ id: base.agentId, model, store: { ...store, load: () => state, acquireLease: () => undefined } }), input: { runId: state.runId } };
    });
    const output = await runAgentGroup(group);
    expect(output.status, `${left}/${right}`).toBe(precedence.find(x => x === left || x === right));
    for (const member of group) expect(member.agent.model.generate).not.toHaveBeenCalled();
  }
});

it("reports running while another invocation holds member leases", async () => {
  const group = members(createInMemoryAgentRunStore());
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  for (const member of group) {
    const original = member.agent.model.generate;
    member.agent.model.generate = async input => {
      if (++active === 2) entered();
      await barrier;
      return original(input);
    };
  }
  const input = { prompt: "hello", idempotencyKey: "concurrent" };
  const first = runAgentGroup(group, input);
  await started;
  try {
    const second = await runAgentGroup(group, input);
    expect(second.status).toBe("running");
    expect(second.outputs.map(x => x.output!.status)).toEqual(["running", "running"]);
    expect(active).toBe(2);
  } finally { release(); }
  expect((await first).status).toBe("completed");
});

it("retains pending approvals across a durable store restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-group-approval-"));
  try {
    const { z } = await import("zod");
    const createMembers = () => {
      const store = createFileAgentRunStore({ directory: dir });
      return ["a", "b"].map(id => ({ name: id, agent: createAgent({ id, store,
        model: createMockLanguageModel({ responses: [{ messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: `call-${id}`, name: "effect", input: {} } }] }], finishReason: "tool-calls" }] }),
        tools: { effect: { name: "effect", schema: z.object({}), requiresApproval: true, approvalMode: "interrupt", execute: vi.fn(() => "done") } }, maxSteps: 2
      }) }));
    };
    const initialMembers = createMembers();
    const initial = await runAgentGroup(initialMembers, { prompt: "hello", idempotencyKey: "approvals" });
    expect(initial.status, JSON.stringify(initial.outputs)).toBe("waiting_approval");
    const restartedMembers = createMembers();
    const resumed = await runAgentGroup(restartedMembers, { prompt: "hello", idempotencyKey: "approvals" });
    expect(resumed.status).toBe("waiting_approval");
    expect(resumed.outputs.map(x => x.output!.state.pendingApprovals)).toEqual(initial.outputs.map(x => x.output!.state.pendingApprovals));
    for (const member of [...initialMembers, ...restartedMembers]) expect(member.agent.tools!.effect!.execute).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
