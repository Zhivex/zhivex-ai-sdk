import {
  Agent,
  type LanguageModel,
  tool
} from "../../packages/agents/src/index";
import { createAgentApprovalQueue } from "../../packages/agents/src/beta";
import { z } from "zod";

import { section } from "../_shared";

let modelCalls = 0;
let deployments = 0;

const model: LanguageModel = {
  provider: "example",
  modelId: "approval-deterministic",
  capabilities: {
    streaming: false,
    tools: true,
    structuredOutput: false,
    jsonMode: false,
    toolChoice: true,
    parallelToolCalls: true,
    vision: false,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false
  },
  async generate() {
    modelCalls += 1;

    if (modelCalls === 1) {
      return {
        finishReason: "tool-calls",
        messages: [{
          role: "assistant",
          parts: [{
            type: "tool-call",
            toolCall: {
              id: "deploy_demo",
              name: "deploy",
              input: { target: "staging" }
            }
          }]
        }]
      };
    }

    return {
      text: "Staging deployment completed after approval.",
      finishReason: "stop",
      messages: [{
        role: "assistant",
        parts: [{
          type: "text",
          text: "Staging deployment completed after approval."
        }]
      }]
    };
  }
};

const agent = new Agent({
  id: "approval-hitl-example",
  model,
  instructions: "Use the deployment tool when asked.",
  tools: {
    deploy: tool({
      name: "deploy",
      description: "Deploy an application to an environment.",
      schema: z.object({ target: z.string() }),
      requiresApproval: true,
      approvalMode: "interrupt",
      approvalVersion: "2026-07-29",
      execute({ target }) {
        deployments += 1;
        return { target, deployed: true };
      }
    })
  },
  maxSteps: 2
});

section("Initial run");
const waiting = await agent.run({
  prompt: "Deploy the application to staging."
});
console.log({
  status: waiting.status,
  deployments,
  pendingApprovals: waiting.state.pendingApprovals
});

section("Approval queue");
console.log(
  createAgentApprovalQueue(waiting.state, {
    tokenPrefix: "demo",
    resumeUrl: "/runs/demo/resume"
  })
);

section("Resume");
const resumed = await agent.resume({
  state: waiting.state,
  approvals: waiting.state.pendingApprovals.map((request) => ({
    provider: request.provider,
    approvalRequestId: request.id,
    approve: true,
    reason: "Demo approval"
  }))
});

console.log({
  status: resumed.status,
  deployments,
  outputText: resumed.outputText,
  approvalHistory: resumed.state.approvalHistory
});
