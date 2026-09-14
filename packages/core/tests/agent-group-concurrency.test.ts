import { expect, it, vi } from "vitest";
import { createAgent, createInMemoryAgentRunStore, runAgentGroup, ValidationError } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const response = { text: "done", messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "done" }] }], finishReason: "stop" as const };

it.each([1, 3, 20])("bounds twenty members to %s active workers with FIFO output", async maxConcurrency => {
  const entered = Array.from({ length: 20 }, deferred), release = Array.from({ length: 20 }, deferred);
  let active = 0, peak = 0;
  const starts: number[] = [];
  const group = entered.map((gate, i) => {
    const model = createMockLanguageModel();
    model.generate = async () => { active++; peak = Math.max(peak, active); starts.push(i); gate.resolve(); await release[i]!.promise; active--; return response; };
    return { name: String(i), agent: createAgent({ id: String(i), model }) };
  });
  const running = runAgentGroup(group, { prompt: "hello", maxConcurrency });
  await Promise.all(entered.slice(0, maxConcurrency).map(x => x.promise));
  expect(active).toBe(maxConcurrency);
  for (let i = 0; i < 20; i++) {
    release[i]!.resolve();
    if (i + maxConcurrency < 20) await entered[i + maxConcurrency]!.promise;
  }
  const result = await running;
  expect(peak).toBe(maxConcurrency);
  expect(starts).toEqual(Array.from({ length: 20 }, (_, i) => i));
  expect(result.outputs.map(x => x.name)).toEqual(starts.map(String));
  expect(result.status).toBe("completed");
});

it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid limit %s before effects", async maxConcurrency => {
  const model = createMockLanguageModel(); model.generate = vi.fn(model.generate);
  await expect(runAgentGroup([{ agent: createAgent({ model }) }], { prompt: "hello", maxConcurrency })).rejects.toBeInstanceOf(ValidationError);
  expect(model.generate).not.toHaveBeenCalled();
});

it("does not claim or execute members cancelled before starting", async () => {
  const controller = new AbortController(); controller.abort();
  const store = createInMemoryAgentRunStore(); store.claimIdempotencyKey = vi.fn(store.claimIdempotencyKey!);
  const model = createMockLanguageModel(); model.generate = vi.fn(model.generate);
  const result = await runAgentGroup(Array.from({ length: 20 }, (_, i) => ({ name: String(i), agent: createAgent({ id: String(i), model, store }) })), { prompt: "hello", maxConcurrency: 3, idempotencyKey: "cancel", abortSignal: controller.signal });
  expect(result.outputs).toHaveLength(20);
  expect(result.outputs.every(x => x.status === "rejected")).toBe(true);
  expect(model.generate).not.toHaveBeenCalled(); expect(store.claimIdempotencyKey).not.toHaveBeenCalled();
});

it("fail-fast cancels active members and drains pending entries without invoking them", async () => {
  const started = deferred();
  const called: number[] = [];
  const group = Array.from({ length: 20 }, (_, i) => {
    const model = createMockLanguageModel();
    model.generate = async input => {
      called.push(i);
      if (i === 0) { await started.promise; throw new Error("fixture failure"); }
      started.resolve();
      await new Promise<void>((_, reject) => input.abortSignal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return response;
    };
    return { agent: createAgent({ id: String(i), model }) };
  });
  const result = await runAgentGroup(group, { prompt: "hello", maxConcurrency: 2, stopOnError: true });
  expect(called).toEqual([0, 1]);
  expect(result.status).toBe("failed");
  expect(result.outputs).toHaveLength(20);
  expect(result.outputs.slice(1).every(x => x.error?.message === "Agent group member aborted after fail-fast.")).toBe(true);
});

it("cancels queued members when the caller aborts an active group", async () => {
  const controller = new AbortController(), entered = deferred();
  const called: number[] = [];
  const group = Array.from({ length: 20 }, (_, i) => {
    const model = createMockLanguageModel();
    model.generate = async input => {
      called.push(i); if (called.length === 2) entered.resolve();
      await new Promise<void>((_, reject) => input.abortSignal!.addEventListener("abort", () => reject(new Error("caller aborted")), { once: true }));
      return response;
    };
    return { agent: createAgent({ id: String(i), model }) };
  });
  const running = runAgentGroup(group, { prompt: "hello", maxConcurrency: 2, abortSignal: controller.signal });
  await entered.promise; controller.abort();
  const result = await running;
  expect(called).toEqual([0, 1]);
  expect(result.outputs).toHaveLength(20);
  expect(result.outputs.every(x => x.status === "rejected")).toBe(true);
});
