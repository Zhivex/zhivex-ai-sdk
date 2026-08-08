import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdvancedToolRegistry,
  createAgent,
  createAgentApprovalQueue,
  createAgentCapabilityRouter,
  createAgentCapsule,
  createAgentControlPlane,
  createAgentRunLedger,
  createAgentTraceArtifact,
  createAgentToolPolicy,
  createInMemoryAgentRunStore,
  createMockLanguageModel,
  createTextMessage,
  createProductionTraceOptions,
  diffAgentRunLedgers,
  inspectAgentCapsule,
  promoteAgentGoldenTrace,
  runAgent,
  selectAgentModel,
  tool,
  type AgentRunState,
  type ToolApprovalRequest
} from "../src/index.js";

const createTierAModel = () =>
  createMockLanguageModel({
    provider: "openai",
    modelId: "gpt-agent",
    capabilities: {
      tools: true,
      toolChoice: true,
      structuredOutput: true,
      reasoning: true,
      webSearch: true,
      agentCapabilities: {
        supportTier: "tier-a",
        approvalRequests: true,
        remoteMcp: true,
        hostedWebSearch: true,
        codeExecution: true,
        shell: true,
        toolChoiceNone: true,
        hostedFileSearch: false,
        computerUse: false,
        applyPatch: false,
        toolSearch: false,
        webExtraction: false,
        skills: true,
        toolsets: true
      }
    },
    responses: [
      {
        messages: [createTextMessage("assistant", "done")],
        text: "done",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      }
    ]
  });

const createStreamingTierAModel = () =>
  createMockLanguageModel({
    provider: "openai",
    modelId: "gpt-agent",
    capabilities: {
      tools: true,
      streaming: true,
      toolChoice: true,
      structuredOutput: true,
      reasoning: true,
      webSearch: true,
      agentCapabilities: {
        supportTier: "tier-a",
        approvalRequests: true,
        remoteMcp: true,
        hostedWebSearch: true,
        codeExecution: true,
        shell: true,
        toolChoiceNone: true,
        hostedFileSearch: false,
        computerUse: false,
        applyPatch: false,
        toolSearch: false,
        webExtraction: false,
        skills: true,
        toolsets: true
      }
    },
    streamEvents: [[
      { type: "text-delta", textDelta: "done" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
    ]]
  });

const baseState = (overrides: Partial<AgentRunState> = {}): AgentRunState => ({
  schemaVersion: 1,
  runId: "run_1",
  agentId: "agent_1",
  provider: "openai",
  modelId: "gpt-agent",
  status: "completed",
  messages: [createTextMessage("assistant", "done")],
  steps: [
    {
      index: 1,
      status: "completed",
      startedAt: 10,
      finishedAt: 20,
      request: { messages: [createTextMessage("user", "Run lookup")] },
      response: {
        messages: [
          {
            role: "assistant",
            parts: [{ type: "tool-call", toolCall: { id: "call_1", name: "lookup", input: { id: "1" } } }]
          }
        ],
        finishReason: "tool-calls"
      },
      toolResults: [{ toolCallId: "call_1", toolName: "lookup", output: { ok: true }, isError: false }]
    },
    {
      index: 2,
      status: "completed",
      startedAt: 21,
      finishedAt: 30,
      request: { messages: [createTextMessage("tool", "ok")] },
      response: {
        messages: [createTextMessage("assistant", "done")],
        text: "done",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      },
      toolResults: []
    }
  ],
  toolResults: [{ toolCallId: "call_1", toolName: "lookup", output: { ok: true }, isError: false }],
  currentStep: 2,
  maxSteps: 4,
  outputText: "done",
  finishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  pendingApprovals: [],
  startedAt: 10,
  updatedAt: 30,
  metadata: { tenant: "test" },
  ...overrides
});

describe("agent control plane", () => {
  it("creates portable capsules and flags risky tools without approvals", () => {
    const registry = createAdvancedToolRegistry();
    registry.register({
      tool: tool({
        name: "delete_customer",
        schema: z.object({ id: z.string() }),
        requiresApproval: false,
        execute: async () => ({ ok: true })
      }),
      source: "local",
      permissions: ["write", "external-side-effect"],
      audit: { riskLevel: "critical", owner: "ops", labels: ["customer-data"] }
    });

    const agent = createAgent({
      id: "finance-risk",
      model: createTierAModel(),
      tools: registry
    });

    const capsule = createAgentCapsule({
      id: "finance-risk",
      name: "Finance Risk Agent",
      version: "1.0.0",
      agent,
      skills: [{ id: "reconciliation", path: ".agents/skills/reconciliation/SKILL.md" }],
      mcpServers: [{ name: "ledger", transport: "http", url: "https://mcp.example.test", riskLevel: "high" }]
    });

    expect(capsule.manifest).toMatchObject({
      schemaVersion: 1,
      id: "finance-risk",
      provider: "openai",
      modelId: "gpt-agent",
      agentTier: "tier-a"
    });
    expect(capsule.manifest.tools[0]).toMatchObject({
      name: "delete_customer",
      permissions: ["external-side-effect", "write"],
      riskLevel: "critical",
      owner: "ops"
    });
    expect(inspectAgentCapsule(capsule).warnings).toEqual(
      expect.arrayContaining([
        'Tool "delete_customer" has write or critical risk without approval.',
        'MCP server "ledger" is high risk but has no declared permissions.'
      ])
    );
  });

  it("applies tool policy decisions from advanced registry metadata", () => {
    const writeTool = createAdvancedToolRegistry([
      {
        tool: tool({
          name: "charge_card",
          schema: z.object({ amount: z.number() }),
          execute: async () => ({ ok: true })
        }),
        permissions: ["external-side-effect"],
        audit: { riskLevel: "high" }
      }
    ]).get("charge_card");

    if (!writeTool || !("execute" in writeTool)) {
      throw new Error("Expected callable test tool.");
    }

    const policy = createAgentToolPolicy({ mode: "deny-write" });
    const request = {
      tool: writeTool,
      toolCall: { id: "call_1", name: "charge_card", input: { amount: 10 } },
      input: { amount: 10 },
      step: 1,
      model: createTierAModel()
    } satisfies ToolApprovalRequest;

    expect(policy(request)).toMatchObject({
      approved: false,
      reason: 'Tool "charge_card" requests write permissions.'
    });

    const undeclared = tool({
      name: "delete_everything",
      schema: z.object({}),
      execute: async () => ({ deleted: true })
    });
    expect(createAgentToolPolicy({ mode: "read-only" })({
      ...request,
      tool: undeclared,
      toolCall: { id: "call_2", name: undeclared.name, input: {} },
      input: {}
    })).toMatchObject({
      approved: false,
      reason: expect.stringContaining("does not declare permissions")
    });
  });

  it("requires supervised approval for marked and high-risk tools unless explicitly allowed", async () => {
    const highRiskTool = tool({
      name: "charge_card",
      schema: z.object({ amount: z.number() }),
      metadata: {
        advancedRegistry: {
          permissions: ["read"],
          audit: { riskLevel: "high" }
        }
      },
      execute: async () => ({ ok: true })
    });
    const markedTool = tool({
      name: "delete_customer",
      schema: z.object({ id: z.string() }),
      requiresApproval: true,
      execute: async () => ({ deleted: true })
    });
    const networkTool = tool({
      name: "fetch_external",
      schema: z.object({ url: z.string() }),
      metadata: {
        advancedRegistry: { permissions: ["network"] }
      },
      execute: async () => ({ ok: true })
    });
    const request = {
      tool: markedTool,
      toolCall: { id: "call_1", name: markedTool.name, input: { id: "42" } },
      input: { id: "42" },
      step: 1,
      model: createTierAModel()
    } satisfies ToolApprovalRequest;
    const supervised = createAgentToolPolicy({ mode: "supervised" });

    expect(supervised(request)).toMatchObject({
      approved: false,
      approvalRequired: true,
      reason: expect.stringContaining("requires explicit approval")
    });
    expect(supervised({
      ...request,
      tool: highRiskTool,
      toolCall: { id: "call_2", name: highRiskTool.name, input: { amount: 10 } },
      input: { amount: 10 }
    })).toMatchObject({
      approved: false,
      approvalRequired: true,
      reason: expect.stringContaining('risk level "high"')
    });
    expect(createAgentToolPolicy({ mode: "supervised", allowToolNames: ["delete_customer"] })(request)).toMatchObject({
      approved: true
    });
    const networkRequest = {
      ...request,
      tool: networkTool,
      toolCall: { id: "call_3", name: networkTool.name, input: { url: "https://example.test" } },
      input: { url: "https://example.test" }
    };
    expect(supervised(networkRequest)).toMatchObject({
      approved: false,
      approvalRequired: true,
      reason: expect.stringContaining("sensitive permissions")
    });
    expect(createAgentToolPolicy({ mode: "supervised", allowPermissions: ["network"] })(networkRequest)).toMatchObject({
      approved: true
    });

    let sideEffects = 0;
    const agent = createAgent({
      model: createMockLanguageModel({
        capabilities: { tools: true },
        responses: [{
          messages: [{
            role: "assistant",
            parts: [{
              type: "tool-call",
              toolCall: { id: "call_1", name: "delete_customer", input: { id: "42" } }
            }]
          }],
          finishReason: "tool-calls"
        }]
      }),
      maxSteps: 2,
      toolApprovalPolicy: supervised,
      tools: {
        delete_customer: tool({
          name: "delete_customer",
          schema: z.object({ id: z.string() }),
          requiresApproval: true,
          execute: async () => {
            sideEffects += 1;
            return { deleted: true };
          }
        })
      }
    });

    const waiting = await runAgent(agent, { prompt: "delete", maxSteps: 2 });
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.state.pendingApprovals).toHaveLength(1);
    expect(sideEffects).toBe(0);
  });

  it("creates approval queues from provider approval waits", () => {
    const queue = createAgentApprovalQueue(
      baseState({
        status: "waiting_approval",
        pendingApprovals: [
          {
            provider: "openai",
            id: "approval_1",
            name: "remote_mcp",
            arguments: "{\"action\":\"sync\"}",
            rawData: { type: "mcp_approval_request" }
          }
        ]
      }),
      { tokenPrefix: "token", resumeUrl: "/runs/run_1/resume", expiresAt: 123 }
    );

    expect(queue).toEqual([
      expect.objectContaining({
        type: "agent_approval_queue_item",
        runId: "run_1",
        approvalRequestId: "approval_1",
        resumeUrl: "/runs/run_1/resume",
        expiresAt: 123
      })
    ]);
    expect(queue[0]?.approvalToken).toMatch(/^token_[A-Za-z0-9_-]{43}$/);
    expect(queue[0]?.approvalToken).not.toContain("run_1");
    expect(createAgentApprovalQueue(
      baseState({ status: "waiting_approval", pendingApprovals: queue.map((item) => ({
        provider: item.provider,
        id: item.approvalRequestId,
        name: item.name,
        arguments: item.arguments,
        rawData: item.rawData
      })) }),
      { tokenPrefix: "token" }
    )[0]?.approvalToken).not.toBe(queue[0]?.approvalToken);
  });

  it("returns an empty approval queue when a run has no pending approvals", () => {
    expect(createAgentApprovalQueue(baseState())).toEqual([]);
  });

  it("omits and redacts sensitive production trace payloads by default", () => {
    const state = baseState({
      outputText: "Bearer highly-sensitive-token",
      pendingApprovals: [{
        provider: "openai",
        id: "approval_1",
        name: "remote_mcp",
        arguments: JSON.stringify({ token: "approval-secret" }),
        rawData: { type: "mcp_approval_request", arguments: "approval-secret" }
      }]
    });
    state.steps[0]!.toolResults[0]!.output = { token: "tool-output-secret" };

    const trace = createAgentTraceArtifact(state, createProductionTraceOptions());
    expect(trace.outputText).toBeUndefined();
    expect(trace.outputPreview).toBe("[REDACTED]");
    expect(trace.steps[0]?.toolResults[0]?.output).toBeUndefined();
    expect(trace.approvals[0]?.arguments).toBeUndefined();
    expect(JSON.stringify(trace)).not.toContain("highly-sensitive-token");
    expect(JSON.stringify(trace)).not.toContain("tool-output-secret");
    expect(JSON.stringify(trace)).not.toContain("approval-secret");

    const explicit = createAgentTraceArtifact(state, {
      includeOutputText: true,
      includeToolOutputs: true,
      includeApprovalArguments: true,
      redaction: false
    });
    expect(explicit.outputText).toBe("Bearer highly-sensitive-token");
    expect(explicit.steps[0]?.toolResults[0]?.output).toEqual({ token: "tool-output-secret" });
    expect(explicit.approvals[0]?.arguments).toContain("approval-secret");
  });

  it("creates ledgers, diffs them, and promotes golden traces", () => {
    const ledger = createAgentRunLedger(baseState(), {
      includeInput: true,
      includeOutput: true,
      includeTimeline: true,
      trace: { includeOutputText: true, redaction: false },
      pricing: { inputCostPer1kTokens: 0.01, outputCostPer1kTokens: 0.02, currency: "USD" }
    });
    const changed = createAgentRunLedger(baseState({ runId: "run_2", outputText: "changed" }));
    const diff = diffAgentRunLedgers(ledger, changed);
    const golden = promoteAgentGoldenTrace(ledger, { name: "happy-path" });

    expect(ledger).toMatchObject({
      type: "agent_run_ledger",
      runId: "run_1",
      status: "completed",
      audit: { toolCalls: 1 },
      summary: { steps: 2, toolCalls: 1 }
    });
    expect(ledger.timeline?.map((event) => event.type)).toContain("tool-call");
    expect(ledger.cost?.totalCost).toBeGreaterThan(0);
    expect(diff.changes).toContainEqual(expect.objectContaining({ field: "outputText" }));
    expect(golden.expectations).toMatchObject({
      status: "completed",
      outputText: "done",
      toolCalls: ["lookup"],
      approvals: 0
    });
  });

  it("keeps the complete run ledger fail-closed for sensitive payloads", () => {
    const state = baseState({
      outputText: "Bearer final-secret",
      metadata: { token: "metadata-secret" },
      error: { message: "run failed with token=run-secret-12345678" },
      cancellationReason: "Bearer cancellation-secret",
      pendingApprovals: [{
        provider: "openai",
        id: "approval_1",
        name: "remote_mcp",
        arguments: "approval-secret",
        rawData: { token: "raw-secret" }
      }]
    });
    const call = state.steps[0]?.response?.messages[0]?.parts[0];
    if (call?.type === "tool-call") {
      call.toolCall.input = { token: "input-secret" };
    }
    state.steps[0]!.toolResults[0]!.output = { token: "output-secret" };
    state.toolResults[0]!.isError = true;
    state.toolResults[0]!.error = { message: "tool failed with Bearer tool-secret" };

    const ledger = createAgentRunLedger(state, { includeInput: false, includeOutput: false });
    const serialized = JSON.stringify(ledger);
    expect(ledger.timeline).toBeUndefined();
    expect(ledger.metadata).toBeUndefined();
    for (const secret of [
      "final-secret",
      "metadata-secret",
      "approval-secret",
      "raw-secret",
      "input-secret",
      "output-secret",
      "run-secret-12345678",
      "cancellation-secret",
      "tool-secret"
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(ledger.audit.error?.message).toContain("[REDACTED]");
    expect(ledger.audit.cancellationReason).toBe("[REDACTED]");
    expect(ledger.toolAudit[0]?.error?.message).toContain("[REDACTED]");
  });

  it("routes models by agent capability requirements", () => {
    const tierA = createTierAModel();
    const secondTierA = createTierAModel();
    const tierC = createMockLanguageModel({ provider: "local", modelId: "small", capabilities: { tools: true } });
    const router = createAgentCapabilityRouter([tierC, tierA]);

    expect(selectAgentModel([tierC, tierA], { minTier: "tier-b", approvals: true }).model).toBe(tierA);
    expect(selectAgentModel([tierA, secondTierA], { minTier: "tier-a" }).model).toBe(tierA);
    expect(router.select({ remoteMcp: true }).support).toMatchObject({
      provider: "openai",
      agentTier: "tier-a",
      remoteMcp: true
    });
    expect(() => selectAgentModel([])).toThrow("No agent model candidates were provided.");
    expect(() => router.select({ allowedProviders: ["missing"] })).toThrow("No agent model candidate");
  });

  it("runs through the control-plane facade and stores inspectable run records", async () => {
    const store = createInMemoryAgentRunStore();
    const agent = createAgent({
      id: "ops",
      model: createTierAModel(),
      store
    });
    const controlPlane = createAgentControlPlane({
      agent,
      pricing: { inputCostPer1kTokens: 0.01, outputCostPer1kTokens: 0.02, currency: "USD" }
    });

    const record = await controlPlane.run({ prompt: "finish" });
    const loaded = await controlPlane.getRun(record.state.runId);
    const trace = await controlPlane.getTrace(record.state.runId);

    expect(record.ledger.type).toBe("agent_run_ledger");
    expect(record.summary.status).toBe("completed");
    expect(record.state.harness).toMatchObject({
      id: "ops",
      algorithm: "sha256"
    });
    expect(loaded?.runId).toBe(record.state.runId);
    expect(loaded?.harness).toEqual(record.state.harness);
    expect(trace?.runId).toBe(record.state.runId);
    expect(controlPlane.inspect().provider.agentTier).toBe("tier-a");
  });

  it("streams through the control-plane facade", async () => {
    const agent = createAgent({
      id: "ops",
      model: createStreamingTierAModel()
    });
    const controlPlane = createAgentControlPlane({ agent });

    const stream = controlPlane.stream({ prompt: "finish" });
    await expect(stream.collect()).resolves.toMatchObject({
      status: "completed",
      outputText: "done"
    });
  });

  it("reads run trees and cancels runs through the control-plane facade", async () => {
    const store = createInMemoryAgentRunStore();
    const parent = baseState({ runId: "parent", status: "running", outputText: "" });
    const child = baseState({ runId: "child", parentRunId: "parent", status: "running", outputText: "" });
    await Promise.resolve(store.save(parent));
    await Promise.resolve(store.save(child));

    const agent = createAgent({
      id: "ops",
      model: createTierAModel(),
      store
    });
    const controlPlane = createAgentControlPlane({ agent });

    await expect(controlPlane.getRunTree("parent")).resolves.toMatchObject({
      totalRuns: 2,
      root: { trace: { runId: "parent" } }
    });
    await expect(controlPlane.cancel("parent", { reason: "operator" })).resolves.toMatchObject({
      runId: "parent",
      status: "cancel_requested",
      cancellationReason: "operator"
    });
    await expect(controlPlane.cancelTree("parent", { reason: "operator" })).resolves.toMatchObject({
      children: [expect.objectContaining({ runId: "child", status: "cancel_requested" })]
    });
  });
});
