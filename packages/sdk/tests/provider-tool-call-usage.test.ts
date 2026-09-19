import { expect, test } from "vitest";
import { ProviderToolCallError } from "../src/index.js";
test("SDK exposes validated terminal accounting on provider tool errors", () => {
  const error = new ProviderToolCallError({ provider: "openai", diagnosticCode: "FIXTURE", reason: "incomplete_arguments", usage: { inputTokens: 12, outputTokens: 8 } });
  expect(error.usage).toEqual({ inputTokens: 12, outputTokens: 8 });
  expect(error.retryable).toBe(false);
  expect(Object.isFrozen(error.usage)).toBe(true);
});
