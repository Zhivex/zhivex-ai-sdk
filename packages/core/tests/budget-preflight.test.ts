import { describe, expect, it } from "vitest";

import {
  createBudgetGuard,
  evaluateAgentBudgetPreflight,
  getAgentBudgetStatus
} from "../src/safety-policy.js";
import type { AgentRunState } from "../src/types.js";

const createState = (overrides: Partial<AgentRunState> = {}): AgentRunState => ({
  schemaVersion: 1,
  runId: "run-1",
  provider: "test",
  modelId: "model",
  status: "running",
  messages: [],
  steps: [],
  toolResults: [],
  currentStep: 0,
  maxSteps: 10,
  outputText: "",
  pendingApprovals: [],
  ...overrides
});

describe("preventive agent budgets", () => {
  it("reports remaining model, tool, output, and total-token allowance", () => {
    const state = createState({
      currentStep: 2,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      steps: [
        {
          index: 1,
          status: "completed",
          request: { messages: [] },
          response: {
            messages: [
              {
                role: "assistant",
                parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "lookup", input: {} } }]
              }
            ]
          },
          toolResults: []
        }
      ]
    });

    expect(getAgentBudgetStatus(state, {
      maxSteps: 5,
      maxToolCalls: 3,
      maxOutputTokens: 8,
      maxTotalTokens: 20
    })).toMatchObject({
      consumption: { steps: 2, toolCalls: 1, inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      remaining: { steps: 3, toolCalls: 2, outputTokens: 5, totalTokens: 10 }
    });
  });

  it("blocks an already-over-budget resumed run before another model call", () => {
    const state = createState({
      currentStep: 2,
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 }
    });
    const guard = createBudgetGuard({ maxTotalTokens: 10 });
    let modelCalls = 0;

    const trigger = guard.inputGuardrail({
      runId: state.runId,
      messages: state.messages,
      state
    } as never);
    if (!trigger) {
      modelCalls += 1;
    }

    expect(modelCalls).toBe(0);
    expect(trigger).toMatchObject({
      triggered: true,
      metadata: { budgetLimit: "maxTotalTokens", actual: 13, limit: 10 }
    });
  });

  it("reserves capacity before model and tool operations", () => {
    const modelState = createState({
      currentStep: 2,
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 }
    });
    const toolState = createState({
      steps: [
        {
          index: 1,
          status: "completed",
          request: { messages: [] },
          response: {
            messages: [
              {
                role: "assistant",
                parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "write", input: {} } }]
              }
            ]
          },
          toolResults: []
        }
      ]
    });

    expect(evaluateAgentBudgetPreflight(modelState, { maxSteps: 2 }, { operation: "model" })?.metadata).toMatchObject({
      budgetLimit: "maxSteps",
      remaining: 0,
      required: 1,
      operation: "model"
    });
    expect(evaluateAgentBudgetPreflight(modelState, {
      maxOutputTokens: 6,
      maxTotalTokens: 12
    }, {
      operation: "model",
      requestedOutputTokens: 3
    })?.metadata).toMatchObject({
      budgetLimit: "maxOutputTokens",
      remaining: 2,
      required: 3
    });
    expect(evaluateAgentBudgetPreflight(toolState, { maxToolCalls: 1 }, { operation: "tool" })?.metadata).toMatchObject({
      budgetLimit: "maxToolCalls",
      remaining: 0,
      required: 1,
      operation: "tool"
    });
  });
});
