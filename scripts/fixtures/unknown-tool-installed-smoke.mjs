import assert from "node:assert/strict";
import { Agent } from "@zhivex-ai/agents";
import { createInMemoryAgentRunStore, tool } from "@zhivex-ai/core";
import { generateText, streamText, ToolNotRegisteredError } from "@zhivex-ai/sdk";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { z } from "zod";

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 };
for (const mode of ["generate", "stream", "agent", "agent-stream"]) {
  for (const recover of [false, true]) {
    const unknown = { id: "unknown", name: "not_in_catalog", input: { secret: "private-value" } };
    const valid = { id: "valid", name: "inspect", input: {} };
    const responses = [unknown, valid].map(toolCall => ({ messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall }] }], finishReason: "tool-calls", usage }));
    responses.push({ text: "done", messages: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }], finishReason: "stop", usage });
    const model = createMockLanguageModel({ responses, streamEvents: responses.map(response => [
      ...response.messages.flatMap(message => message.parts.map(part => part.type === "tool-call" ? { type: "tool-call", toolCall: part.toolCall } : { type: "text-delta", textDelta: part.text })),
      { type: "finish", finishReason: response.finishReason, usage }
    ]) });
    let executions = 0, approvals = 0;
    const store = createInMemoryAgentRunStore();
    const options = { model, maxSteps: 3, prompt: "Inspect", toolExecution: { unknownToolMode: recover ? "tool-result" : "throw", stopOnError: false },
      toolApprovalPolicy: () => { approvals++; return true; },
      tools: { inspect: tool({ name: "inspect", schema: z.object({}), execute: () => { executions++; return "ok"; } }) }
    };
    let output, failure;
    try {
      if (mode === "generate") output = await generateText(options);
      else if (mode === "agent") output = await new Agent({ ...options, store }).run({ runId: "fixture", prompt: "Inspect" });
      else {
        const stream = mode === "stream" ? streamText(options) : new Agent({ ...options, store }).stream({ runId: "fixture", prompt: "Inspect" });
        [output] = await Promise.all([stream.collect(), Array.fromAsync(stream.eventStream)]);
      }
    } catch (error) { failure = error; }
    assert.equal(executions, recover ? 1 : 0);
    assert.equal(approvals, recover ? 1 : 0);
    if (recover) {
      assert.equal(failure, undefined);
      assert.equal(output.usage.inputTokens, 300);
      assert.equal(output.toolResults[0].error.code, "TOOL_NOT_REGISTERED");
    } else {
      assert(failure instanceof ToolNotRegisteredError);
      assert.deepEqual(failure.usage, usage);
      assert.equal(failure.finishReason, "tool-calls");
      assert(!JSON.stringify(failure).includes("private-value"));
    }
    if (mode.startsWith("agent")) {
      const state = await store.load("fixture");
      assert.equal(state.steps.length, recover ? 3 : 1);
      assert.equal(state.usage.inputTokens, recover ? 300 : 100);
      assert.equal(state.toolResults[0].error.code, "TOOL_NOT_REGISTERED");
    }
  }
}
console.log("Installed packages: unknown-tool strict accounting and recovery passed in generate, stream, Agent and Agent.stream.");
