import { expect, it } from "vitest";
import { z } from "zod";
import { generateText, tool, type ToolExecutionOptions } from "../src/index.js";
import { createMockLanguageModel } from "../../core/src/testing.js";

it("exposes opt-in schema recovery through SDK and sends structured errors to the next request", async () => {
  const model = createMockLanguageModel({ responses: [
    { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "bad", name: "read", input: { line: "invalid" } } }] }], finishReason: "tool-calls" },
    { messages: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }], text: "done", finishReason: "stop" }
  ] });
  const original = model.generate;
  let requests = 0;
  model.generate = async input => {
    if (++requests === 2) expect(input.messages.at(-1)).toMatchObject({ role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "bad", isError: true, error: { code: "TOOL_INPUT_VALIDATION_ERROR", issues: [{ code: "invalid_type", path: ["line"] }] } } }] });
    return original(input);
  };
  const toolExecution: ToolExecutionOptions = { validationErrorMode: "tool-result" };
  const result = await generateText({ model, prompt: "Read", maxSteps: 2, toolExecution,
    tools: { read: tool({ name: "read", schema: z.object({ line: z.number() }), execute: () => { throw new Error("must not execute"); } }) }
  });
  expect(result.text).toBe("done");
  expect(requests).toBe(2);
});
