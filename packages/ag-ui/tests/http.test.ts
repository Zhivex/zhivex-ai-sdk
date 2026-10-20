import { describe, expect, it } from "vitest";
import {
  createAgent,
  createAgentControlPlane,
  createInMemoryAgentRunStore,
  createMockLanguageModel,
  createTextMessage,
  tool
} from "@zhivex-ai/core";
import { z } from "zod";
import {
  createClientApprovalSession,
  handleClientApprovalDecision,
  type ClientApprovalPause
} from "../src/index.js";

const createWaiting = async (now = () => 1_000) => {
  let sideEffects = 0;
  const store = createInMemoryAgentRunStore();
  const agent = createAgent({
    id: "deploy-control-plane",
    store,
    maxSteps: 3,
    model: createMockLanguageModel({
      capabilities: { tools: true },
      responses: [
        {
          messages: [{
            role: "assistant",
            parts: [{
              type: "tool-call",
              toolCall: { id: "deploy-call-1", name: "deploy", input: { target: "staging" } }
            }]
          }],
          finishReason: "tool-calls"
        },
        {
          messages: [createTextMessage("assistant", "deployed")],
          text: "deployed",
          finishReason: "stop"
        }
      ]
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
  const controlPlane = createAgentControlPlane({ agent });
  const session = createClientApprovalSession({ controlPlane, now });
  const waiting = await controlPlane.run({ prompt: "deploy" });
  const pause = session.publish(waiting.state, { expiresAt: 5_000 })[0]!;
  return { session, pause, effects: () => sideEffects, runId: waiting.state.runId };
};

const post = (body: unknown) => new Request("https://example.test/api/approvals", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

const decision = (pause: ClientApprovalPause, extra: Record<string, unknown> = {}) => ({
  runId: pause.runId,
  provider: pause.provider,
  approvalRequestId: pause.approvalRequestId,
  approvalToken: pause.approvalToken,
  approve: true,
  ...extra
});

describe("handleClientApprovalDecision", () => {
  it("ignores a client-supplied queue item and returns a summary without the token", async () => {
    const { session, pause, effects, runId } = await createWaiting();
    const response = await handleClientApprovalDecision(session, post(decision(pause, {
      reason: "reviewed",
      queueItem: {
        runId: "run-other",
        approvalToken: pause.approvalToken,
        approvalRequestId: "other"
      }
    })));
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; runId: string; status: string; outputText: string };
    expect(body).toEqual({ ok: true, runId, status: "completed", outputText: "deployed" });
    expect(JSON.stringify(body)).not.toContain(pause.approvalToken);
    expect(effects()).toBe(1);
  });

  it("returns distinct statuses for forged, replayed, stale, and cross-run decisions", async () => {
    const { session, pause } = await createWaiting();
    const forged = await handleClientApprovalDecision(session, post(decision(pause, { approvalToken: "nope" })));
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ ok: false, code: "forged" });

    const cross = await handleClientApprovalDecision(session, post(decision(pause, { runId: "run-other" })));
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ code: "cross_run" });

    const accepted = await handleClientApprovalDecision(session, post(decision(pause, { reason: "reviewed" })));
    expect(accepted.status).toBe(200);
    const replay = await handleClientApprovalDecision(session, post(decision(pause)));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "replayed" });

    const expired = await createWaiting(() => 9_000);
    const stale = await handleClientApprovalDecision(expired.session, post(decision(expired.pause)));
    expect(stale.status).toBe(410);
    expect(await stale.json()).toMatchObject({ code: "stale" });
    expect(expired.effects()).toBe(0);

    const invalid = await handleClientApprovalDecision(session, post({ approve: "yes" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid" });
  });
});
