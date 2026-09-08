import { afterEach, expect, it, vi } from "vitest";
import { ProviderHTTPError, withResponseRetry } from "../src/index.js";

afterEach(() => vi.useRealTimers());

it.each(["2", "Wed, 01 Jan 2025 00:00:02 GMT"])("honors Retry-After %s and preserves the successful body", async (retryAfter) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  const response = new Response("stream remains unread");
  const operation = vi.fn()
    .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": retryAfter } }))
    .mockResolvedValueOnce(response);
  const pending = withResponseRetry(operation, { maxRetries: 1, retryBackoffMs: 0 }, "Test");
  await vi.advanceTimersByTimeAsync(1_999);
  expect(operation).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBe(response);
  expect(response.bodyUsed).toBe(false);
  expect(await response.text()).toBe("stream remains unread");
});

it("does not retry permanent HTTP failures and retains bounded diagnostics", async () => {
  const operation = vi.fn(async () => new Response("invalid request", { status: 400 }));
  const failure = await withResponseRetry(operation, { maxRetries: 2 }, "Test").catch(error => error);
  expect(failure).toBeInstanceOf(ProviderHTTPError);
  expect(failure.status).toBe(400);
  expect(operation).toHaveBeenCalledTimes(1);
});

it("cancels retry waits without invoking the operation again", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const operation = vi.fn(async () => new Response("busy", { status: 503, headers: { "retry-after": "60" } }));
  const pending = withResponseRetry(operation, { maxRetries: 1, abortSignal: controller.signal }).catch(error => error);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(new Error("cancelled"));
  expect((await pending).message).toBe("cancelled");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(operation).toHaveBeenCalledTimes(1);
});
