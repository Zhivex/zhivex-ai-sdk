import { describe, expect, it, vi } from "vitest";
import { runRealtimeDelegations, type RealtimeDelegationContext, type RealtimeEvent, type RealtimeSession } from "../src/index.js";
import { BoundedReplayBroadcast } from "../src/bounded-broadcast.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const setup = () => {
  const events = new BoundedReplayBroadcast<RealtimeEvent>();
  const appendContext = vi.fn(async () => {});
  const session = { capabilities: { realtime: { clientDelegation: true } }, appendContext, eventStream: () => events.stream() } as unknown as RealtimeSession;
  return { session, events, appendContext };
};
const delegation = (id: string, offsetMs = 100): RealtimeEvent => ({ type: "realtime-delegation", delegationId: id, offsetMs });

describe("runRealtimeDelegations", () => {
  it("keeps receiving overlapping transcripts while serializing backend work and preserving IDs", async () => {
    const { session, events, appendContext } = setup();
    const first = deferred();
    const contexts: RealtimeDelegationContext[] = [];
    const done = runRealtimeDelegations(session, { onDelegation: async (context) => {
      contexts.push(context);
      if (contexts.length === 1) await first.promise;
      await context.sendUpdate({ kind: "commentary", content: "Verified result" });
    } });
    await events.publish({ type: "realtime-transcript", role: "user", text: "Friday", isFinal: false, startMs: 0, endMs: 90 });
    await events.publish(delegation("original_1"));
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    await events.publish({ type: "realtime-transcript", role: "assistant", text: "Checking", isFinal: false, startMs: 50, endMs: 110 });
    await events.publish({ type: "realtime-transcript", role: "user", text: "Thursday", isFinal: false, startMs: 95, endMs: 120 });
    await events.publish({ type: "realtime-provider-data", provider: "test", data: { type: "interruption" } });
    await events.publish(delegation("original_2", 130));
    await events.publish(delegation("original_1"));
    expect(contexts[0]!.signal.aborted).toBe(false);
    first.resolve();
    await vi.waitFor(() => expect(appendContext).toHaveBeenCalledTimes(2));
    expect(contexts.map((c) => c.transcripts.map((t) => t.text))).toEqual([["Friday"], ["Friday", "Checking", "Thursday"]]);
    expect(appendContext.mock.calls).toEqual([
      [{ kind: "commentary", content: "Verified result", delegationId: "original_1" }],
      [{ kind: "commentary", content: "Verified result", delegationId: "original_2" }]
    ]);
    await events.publish({ type: "realtime-end" });
    await done;
  });

  it("rejects late updates after disconnect even when the backend ignores abort", async () => {
    const { session, events, appendContext } = setup();
    let context!: RealtimeDelegationContext;
    const done = runRealtimeDelegations(session, { onDelegation: async (c) => { context = c; await new Promise(() => {}); } });
    await events.publish(delegation("x"));
    await vi.waitFor(() => expect(context).toBeDefined());
    await events.publish({ type: "realtime-end" });
    await done;
    expect(context.signal.aborted).toBe(true);
    await expect(context.sendUpdate({ kind: "commentary", content: "Late" })).rejects.toThrow("ended");
    expect(appendContext).not.toHaveBeenCalled();
  });

  it("propagates handler failures while the event stream is idle", async () => {
    const { session, events } = setup();
    const done = runRealtimeDelegations(session, { onDelegation: async () => { throw new Error("backend failed"); } });
    const assertion = expect(done).rejects.toThrow("backend failed");
    await events.publish(delegation("x"));
    await assertion;
  });

  it("honors abort before executing a backend and while idle", async () => {
    const { session } = setup();
    const abort = new AbortController();
    const handler = vi.fn();
    const done = runRealtimeDelegations(session, { onDelegation: handler, signal: abort.signal });
    const assertion = expect(done).rejects.toThrow("stop");
    abort.abort(new Error("stop"));
    await assertion;
    await expect(runRealtimeDelegations(session, { onDelegation: handler, signal: abort.signal })).rejects.toThrow("stop");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails on transcript/queue limits rather than dropping context or tasks", async () => {
    const { session, events } = setup();
    const done = runRealtimeDelegations(session, { maxTranscriptChars: 2, onDelegation: async () => {} });
    const assertion = expect(done).rejects.toThrow("transcript limit");
    await events.publish({ type: "realtime-transcript", role: "user", text: "abc", isFinal: false });
    await assertion;
    const other = setup();
    const queued = runRealtimeDelegations(other.session, { maxPendingDelegations: 1, onDelegation: async () => { await new Promise(() => {}); } });
    const queueAssertion = expect(queued).rejects.toThrow("queue limit");
    await other.events.publish(delegation("1"));
    await other.events.publish(delegation("2"));
    await queueAssertion;
  });

  it("rejects conflicting delegation IDs and provider errors", async () => {
    const { session, events } = setup();
    const done = runRealtimeDelegations(session, { onDelegation: async () => {} });
    const assertion = expect(done).rejects.toThrow("reused");
    await events.publish(delegation("x", 1));
    await events.publish(delegation("x", 2));
    await assertion;
    const other = setup();
    const failed = runRealtimeDelegations(other.session, { onDelegation: async () => {} });
    const errorAssertion = expect(failed).rejects.toThrow("provider failure");
    await other.events.publish({ type: "realtime-error", message: "provider failure" });
    await errorAssertion;
  });
});
