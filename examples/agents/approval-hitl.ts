import {
  Agent,
  createAgentApprovalQueue,
  type LanguageModel
} from "../../packages/agents/src/index";

import { section } from "../_shared";

let calls = 0;

const model: LanguageModel = {
  provider: "example",
  modelId: "approval-deterministic",
  capabilities: {
    streaming: false,
    tools: true,
    structuredOutput: false,
    jsonMode: false,
    toolChoice: true,
    parallelToolCalls: false,
    vision: false,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false,
    agentCapabilities: {
      supportTier: "tier-a",
      approvalRequests: true,
      remoteMcp: true,
      hostedWebSearch: false,
      hostedFileSearch: false,
      computerUse: false,
      codeExecution: false,
      shell: false,
      applyPatch: false,
      toolSearch: false,
      webExtraction: false,
      skills: false,
      toolsets: false,
      toolChoiceNone: true
    }
  },
  async generate(input) {
    calls += 1;

    if (calls === 1) {
      return {
        text: "Need approval before using remote MCP.",
        finishReason: "stop",
        messages: [
          {
            role: "assistant",
            parts: [
              {
                type: "provider-data",
                provider: "openai",
                data: {
                  type: "mcp_approval_request",
                  id: "mcpr_demo",
                  name: "remote_docs",
                  arguments: "{\"query\":\"release notes\"}",
                  server_label: "docs"
                }
              }
            ]
          }
        ]
      };
    }

    const approved = input.messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === "provider-data" &&
          part.provider === "openai" &&
          (part.data as { type?: string }).type === "mcp_approval_response"
      )
    );

    return {
      text: approved ? "Approval received; continuing with remote docs." : "Approval response missing.",
      finishReason: "stop",
      messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "text",
              text: approved ? "Approval received; continuing with remote docs." : "Approval response missing."
            }
          ]
        }
      ]
    };
  }
};

const agent = new Agent({
  id: "approval-hitl-example",
  model,
  instructions: "Pause when the provider requests approval.",
  maxSteps: 2
});

section("Initial run");
const waiting = await agent.run({
  prompt: "Fetch release docs from the remote MCP server."
});
console.log({
  status: waiting.status,
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
  outputText: resumed.outputText
});
