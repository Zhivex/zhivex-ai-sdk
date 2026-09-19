import { expect, it } from "vitest";
import { streamText, type LanguageModel } from "../src/index.js";

it("preserves error events and collect rejection through the SDK facade", async () => {
  const error = new Error("fixture");
  const model: LanguageModel = {
    provider: "fixture", modelId: "fixture",
    capabilities: { streaming: true, tools: false, structuredOutput: false, jsonMode: false, toolChoice: false, parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false },
    async generate() { throw error; },
    async stream() { throw error; }
  };
  const result = streamText({ model, prompt: "fixture" });
  const events = [];
  for await (const event of result.eventStream) events.push(event);
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(result.collect()).rejects.toBe(error);
  expect(events).toEqual([{ type: "error", error }]);
});
