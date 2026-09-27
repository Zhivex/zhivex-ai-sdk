import { describe, expect, it, vi } from "vitest";
import { createVertex } from "../src/index.js";

const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "test" }] }];

const pendingStream = () => {
  let signal: AbortSignal;
  const model = createVertex({ apiKey: "test", fetch: vi.fn(async (_url, init) => {
    signal = init!.signal!;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"started"}]}}]}\n\n'));
        // Fetch may expose a generic AbortError while the merged signal retains the cause.
        signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      }
    }));
  }) as typeof fetch })("gemini-2.5-flash-lite");
  return { model, reason: () => signal.reason };
};

describe("Vertex cancellation during response reads", () => {
  it("preserves the caller's exact abort reason", async () => {
    const caller = new AbortController();
    const { model } = pendingStream();
    const iterator = (await model.stream!({ messages, abortSignal: caller.signal }))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "text-delta" });
    const next = iterator.next();
    const reason = new Error("caller cancelled");
    const assertion = expect(next).rejects.toBe(reason);
    caller.abort(reason);
    await assertion;
  });

  it("preserves the merged timeout reason while reading", async () => {
    vi.useFakeTimers();
    try {
      const { model, reason } = pendingStream();
      const iterator = (await model.stream!({ messages, timeoutMs: 100 }))[Symbol.asyncIterator]();
      await iterator.next();
      const next = iterator.next();
      const assertion = expect(next).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      await expect(next).rejects.toBe(reason());
    } finally { vi.useRealTimers(); }
  });
});
