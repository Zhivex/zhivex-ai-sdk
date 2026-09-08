import { expect, it, vi } from "vitest";
import { z } from "zod";
import { generateObject, streamObject, tool, type LanguageModel } from "../src/index.js";

it.each([false, true])("object generation forwards hooks and toolChoice through SDK, streaming=%s", async (streaming) => {
  const onBeforeModelStep = vi.fn();
  const prepareModelMessages = vi.fn(() => [{ role: "user" as const, parts: [{ type: "text" as const, text: "prepared" }] }]);
  const generate: LanguageModel["generate"] = async (input) => {
    expect(input.toolChoice).toBe("none");
    expect(input.messages[0]?.parts).toEqual([{ type: "text", text: "prepared" }]);
    return { text: '{"ok":true}', messages: [], finishReason: "stop" };
  };
  const model: LanguageModel = {
    provider: "test", modelId: "test",
    capabilities: { streaming: true, tools: true, toolChoice: true, structuredOutput: true, jsonMode: true, parallelToolCalls: false, vision: false, files: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false },
    generate,
    stream: async (input) => {
      const result = await generate(input);
      return (async function* () {
        yield { type: "text-delta" as const, textDelta: result.text! };
        yield { type: "finish" as const, finishReason: "stop" as const };
      })();
    }
  };
  const options = { tools: { unused: tool({ name: "unused", schema: z.object({}), execute: () => { throw new Error("must not execute"); } }) }, model, prompt: "original", schema: z.object({ ok: z.boolean() }), toolChoice: "none" as const, prepareModelMessages, onBeforeModelStep };
  const result = streaming ? await streamObject(options).collect() : await generateObject(options);
  expect(result.object).toEqual({ ok: true });
  expect(onBeforeModelStep).toHaveBeenCalledTimes(1);
  expect(prepareModelMessages).toHaveBeenCalledTimes(1);
});
