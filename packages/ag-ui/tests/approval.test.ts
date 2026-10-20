import { describe, expect, it } from "vitest";
import {
  createAgent,
  createAgentApprovalQueue,
  createAgentControlPlane,
  createInMemoryAgentRunStore,
  createMockLanguageModel,
  createTextMessage,
  tool,
  type AgentControlPlaneRunRecord
} from "@zhivex-ai/core";
import { z } from "zod";
import {
  ClientApprovalError,
  createClientApprovalSession,
  type ClientApprovalPause
} from "../src/index.js";

const toolTurn = {
  messages: [{
    role: "assistant" as const,
    parts: [{
      type: "tool-call" as const,
      toolCall: { id: "deploy-call-1", name: "deploy", input: { target: "staging" } }
    }]
  }],
  finishReason: "tool-calls" as const
};

const doneTurn = {
  messages: [createTextMessage("assistant", "deployed")],
  text: "deployed",
  finishReason: "stop" as const
};

const createDeploy = (responses: Array<typeof toolTurn | typeof doneTurn>) => {
  let sideEffects = 0;
  const store = createInMemoryAgentRunStore();
  const agent = createAgent({
    id: "deploy-control-plane",
    store,
    maxSteps: 3,
    model: createMockLanguageModel({
      capabilities: { tools: true },
      responses
    }),
    tools: {
      deploy: tool({
        name: "deploy",
        schema: z.object({ target: z.string() }),
        requiresApproval: true,
        approvalMode: "interrupt",
        approvalVersion: "1",
        execute: () => {
          sideEffects += 1;
          return { deployed: true };
        }
      })
    }
  });
  return {
    store,
    effects: () => sideEffects,
    controlPlane: createAgentControlPlane({ agent })
  };
};

const decisionOf = (
  pause: ClientApprovalPause,
  approve = true,
  reason = "reviewed"
) => ({
  runId: pause.runId,
  provider: pause.provider,
  approvalRequestId: pause.approvalRequestId,
  approvalToken: pause.approvalToken,
  approve,
  reason
});

const project = (record: AgentControlPlaneRunRecord) => ({
  ledgerType: record.ledger.type,
  status: record.state.status,
  outputText: record.state.outputText,
  pending: record.state.pendingApprovals.length,
  auditStatus: record.ledger.audit.status,
  auditApprovals: record.ledger.audit.approvals,
  traceApprovals: record.ledger.trace.approvals.length,
  history: (record.state.approvalHistory ?? []).map((entry) => ({
    approve: entry.approve,
    reason: entry.reason,
    kind: entry.kind,
    provider: entry.provider
  }))
});

describe("createClientApprovalSession", () => {
  it("resumes through the control plane and records the same ledger decision", async () => {
    const viaSession = createDeploy([toolTurn, doneTurn]);
    const direct = createDeploy([toolTurn, doneTurn]);
    const session = createClientApprovalSession({
      controlPlane: viaSession.controlPlane,
      now: () => 1_000
    });
    const waiting = await viaSession.controlPlane.run({ prompt: "deploy" });
    expect(waiting.state.status).toBe("waiting_approval");
    const pause = session.publish(waiting.state, { expiresAt: 5_000 })[0]!;
    expect(pause).toMatchObject({
      type: "zhivex.approval.pause",
      runId: waiting.state.runId,
      name: "deploy"
    });
    expect(pause.arguments).toBeUndefined();
    expect(JSON.stringify(pause)).not.toContain("rawData");

    const resumed = await session.decide(decisionOf(pause), { now: 1_000 });
    const directWaiting = await direct.controlPlane.run({ prompt: "deploy" });
    const queueItem = createAgentApprovalQueue(directWaiting.state, { expiresAt: 5_000 })[0]!;
    const directRecord = await direct.controlPlane.resumeApproval({
      queueItem,
      approvalToken: queueItem.approvalToken,
      approve: true,
      reason: "reviewed",
      now: 1_000
    });

    expect(viaSession.effects()).toBe(1);
    expect(direct.effects()).toBe(1);
    expect(project(resumed)).toEqual(project(directRecord));
    expect(resumed.ledger).toBe(resumed.ledger);
    expect(resumed.state.approvalHistory?.[0]).toMatchObject({ approve: true, reason: "reviewed" });
  });

  it("rejects a denial without executing the tool and matches a direct resume", async () => {
    const viaSession = createDeploy([toolTurn, doneTurn]);
    const direct = createDeploy([toolTurn, doneTurn]);
    const session = createClientApprovalSession({ controlPlane: viaSession.controlPlane, now: () => 1_000 });
    const waiting = await viaSession.controlPlane.run({ prompt: "deploy" });
    const pause = session.publish(waiting.state, { expiresAt: 5_000 })[0]!;
    const resumed = await session.decide(decisionOf(pause, false, "no"), { now: 1_000 });
    const directWaiting = await direct.controlPlane.run({ prompt: "deploy" });
    const queueItem = createAgentApprovalQueue(directWaiting.state, { expiresAt: 5_000 })[0]!;
    const directRecord = await direct.controlPlane.resumeApproval({
      queueItem,
      approvalToken: queueItem.approvalToken,
      approve: false,
      reason: "no",
      now: 1_000
    });
    expect(viaSession.effects()).toBe(0);
    expect(direct.effects()).toBe(0);
    expect(project(resumed)).toEqual(project(directRecord));
    expect(resumed.state.approvalHistory?.[0]).toMatchObject({ approve: false, reason: "no" });
  });

  it("rejects forged, replayed, stale, and cross-run decisions", async () => {
    const runtime = createDeploy([toolTurn, toolTurn, doneTurn, doneTurn]);
    const session = createClientApprovalSession({
      controlPlane: runtime.controlPlane,
      now: () => 1_000
    });
    const first = await runtime.controlPlane.run({ prompt: "deploy" });
    const second = await runtime.controlPlane.run({ prompt: "deploy" });
    const pauseA = session.publish(first.state, { expiresAt: 5_000 })[0]!;
    const pauseB = session.publish(second.state, { expiresAt: 5_000 })[0]!;

    await expect(session.decide({
      ...decisionOf(pauseA),
      approvalToken: "forged-token"
    }, { now: 1_000 })).rejects.toMatchObject({ code: "forged" });

    await expect(session.decide({
      ...decisionOf(pauseB),
      approvalToken: pauseA.approvalToken
    }, { now: 1_000 })).rejects.toMatchObject({ code: "cross_run" });

    await expect(session.decide(decisionOf(pauseA), { now: 5_000 })).rejects.toMatchObject({ code: "stale" });

    const replaced = session.publish(first.state, { expiresAt: 5_000 })[0]!;
    await expect(session.decide(decisionOf(pauseA), { now: 1_000 })).rejects.toMatchObject({ code: "stale" });

    const loaded = await runtime.store.load(first.state.runId);
    loaded!.pendingApprovals[0]!.arguments = "{\"target\":\"mutated\"}";
    await runtime.store.save(loaded!);
    await expect(session.decide(decisionOf(replaced), { now: 1_000 })).rejects.toMatchObject({
      name: "ClientApprovalError",
      code: "stale"
    });
    expect(runtime.effects()).toBe(0);
    expect(await runtime.store.load(second.state.runId)).toMatchObject({ status: "waiting_approval" });

    const fresh = createDeploy([toolTurn, doneTurn]);
    const freshSession = createClientApprovalSession({
      controlPlane: fresh.controlPlane,
      now: () => 1_000
    });
    const waiting = await fresh.controlPlane.run({ prompt: "deploy" });
    const pause = freshSession.publish(waiting.state, { expiresAt: 5_000 })[0]!;
    const [firstDecision, secondDecision] = await Promise.allSettled([
      freshSession.decide(decisionOf(pause), { now: 1_000 }),
      freshSession.decide(decisionOf(pause), { now: 1_000 })
    ]);
    expect(firstDecision.status).toBe("fulfilled");
    expect(secondDecision.status).toBe("rejected");
    expect((secondDecision as PromiseRejectedResult).reason).toBeInstanceOf(ClientApprovalError);
    expect((secondDecision as PromiseRejectedResult).reason).toMatchObject({ code: "replayed" });
    await expect(freshSession.decide(decisionOf(pause), { now: 1_000 })).rejects.toMatchObject({ code: "replayed" });
    expect(fresh.effects()).toBe(1);
  });
});
