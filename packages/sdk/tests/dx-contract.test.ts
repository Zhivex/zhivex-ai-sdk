import { expect, it } from "vitest";
import { streamText, generateText, ValidationError } from "../src/index.js";
import { createMockLanguageModel } from "../../core/src/agent-evaluation.js";
import { ConflictError, ValidationError as AgentValidationError } from "../../agents/src/index.js";
import { ConflictError as CoreConflictError } from "../../core/src/errors.js";

it("shares error constructors across public facades", () => {
  expect(ConflictError).toBe(CoreConflictError);
  expect(AgentValidationError).toBe(ValidationError);
});

it("exposes streaming retention configuration and maxSteps validation through SDK", async () => {
  const model = createMockLanguageModel({ streamEvents: [[{ type: "text-delta", textDelta: "a" }, { type: "text-delta", textDelta: "b" }]] });
  await expect(generateText({ model, prompt: "test", maxSteps: NaN })).rejects.toThrow(ValidationError);
  const stream = streamText({ model, prompt: "test", streamBuffer: { maxHistory: 1, replayOverflow: "drop-oldest" } });
  expect((await stream.collect()).text).toBe("ab");
});

it("shares descendant accounting state between SDK and agents facades", async () => {
  const { createAgent, runAgent, createTextMessage } = await import("../src/index.js");
  const { getAgentBudgetStatus } = await import("../../agents/src/index.js");
  const result = await runAgent(createAgent({ model: createMockLanguageModel({ responses: [{ messages: [createTextMessage("assistant", "done")], text: "done", usage: { totalTokens: 3 } }] }) }), { prompt: "test" });
  result.state.childRuns = [{ runId: "failed-child", status: "failed", outputText: "", steps: 1, toolCalls: 0, toolErrors: 0, usage: { totalTokens: 5 } }];
  expect(getAgentBudgetStatus(result.state, {}).consumption.totalTokens).toBe(8);
  expect(getAgentBudgetStatus(result.state, { includeChildRuns: false }).consumption.totalTokens).toBe(3);
});
