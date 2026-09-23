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
