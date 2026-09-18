import { describe, expect, it } from "vitest";

import { createSubAgentTool } from "../src/agent.js";
import { createMockLanguageModel } from "../src/testing.js";

describe("subagent tool names", () => {
  const model = createMockLanguageModel();

  it.each([
    ["researcher", "researcher"],
    ["__Research--Agent_42__", "Research_Agent_42"],
    [" /áé/ analyst 🤖 ", "analyst"],
    ["a___b", "a___b"],
    ["", "agent"],
    ["_____", "agent"],
    [" /🤖/ ", "agent"]
  ])("normalizes %j without changing the naming contract", (id, expected) => {
    expect(createSubAgentTool({ agent: { id, model } }).name).toBe(`subagent_${expected}`);
  });

  it("uses the provider and model when the agent has no id", () => {
    const fallbackModel = { ...model, provider: "test-provider", modelId: "model/v1" };
    expect(createSubAgentTool({ agent: { model: fallbackModel } }).name)
      .toBe("subagent_test_provider_model_v1");
  });

  it("handles long internal and boundary underscore runs", () => {
    const underscores = "_".repeat(100_000);
    const id = `${underscores}a${underscores}b${underscores}`;
    expect(createSubAgentTool({ agent: { id, model } }).name)
      .toBe(`subagent_a${underscores}b`);
    expect(createSubAgentTool({ agent: { id: underscores, model } }).name)
      .toBe("subagent_agent");
  });

  it("preserves explicit name overrides and their precedence", () => {
    const agent = { id: "default", model };
    expect(createSubAgentTool({ agent, name: "alias" }).name).toBe("alias");
    expect(createSubAgentTool({ agent, name: "alias", toolName: "explicit" }).name)
      .toBe("explicit");
  });
});
