import { expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "../src/agent/instance.js";
import { createMockLanguageModel } from "../src/agent-evaluation.js";
import { generateText, streamText } from "../src/generate-text.js";
import { streamObject } from "../src/generate-object.js";
import { ValidationError } from "../src/errors.js";

const textResponse = { text: "ok", messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "ok" }] }], finishReason: "stop" as const };
const streamBuffer = { maxHistory: 8, maxSubscriberQueue: 2, replayOverflow: "drop-oldest" as const };

it.each([NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid maxSteps %s before model execution", async maxSteps => {
  const model = createMockLanguageModel();
  const generate = vi.spyOn(model, "generate");
  const stream = vi.spyOn(model, "stream");
  await expect(generateText({ model, prompt: "test", maxSteps })).rejects.toThrow(ValidationError);
  expect(() => streamText({ model, prompt: "test", maxSteps })).toThrow(/maxSteps/);
  const agent = new Agent({ model });
  await expect(agent.run({ prompt: "test", maxSteps })).rejects.toThrow(/maxSteps/);
  await expect(agent.stream({ prompt: "test", maxSteps }).collect()).rejects.toThrow(/maxSteps/);
  expect(generate).not.toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
});

it("keeps a long live text stream complete while bounding late replay", async () => {
  const model = createMockLanguageModel({ streamEvents: [Array.from({ length: 5000 }, () => ({ type: "text-delta" as const, textDelta: "x" }))] });
  const result = streamText({ model, prompt: "test", streamBuffer });
  let text = "";
  for await (const chunk of result.textStream) text += chunk;
  expect(text).toHaveLength(5000);
  expect((await result.collect()).text).toBe(text);
  const replay = [];
  for await (const event of result.eventStream) replay.push(event);
  expect(replay.filter(event => event.type === "text-delta")).toHaveLength(8);
  expect(replay.at(-1)?.type).toBe("finish");
});

it("forwards replay configuration through agent streaming", async () => {
  const model = createMockLanguageModel({ streamEvents: [[...Array.from({ length: 5000 }, () => ({ type: "text-delta" as const, textDelta: "x" })), { type: "finish", finishReason: "stop" }]] });
  const result = new Agent({ model, streamBuffer }).stream({ prompt: "test" });
  let count = 0;
  for await (const chunk of result.textStream) count += chunk.length;
  expect(count).toBe(5000);
  expect((await result.collect()).status).toBe("completed");
});

it("forwards replay configuration through object streaming", async () => {
  const json = JSON.stringify({ text: "x".repeat(5000) });
  const model = createMockLanguageModel({ streamEvents: [[...Array.from(json, textDelta => ({ type: "text-delta" as const, textDelta })), { type: "finish", finishReason: "stop" }]] });
  const result = streamObject({ model, prompt: "test", schema: z.object({ text: z.string() }), streamBuffer });
  expect((await result.collect()).object).toEqual({ text: "x".repeat(5000) });
});

it("accepts input context and gives guardrails the transformed output", async () => {
  const seen: number[] = [];
  const agent = new Agent({
    model: createMockLanguageModel({ responses: [textResponse] }),
    contextSchema: z.object({ count: z.string().transform(Number) }),
    inputGuardrails: [({ context }) => { seen.push(context!.count); }]
  });
  expect((await agent.run({ prompt: "test", context: { count: "42" } })).status).toBe("completed");
  expect(seen).toEqual([42]);
});

it("preserves the documented text-only error contract and collect rejection", async () => {
  const error = new Error("provider failed");
  const result = streamText({ model: createMockLanguageModel({ streamEvents: [[{ type: "text-delta", textDelta: "partial" }, { type: "error", error }]] }), prompt: "test" });
  let text = "";
  for await (const chunk of result.textStream) text += chunk;
  expect(text).toBe("partial");
  await expect(result.collect()).rejects.toBe(error);
});
