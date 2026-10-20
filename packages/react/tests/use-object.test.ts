// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useObject, type UseObjectResult } from "../src/use-object.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
});

const mount = async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const current: { value?: UseObjectResult<{ priority: string }> } = {};
  const events: unknown[] = [];
  const encoder = new TextEncoder();
  const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"type\":\"object-partial\",\"partialObject\":{\"priority\":\"hi\"}}\n\n"));
      controller.enqueue(encoder.encode("data: {\"type\":\"object-complete\",\"object\":{\"priority\":\"high\"}}\n\n"));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  await act(async () => {
    root.render(createElement(() => {
      const result = useObject<{ priority: string }>({
        api: "/api/object",
        fetch: fetchImpl,
        onPartial: (object) => events.push(object)
      });
      current.value = result;
      return null;
    }));
  });
  return { current, events };
};

describe("useObject", () => {
  it("publishes partial objects and then the completed object", async () => {
    const { current, events } = await mount();
    await act(async () => {
      await current.value!.submit({ prompt: "triage" });
    });
    expect(events).toEqual([{ priority: "hi" }]);
    expect(current.value?.object).toEqual({ priority: "high" });
    expect(current.value?.isLoading).toBe(false);
    expect(current.value?.error).toBeUndefined();
  });

  it("repairs text deltas into partial objects", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const current: { value?: UseObjectResult<{ priority?: string }> } = {};
    const partials: unknown[] = [];
    const encoder = new TextEncoder();
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"type\":\"text-delta\",\"textDelta\":\"{\\\"priority\\\":\\\"hi\"}\n\n"));
        controller.enqueue(encoder.encode("data: {\"type\":\"text-delta\",\"textDelta\":\"\\\"}\"}\n\n"));
        controller.enqueue(encoder.encode("data: {\"type\":\"object-complete\",\"object\":{\"priority\":\"high\"}}\n\n"));
        controller.close();
      }
    }), { status: 200 });
    await act(async () => {
      root.render(createElement(() => {
        current.value = useObject<{ priority?: string }>({
          fetch: fetchImpl,
          onPartial: (object) => partials.push(object)
        });
        return null;
      }));
    });
    await act(async () => {
      await current.value!.submit({ prompt: "triage" });
    });
    expect(partials).toEqual([{ priority: "hi" }]);
    expect(current.value?.object).toEqual({ priority: "high" });
  });

  it("records a failed response and clear resets it", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const current: { value?: UseObjectResult<unknown> } = {};
    const errors: string[] = [];
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 503 });
    await act(async () => {
      root.render(createElement(() => {
        current.value = useObject({
          fetch: fetchImpl,
          onError: (error) => errors.push(error.message)
        });
        return null;
      }));
    });
    await act(async () => {
      await current.value!.submit({ prompt: "triage" });
    });
    expect(current.value?.error?.message).toContain("503");
    expect(errors[0]).toContain("503");
    await act(async () => {
      current.value!.clear();
    });
    expect(current.value?.object).toBeUndefined();
    expect(current.value?.error).toBeUndefined();
  });

  it("stop aborts the request without recording an error", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const current: { value?: UseObjectResult<unknown> } = {};
    const fetchImpl: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("Missing abort signal."));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
    await act(async () => {
      root.render(createElement(() => {
        current.value = useObject({ fetch: fetchImpl });
        return null;
      }));
    });
    await act(async () => {
      const pending = current.value!.submit({ prompt: "triage" });
      await Promise.resolve();
      current.value!.stop();
      await pending;
    });
    expect(current.value?.error).toBeUndefined();
    expect(current.value?.isLoading).toBe(false);
  });
});
