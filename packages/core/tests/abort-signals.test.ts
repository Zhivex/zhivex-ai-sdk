import { describe, expect, it, vi } from "vitest";

import { createMergedAbortSignal, mergeAbortSignals } from "../src/index.js";

describe("abort signal composition", () => {
  it("forwards the first abort reason", () => {
    const first = new AbortController();
    const second = new AbortController();
    const merged = mergeAbortSignals(first.signal, second.signal);
    const reason = new Error("caller cancelled");

    second.abort(reason);

    expect(merged?.aborted).toBe(true);
    expect(merged?.reason).toBe(reason);
  });

  it("preserves an already-aborted reason", () => {
    const first = new AbortController();
    const reason = new DOMException("deadline", "TimeoutError");
    first.abort(reason);

    const merged = mergeAbortSignals(undefined, first.signal, new AbortController().signal);

    expect(merged?.aborted).toBe(true);
    expect(merged?.reason).toBe(reason);
  });

  it("offers explicit cleanup and avoids wrapping a single signal", () => {
    const controller = new AbortController();
    const single = createMergedAbortSignal(controller.signal);
    const empty = createMergedAbortSignal(undefined);

    expect(single.signal).toBe(controller.signal);
    expect(empty.signal).toBeUndefined();
    expect(single.cleanup()).toBeUndefined();
    expect(empty.cleanup()).toBeUndefined();
  });

  it("removes fallback listeners when explicitly cleaned up", () => {
    const abortSignalWithAny = AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal;
    };
    const nativeAny = abortSignalWithAny.any;
    Object.defineProperty(abortSignalWithAny, "any", {
      value: undefined,
      writable: true,
      configurable: true
    });

    try {
      const first = new AbortController();
      const second = new AbortController();
      const firstRemove = vi.spyOn(first.signal, "removeEventListener");
      const secondRemove = vi.spyOn(second.signal, "removeEventListener");
      const merged = createMergedAbortSignal(first.signal, second.signal);

      merged.cleanup();

      expect(firstRemove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(secondRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      Object.defineProperty(abortSignalWithAny, "any", {
        value: nativeAny,
        writable: true,
        configurable: true
      });
    }
  });

  it("deduplicates signals before registering fallback listeners", () => {
    const abortSignalWithAny = AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal;
    };
    const nativeAny = abortSignalWithAny.any;
    Object.defineProperty(abortSignalWithAny, "any", {
      value: undefined,
      writable: true,
      configurable: true
    });

    try {
      const first = new AbortController();
      const second = new AbortController();
      const firstAdd = vi.spyOn(first.signal, "addEventListener");
      const firstRemove = vi.spyOn(first.signal, "removeEventListener");
      const merged = createMergedAbortSignal(first.signal, first.signal, second.signal);

      merged.cleanup();

      expect(firstAdd).toHaveBeenCalledTimes(1);
      expect(firstRemove).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(abortSignalWithAny, "any", {
        value: nativeAny,
        writable: true,
        configurable: true
      });
    }
  });
});
