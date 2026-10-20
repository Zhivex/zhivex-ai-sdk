import { describe, expect, it } from "vitest";
import {
  ValidationError,
  createAgent,
  createAgentApprovalQueue,
  createAgentControlPlane,
  createInMemoryAgentRunStore,
  createMockLanguageModel,
  createTextMessage,
  tool,
  type AgentApprovalQueueItem,
  type AgentControlPlane,
  type AgentControlPlaneRunRecord
} from "@zhivex-ai/core";
import { z } from "zod";
import { ClientApprovalError, createClientApprovalSession } from "../src/index.js";

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

const createWaiting = async () => {
  const store = createInMemoryAgentRunStore();
  const agent = createAgent({
    id: "deploy-control-plane",
    store,
    maxSteps: 3,
    model: createMockLanguageModel({
      capabilities: { tools: true },
      responses: [toolTurn, doneTurn]
    }),
    tools: {
      deploy: tool({
        name: "deploy",
        schema: z.object({ target: z.string() }),
        requiresApproval: true,
        approvalMode: "interrupt",
        approvalVersion: "1",
        execute: () => ({ deployed: true })
      })
    }
  });
  const controlPlane = createAgentControlPlane({ agent });
  const waiting = await controlPlane.run({ prompt: "deploy" });
  const queueItem = createAgentApprovalQueue(waiting.state, { expiresAt: 5_000 })[0]!;
  return { store, controlPlane, waiting, queueItem };
};

const capture = async (work: () => Promise<unknown>): Promise<ValidationError> => {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error("Expected resumeApproval to throw.");
};

const classify = async (error: ValidationError): Promise<unknown> => {
  const runtime = await createWaiting();
  const session = createClientApprovalSession({
    controlPlane: {
      resumeApproval: async () => {
        throw error;
      }
    } as AgentControlPlane,
    now: () => 1_000
  });
  const pause = session.publish(runtime.waiting.state, { expiresAt: 9_000 })[0]!;
  return session.decide({
    runId: pause.runId,
    provider: pause.provider,
    approvalRequestId: pause.approvalRequestId,
    approvalToken: pause.approvalToken,
    approve: true
  }, { now: 1_000 });
};

const expectCode = async (error: ValidationError, code: "forged" | "replayed" | "stale") => {
  await expect(classify(error)).rejects.toMatchObject({
    name: "ClientApprovalError",
    code
  });
};

describe("resumeApproval error wording", () => {
  it("classifies an invalid token as forged", async () => {
    const { controlPlane, queueItem } = await createWaiting();
    const error = await capture(() => controlPlane.resumeApproval({
      queueItem,
      approvalToken: "not-the-token",
      approve: true,
      now: 1_000
    }));
    expect(error.message).toBe("Agent approval token is invalid.");
    await expectCode(error, "forged");
  });

  it("classifies expiry as stale", async () => {
    const { controlPlane, queueItem } = await createWaiting();
    const error = await capture(() => controlPlane.resumeApproval({
      queueItem,
      approvalToken: queueItem.approvalToken,
      approve: true,
      now: 5_000
    }));
    expect(error.message).toBe("Agent approval has expired.");
    await expectCode(error, "stale");
  });

  it("classifies a missing run as stale", async () => {
    const { controlPlane, queueItem } = await createWaiting();
    const missing: AgentApprovalQueueItem = { ...queueItem, runId: "run-missing" };
    const error = await capture(() => controlPlane.resumeApproval({
      queueItem: missing,
      approvalToken: missing.approvalToken,
      approve: true,
      now: 1_000
    }));
    expect(error.message).toBe('Agent run "run-missing" was not found.');
    await expectCode(error, "stale");
  });

  it("classifies an agent mismatch as stale", async () => {
    const { controlPlane, queueItem } = await createWaiting();
    const mismatch: AgentApprovalQueueItem = { ...queueItem, agentId: "other-agent" };
    const error = await capture(() => controlPlane.resumeApproval({
      queueItem: mismatch,
      approvalToken: mismatch.approvalToken,
      approve: true,
      now: 1_000
    }));
    expect(error.message).toBe("Agent approval queue item does not match the persisted agent.");
    await expectCode(error, "stale");
  });

  it("classifies a consumed approval as replayed", async () => {
    const { controlPlane, queueItem } = await createWaiting();
    const resumed: AgentControlPlaneRunRecord = await controlPlane.resumeApproval({
      queueItem,
      approvalToken: queueItem.approvalToken,
      approve: true,
      reason: "reviewed",
      now: 1_000
    });
    expect(resumed.state.status).toBe("completed");
    const error = await capture(() => controlPlane.resumeApproval({
      queueItem,
      approvalToken: queueItem.approvalToken,
      approve: true,
      now: 1_000
    }));
    expect(error.message).toBe("Agent approval is no longer pending or was already consumed.");
    await expectCode(error, "replayed");
  });

  it("classifies a renamed approval as stale", async () => {
    const { controlPlane, queueItem } = await createWaiting();
    const renamed: AgentApprovalQueueItem = { ...queueItem, name: "other-tool" };
    const error = await capture(() => controlPlane.resumeApproval({
      queueItem: renamed,
      approvalToken: renamed.approvalToken,
      approve: true,
      now: 1_000
    }));
    expect(error.message).toBe("Agent approval queue item does not match the pending request.");
    await expectCode(error, "stale");
  });

  it("classifies a fingerprint mismatch as stale", async () => {
    const { store, controlPlane, waiting, queueItem } = await createWaiting();
    const loaded = await store.load(waiting.state.runId);
    loaded!.pendingApprovals[0]!.arguments = "{\"target\":\"mutated\"}";
    await store.save(loaded!);
    const error = await capture(() => controlPlane.resumeApproval({
      queueItem,
      approvalToken: queueItem.approvalToken,
      approve: true,
      now: 1_000
    }));
    expect(error.message).toBe("Agent approval request fingerprint does not match the persisted request.");
    await expectCode(error, "stale");
  });

  it("classifies a kind mismatch as stale", async () => {
    const { controlPlane, queueItem } = await createWaiting();
    const mismatch: AgentApprovalQueueItem = { ...queueItem, kind: "provider" };
    const error = await capture(() => controlPlane.resumeApproval({
      queueItem: mismatch,
      approvalToken: mismatch.approvalToken,
      approve: true,
      now: 1_000
    }));
    expect(error.message).toBe("Agent approval queue item kind does not match the persisted request.");
    await expectCode(error, "stale");
  });

  it("does not classify a missing store as an approval decision", async () => {
    const { queueItem } = await createWaiting();
    const controlPlane = createAgentControlPlane({
      agent: createAgent({
        id: "no-store",
        model: createMockLanguageModel({ responses: [doneTurn] })
      })
    });
    const error = await capture(() => controlPlane.resumeApproval({
      queueItem,
      approvalToken: queueItem.approvalToken,
      approve: true,
      now: 1_000
    }));
    expect(error.message).toBe("Durable approval resume requires an AgentRunStore.");
    await expect(classify(error)).rejects.toBe(error);
    await expect(classify(error)).rejects.not.toBeInstanceOf(ClientApprovalError);
  });
});
