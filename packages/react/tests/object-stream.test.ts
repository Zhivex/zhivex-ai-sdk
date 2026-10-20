import { describe, expect, it } from "vitest";
import { applyObjectStreamEvent, createObjectStreamState, readServerSentEvents } from "../src/object-stream.js";

describe("object stream events", () => {
  it("repairs text deltas the way streamObject exposes partial objects", () => {
    let state = createObjectStreamState<{ priority?: string; team?: string }>();
    state = applyObjectStreamEvent(state, { type: "text-delta", textDelta: "{\"priority\":\"hi" });
    expect(state.object).toEqual({ priority: "hi" });
    state = applyObjectStreamEvent(state, { type: "object-delta", textDelta: "gh\",\"team\":", partialText: "{\"priority\":\"high\",\"team\":" });
    expect(state.object).toEqual({ priority: "high", team: null });
    state = applyObjectStreamEvent(state, { type: "object-partial", partialObject: { priority: "high", team: "ops" } });
    expect(state.object).toEqual({ priority: "high", team: "ops" });
    state = applyObjectStreamEvent(state, { type: "object-complete", object: { priority: "high", team: "ops" } });
    expect(state).toMatchObject({ done: true, object: { priority: "high", team: "ops" } });
  });

  it("stops on an object stream error and ignores unknown events", () => {
    const start = createObjectStreamState();
    expect(applyObjectStreamEvent(start, { type: "finish" })).toBe(start);
    const failed = applyObjectStreamEvent(start, { type: "error", error: { message: "bad json" } });
    expect(failed.done).toBe(true);
    expect(failed.error?.message).toBe("bad json");
  });

  it("reads bounded SSE object events", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "event: object-partial\ndata: {\"type\":\"object-partial\",\"partialObject\":{\"priority\":\"high\"}}\n\n",
      "event: object-complete\ndata: {\"type\":\"object-complete\",\"object\":{\"priority\":\"high\"}}\n\n"
    ];
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    });
    const response = new Response(body, { status: 200 });
    const events = [];
    for await (const event of readServerSentEvents(response)) events.push(event);
    expect(events).toEqual([
      { type: "object-partial", partialObject: { priority: "high" } },
      { type: "object-complete", object: { priority: "high" } }
    ]);
  });
});
