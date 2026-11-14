import { expect, it } from "vitest";
import { z } from "zod";
import { createInMemoryGenerateCache, createMockLanguageModel, streamObject } from "../src/index.js";

it("exposes bounded caching and configurable object snapshots through the SDK", async () => {
  const cache = createInMemoryGenerateCache({ maxEntries: 1 });
  await cache.set("old", { text: "old" }); await cache.set("new", { text: "new" });
  expect(await cache.get("old")).toBeUndefined();
  const model = createMockLanguageModel({ streamEvents: [[
    { type: "text-delta", textDelta: '{"value":' },
    { type: "text-delta", textDelta: '42}' },
    { type: "finish", finishReason: "stop" }
  ]] });
  const result = streamObject({ model, prompt: "x", schema: z.object({ value: z.number() }), snapshotIntervalChars: 1024 });
  const snapshots = [];
  for await (const event of result.eventStream) if (event.type === "object-delta") snapshots.push(event);
  expect(snapshots).toEqual([{ type: "object-delta", textDelta: '{"value":42}', partialText: '{"value":42}' }]);
  expect((await result.collect()).object).toEqual({ value: 42 });
});
