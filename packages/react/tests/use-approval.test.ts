// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useApproval, type ApprovalPause, type UseApprovalResult } from "../src/use-approval.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
});

const pause: ApprovalPause = {
  type: "zhivex.approval.pause",
  runId: "run-1",
  provider: "zhivex",
  approvalRequestId: "approval-1",
  name: "deploy",
  approvalToken: "token-1"
};

const mount = async (handler: (body: unknown) => Response | Promise<Response>) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const current: { value?: UseApprovalResult } = {};
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return handler(body);
  };
  await act(async () => {
    root.render(createElement(() => {
      current.value = useApproval({ api: "/api/approvals", fetch: fetchImpl });
      return null;
    }));
  });
  return { current, bodies };
};

describe("useApproval", () => {
  it("sends the pause token and clears the pause after the server accepts it", async () => {
    const { current, bodies } = await mount(() => Response.json({
      ok: true,
      runId: "run-1",
      status: "completed",
      outputText: "deployed"
    }));
    await act(async () => {
      current.value!.receiveEvent({
        type: "RUN_FINISHED",
        runId: "run-1",
        outcome: {
          type: "interrupt",
          interrupts: [{
            id: "zhivex:approval-1",
            reason: "tool_approval",
            toolCallId: "call-1",
            metadata: {
              provider: "zhivex",
              approvalRequestId: "approval-1",
              name: "deploy",
              approvalToken: "token-1"
            }
          }]
        }
      });
    });
    expect(current.value?.pending).toEqual([{
      type: "zhivex.approval.pause",
      runId: "run-1",
      provider: "zhivex",
      approvalRequestId: "approval-1",
      name: "deploy",
      approvalToken: "token-1",
      toolCallId: "call-1"
    }]);
    await act(async () => {
      await current.value!.approve("approval-1", "reviewed", "zhivex");
    });
    expect(bodies).toEqual([{
      runId: "run-1",
      provider: "zhivex",
      approvalRequestId: "approval-1",
      approvalToken: "token-1",
      approve: true,
      reason: "reviewed"
    }]);
    expect(current.value?.pending).toEqual([]);
    expect(current.value?.lastResult).toMatchObject({ status: "completed", outputText: "deployed" });
  });

  it("keeps a pending pause when the server rejects a forged decision", async () => {
    const { current } = await mount(() => Response.json({ ok: false, code: "forged" }, { status: 403 }));
    await act(async () => {
      current.value!.receive(pause);
    });
    await act(async () => {
      await current.value!.reject("approval-1", "no");
    });
    expect(current.value?.pending).toEqual([pause]);
    expect(current.value?.error?.message).toContain("forged");
  });

  it("drops a pause when the server reports a replay", async () => {
    const { current } = await mount(() => Response.json({ ok: false, code: "replayed" }, { status: 409 }));
    await act(async () => {
      current.value!.receive(pause);
    });
    await act(async () => {
      await current.value!.approve("approval-1");
    });
    expect(current.value?.pending).toEqual([]);
    expect(current.value?.error?.message).toContain("replayed");
  });

  it("drops a stale pause and clear removes the error", async () => {
    const { current } = await mount(() => Response.json({ ok: false, code: "stale" }, { status: 410 }));
    await act(async () => {
      current.value!.receive(pause);
    });
    await act(async () => {
      await current.value!.approve("approval-1", "late");
    });
    expect(current.value?.pending).toEqual([]);
    expect(current.value?.error?.message).toContain("stale");
    await act(async () => {
      current.value!.clear();
    });
    expect(current.value?.error).toBeUndefined();
    expect(current.value?.lastResult).toBeUndefined();
  });

  it("refuses an ambiguous approval id", async () => {
    const { current } = await mount(() => Response.json({ ok: true }));
    await act(async () => {
      current.value!.receive(pause);
      current.value!.receive({ ...pause, provider: "other" });
    });
    await expect(current.value!.approve("approval-1")).rejects.toThrow(/ambiguous/);
  });
});
