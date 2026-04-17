import { expect, it } from "vitest";
import { z } from "zod";

import {
  createAgent,
  resumeAgent,
  runAgent,
  streamAgent,
  tool,
  type AgentApprovalResponse,
  type AgentSupportTier,
  type LanguageModel,
  type ToolSet
} from "../src/index.js";

interface AgentProviderContractOptions {
  providerName: string;
  modelId: string;
  expectedAgentTier: AgentSupportTier;
  createModel: () => LanguageModel;
  mockSimpleRun: () => void;
  mockToolRun: () => void;
  mockStreamRun: () => void;
  mockApprovalRun?: () => void;
  mockApprovalResume?: () => void;
  createApprovalTools?: () => ToolSet;
}

const weatherTool = tool({
  name: "weather",
  schema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, forecast: "sunny" })
});

export const runAgentProviderContractSuite = (options: AgentProviderContractOptions) => {
  it("runs agents to completion and persists serializable state", async () => {
    options.mockSimpleRun();

    const result = await runAgent(
      createAgent({
        model: options.createModel(),
        maxSteps: 2
      }),
      {
        prompt: "Say hello"
      }
    );

    expect(result.status).toBe("completed");
    expect(result.outputText.length).toBeGreaterThan(0);
    expect(result.state).toMatchObject({
      provider: options.providerName,
      modelId: options.modelId,
      status: "completed",
      currentStep: 1
    });
    expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
  });

  it("supports local tool loops through the shared agent runtime", async () => {
    options.mockToolRun();

    const result = await runAgent(
      createAgent({
        model: options.createModel(),
        tools: {
          weather: weatherTool
        },
        maxSteps: 2
      }),
      {
        prompt: "Use the weather tool."
      }
    );

    expect(result.status).toBe("completed");
    expect(result.outputText.length).toBeGreaterThan(0);
    expect(result.steps).toHaveLength(2);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      toolName: "weather",
      output: { city: "Madrid", forecast: "sunny" },
      isError: false
    });
    expect(result.toolResults[0]?.toolCallId).toBeTypeOf("string");
  });

  it("streams agent lifecycle events and final output", async () => {
    options.mockStreamRun();

    const result = streamAgent(
      createAgent({
        model: options.createModel(),
        maxSteps: 2
      }),
      {
        prompt: "Say hello"
      }
    );

    const textChunks: string[] = [];
    const eventTypes: string[] = [];

    await Promise.all([
      (async () => {
        for await (const chunk of result.textStream) {
          textChunks.push(chunk);
        }
      })(),
      (async () => {
        for await (const event of result.eventStream) {
          eventTypes.push(event.type);
        }
      })()
    ]);

    const final = await result.collect();

    expect(textChunks.join("")).toBe(final.outputText);
    expect(final.status).toBe("completed");
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "agent-run-start",
        "agent-step-start",
        "text-delta",
        "finish",
        "agent-step-finish",
        "agent-run-finish"
      ])
    );
  });

  if (options.expectedAgentTier === "tier-a") {
    it("suspends and resumes agent runs for approval-based providers", async () => {
      if (!options.mockApprovalRun || !options.mockApprovalResume || !options.createApprovalTools) {
        throw new Error(`Provider "${options.providerName}" must define approval mocks for tier-a agent tests.`);
      }

      const agent = createAgent({
        model: options.createModel(),
        tools: options.createApprovalTools(),
        maxSteps: 2
      });

      options.mockApprovalRun();
      const suspended = await runAgent(agent, {
        prompt: "Use MCP"
      });

      expect(suspended.status).toBe("suspended");
      expect(suspended.state.pendingApprovals).toHaveLength(1);

      const pendingApproval = suspended.state.pendingApprovals[0];
      const approval: AgentApprovalResponse = {
        provider: options.providerName,
        approvalRequestId: pendingApproval!.id,
        approve: true
      };

      options.mockApprovalResume();
      const resumed = await resumeAgent(agent, {
        state: suspended.state,
        approvals: [approval]
      });

      expect(resumed.status).toBe("completed");
      expect(resumed.outputText.length).toBeGreaterThan(0);
      expect(resumed.state.pendingApprovals).toEqual([]);
      expect(resumed.state.currentStep).toBe(2);
    });
  }
};
