import { expect, it } from "vitest";
import { ProviderToolCallError } from "../src/errors.js";
import { createFailedState } from "../src/agent/common.js";
import { getAgentBudgetStatus } from "../src/safety-policy.js";
import { createAgent, createInMemoryAgentRunStore } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";
import { persistFailureState } from "../src/agent/state.js";
import { projectChildRun } from "../src/agent/children.js";
import type { AgentRunState } from "../src/types.js";

it("retains a confirmed prefix without presenting uncertain consumption as a complete receipt", () => {
  const usage = { inputTokens: 4, outputTokens: 3, totalTokens: 7 };
  const error = new ProviderToolCallError({ provider: "openai", diagnosticCode: "OPENAI_PTC_REQUEST_FAILED", reason: "response_failed", effectsPossible: true, confirmedUsage: usage, usageComplete: false, providerRequestCount: 2 });
  expect(error.usage).toBeUndefined();
  expect(error.confirmedUsage).toEqual(usage);
  expect(Object.isFrozen(error.confirmedUsage)).toBe(true);
  const state: AgentRunState = { schemaVersion: 1, runId: "root", status: "running", provider: "test", modelId: "test", currentStep: 1, maxSteps: 3, messages: [], steps: [], toolResults: [], pendingApprovals: [], outputText: "", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  const failed = createFailedState(state, error);
  expect(failed.usage).toMatchObject({ inputTokens: 5, outputTokens: 4, totalTokens: 9 });
  expect(failed.error).toMatchObject({ confirmedUsage: usage, usageComplete: false, providerRequestCount: 2 });
  expect(getAgentBudgetStatus(failed, {}).unknownUsageRunIds).toEqual(["root"]);
  expect(projectChildRun(failed).unknownProviderUsage).toBe(true);
});

it("rejects malformed lower bounds and never exposes them as confirmed usage", () => {
  const error = new ProviderToolCallError({ provider: "openai", diagnosticCode: "bad", reason: "response_failed", confirmedUsage: { inputTokens: -1, outputTokens: 3 }, usageComplete: false, providerRequestCount: -1 });
  expect(error.usage).toBeUndefined(); expect(error.confirmedUsage).toBeUndefined(); expect(error.providerRequestCount).toBeUndefined();
});

it("preserves uncertain provider receipts in the emergency state-size checkpoint", async () => {
  const store = createInMemoryAgentRunStore();
  const initial: AgentRunState = { schemaVersion: 1, revision: 0, runId: "bounded", status: "running", provider: "test", modelId: "test", currentStep: 0, maxSteps: 3, messages: [], steps: [], toolResults: [], pendingApprovals: [], outputText: "", updatedAt: Date.now() };
  await store.save(initial, { expectedRevision: 0 });
  const durable = (await store.load("bounded"))!;
  const usage = { inputTokens: 4, outputTokens: 3, totalTokens: 7 };
  const error = new ProviderToolCallError({ provider: "openai", diagnosticCode: "OPENAI_PTC_REQUEST_FAILED", reason: "response_failed", effectsPossible: true, confirmedUsage: usage, usageComplete: false, providerRequestCount: 2 });
  const failed = createFailedState(durable, error);
  const limit = new TextEncoder().encode(JSON.stringify(durable)).byteLength + 30;
  await persistFailureState(createAgent({ model: createMockLanguageModel(), store }), failed, { maxStateBytes: limit });
  expect(await store.load("bounded")).toMatchObject({ status: "failed", usage, error: { diagnosticCode: "OPENAI_PTC_REQUEST_FAILED", confirmedUsage: usage, usageComplete: false, providerRequestCount: 2, effectsPossible: true } });
});
