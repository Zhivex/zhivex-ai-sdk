import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryGenerateCache } from "../src/middleware-runtime.js";

afterEach(() => vi.useRealTimers());

describe("bounded generate cache", () => {
  it("preserves unlimited retention and reference identity by default", () => {
    const cache = createInMemoryGenerateCache();
    const value = { text: "same" };
    for (let i = 0; i < 1100; i++) cache.set(String(i), value);
    expect(cache.get("0")).toBe(value);
    expect(cache.get("1099")).toBe(value);
  });
  it("evicts the least recently used entry, including after overwrite", () => {
    const cache = createInMemoryGenerateCache({ maxEntries: 2 });
    cache.set("a", { text: "a" }); cache.set("b", { text: "b" });
    cache.get("a"); cache.set("c", { text: "c" });
    expect(cache.get("b")).toBeUndefined();
    cache.set("a", { text: "updated" }); cache.set("d", { text: "d" });
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("a")).toEqual({ text: "updated" });
  });
  it("accounts for UTF-8 bytes, replacements and oversized entries", () => {
    const value = { text: "😀" };
    const size = Buffer.byteLength(JSON.stringify(value)) + 1;
    const cache = createInMemoryGenerateCache({ maxBytes: size * 2 });
    cache.set("a", value); cache.set("b", value);
    expect(cache.get("a")).toBe(value);
    cache.set("c", value);
    expect(cache.get("b")).toBeUndefined();
    cache.set("a", { text: "x".repeat(size * 3) });
    expect(cache.get("a")).toBeUndefined();
    cache.set("d", value);
    expect(cache.get("c")).toBe(value);
    expect(cache.get("d")).toBe(value);
  });
  it("does not return a stale value when an unaccountable replacement is skipped", () => {
    const cache = createInMemoryGenerateCache({ maxBytes: 100 });
    cache.set("a", { text: "old" });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    cache.set("a", { rawResponse: cycle });
    expect(cache.get("a")).toBeUndefined();
  });
  it("expires since write, without sliding TTL on reads", () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const cache = createInMemoryGenerateCache({ ttlMs: 100, maxEntries: 2 });
    cache.set("old", { text: "old" });
    vi.setSystemTime(1050); cache.set("new", { text: "new" });
    cache.get("old");
    vi.setSystemTime(1100); cache.set("third", { text: "third" });
    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("new")).toEqual({ text: "new" });
    vi.setSystemTime(1150);
    expect(cache.get("new")).toBeUndefined();
    expect(cache.get("third")).toEqual({ text: "third" });
  });
  it("refreshes expiration on overwrite without retaining old expiry order", () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const cache = createInMemoryGenerateCache({ ttlMs: 100, maxEntries: 2 });
    cache.set("a", { text: "a" });
    vi.setSystemTime(1020); cache.set("b", { text: "b" });
    vi.setSystemTime(1050); cache.set("a", { text: "updated" });
    cache.get("b");
    vi.setSystemTime(1120); cache.set("c", { text: "c" });
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual({ text: "updated" });
  });
  it.each(["maxEntries", "maxBytes", "ttlMs"] as const)("validates %s", name => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createInMemoryGenerateCache({ [name]: value })).toThrow(/positive safe integer/);
    }
  });
});
