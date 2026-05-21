import { z } from "zod";

import {
  createAdvancedToolRegistry,
  createAgent,
  createAgentCapabilityRouter,
  createAgentCapsule,
  createAgentControlPlane,
  createAgentToolPolicy,
  createInMemoryAgentRunStore,
  createTextMessage,
  inspectAgentCapsule,
  promoteAgentGoldenTrace,
  tool,
  type LanguageModel
} from "../../packages/sdk/src/index";

import { section } from "../_shared";

const capabilities: LanguageModel["capabilities"] = {
  streaming: false,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: true,
  webSearch: true,
  agentCapabilities: {
    supportTier: "tier-a",
    approvalRequests: true,
    hostedWebSearch: true,
    hostedFileSearch: false,
    remoteMcp: true,
    computerUse: false,
    codeExecution: true,
    shell: false,
    applyPatch: false,
    toolSearch: false,
    webExtraction: false,
    skills: true,
    toolsets: true,
    toolChoiceNone: true
  }
};

let calls = 0;

const model: LanguageModel = {
  provider: "example",
  modelId: "control-plane-deterministic",
  capabilities,
  async generate() {
    calls += 1;
    if (calls === 1) {
      return {
        finishReason: "tool-calls",
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        messages: [
          {
            role: "assistant",
            parts: [{ type: "tool-call", toolCall: { id: "call_1", name: "lookupLedger", input: { accountId: "acct_123" } } }]
          }
        ]
      };
    }

    return {
      text: "Account acct_123 reconciles with no exceptions.",
      finishReason: "stop",
      usage: { inputTokens: 60, outputTokens: 16, totalTokens: 76 },
      messages: [createTextMessage("assistant", "Account acct_123 reconciles with no exceptions.")]
    };
  }
};

const tools = createAdvancedToolRegistry([
  {
    tool: tool({
      name: "lookupLedger",
      description: "Reads a ledger account from an app-owned finance system.",
      schema: z.object({ accountId: z.string() }),
      execute: ({ accountId }) => ({ accountId, balance: 1200, exceptions: [] })
    }),
    source: "local",
    permissions: ["read"],
    audit: { riskLevel: "low", owner: "finance-ops", labels: ["ledger"] }
  }
]);

const agent = createAgent({
  id: "finance-control-plane",
  model,
  maxSteps: 3,
  tools,
  toolApprovalPolicy: createAgentToolPolicy({ mode: "read-only" })
});

const capsule = createAgentCapsule({
  id: "finance-control-plane",
  name: "Finance Control Plane Agent",
  version: "0.1.0",
  description: "Deterministic example of portable governance metadata around an agent.",
  agent,
  skills: [{ id: "finance-reconciliation", path: ".agents/skills/finance-reconciliation/SKILL.md" }],
  evaluations: [{ name: "happy-path", datasetSize: 1 }],
  policy: { toolPolicyMode: "read-only", redaction: true }
});

const router = createAgentCapabilityRouter([model]);
const store = createInMemoryAgentRunStore();
const controlPlane = createAgentControlPlane({
  agent: { ...agent, store },
  pricing: { inputCostPer1kTokens: 0.01, outputCostPer1kTokens: 0.02, currency: "USD" }
});

section("Capsule");
console.log(inspectAgentCapsule(capsule));

section("Capability routing");
console.log(router.select({ minTier: "tier-b", approvals: true, remoteMcp: true }).reasons);

section("Run ledger");
const record = await controlPlane.run({ prompt: "Reconcile acct_123" });
console.log({
  status: record.summary.status,
  toolCalls: record.summary.toolCalls,
  cost: record.summary.cost,
  audit: record.audit
});

section("Golden trace");
console.log(promoteAgentGoldenTrace(record.ledger, { name: "finance-control-plane-happy-path" }).expectations);
