import { describe, expect, it } from "vitest";

import {
  createAgentHandoff,
  createTextMessage,
  migrateAgentRunState,
  normalizeAgentRunState,
  type AgentRunState
} from "../src/index.js";

const validState = (): AgentRunState => ({
  schemaVersion: 1,
  revision: 3,
  scope: { tenantId: "tenant_1", userId: "user_1", namespace: "prod" },
  runId: "run_1",
  idempotencyKey: "request_1",
  agentId: "assistant",
  provider: "test",
  modelId: "model",
  status: "completed",
  messages: [
    createTextMessage("user", "weather"),
    {
      role: "assistant",
      parts: [{ type: "tool-call", toolCall: { id: "call_1", name: "weather", input: { city: "Madrid" } } }]
    }
  ],
  steps: [{
    index: 1,
    status: "completed",
    startedAt: 10,
    finishedAt: 20,
    request: {
      messages: [createTextMessage("user", "weather")],
      toolChoice: { type: "tool", toolName: "weather" },
      toolExecution: { maxConcurrency: 2, timeoutMs: 1_000 },
      maxTokens: 100
    },
    response: {
      messages: [createTextMessage("assistant", "sunny")],
      text: "sunny",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, speed: "fast" }
    },
    toolResults: [{ toolCallId: "call_1", toolName: "weather", output: { sunny: true }, isError: false }]
  }],
  toolResults: [{ toolCallId: "call_1", toolName: "weather", output: { sunny: true }, isError: false }],
  currentStep: 1,
  maxSteps: 3,
  outputText: "sunny",
  finishReason: "stop",
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  pendingApprovals: [],
  childRuns: [{
    runId: "run_child",
    parentRunId: "run_1",
    status: "completed",
    outputText: "done",
    steps: 1,
    toolCalls: 1,
    toolErrors: 0
  }],
  metadata: { tenantId: "tenant_1" },
  startedAt: 10,
  updatedAt: 20
});

describe("agent run state validation", () => {
  it("deeply validates and clones a complete valid state", () => {
    const state = validState();
    const normalized = normalizeAgentRunState(state);

    expect(normalized).toEqual(state);
    expect(normalized).not.toBe(state);
    expect(normalized.messages).not.toBe(state.messages);
  });

  it("migrates only unversioned legacy states to the current schema", () => {
    const legacy = validState() as AgentRunState & { schemaVersion?: number; revision?: number };
    delete legacy.schemaVersion;
    delete legacy.revision;

    expect(migrateAgentRunState(legacy)).toMatchObject({ schemaVersion: 1, revision: 0 });
    for (const schemaVersion of [0, -1, 1.5, "1", null]) {
      expect(() => normalizeAgentRunState({ ...validState(), schemaVersion })).toThrow(/schemaVersion/);
    }
    expect(() => normalizeAgentRunState({ ...validState(), schemaVersion: 2 })).toThrow(
      "Unsupported AgentRunState schemaVersion 2"
    );
  });

  it.each([
    ["status", (state: Record<string, unknown>) => { state.status = "finished"; }],
    ["messages role", (state: Record<string, unknown>) => {
      (state.messages as Array<Record<string, unknown>>)[0]!.role = "operator";
    }],
    ["message part", (state: Record<string, unknown>) => {
      ((state.messages as Array<Record<string, unknown>>)[0]!.parts as Array<Record<string, unknown>>)[0]!.type = "html";
    }],
    ["step counter", (state: Record<string, unknown>) => {
      (state.steps as Array<Record<string, unknown>>)[0]!.index = 0;
    }],
    ["step result", (state: Record<string, unknown>) => {
      ((state.steps as Array<Record<string, unknown>>)[0]!.toolResults as Array<Record<string, unknown>>)[0]!.isError = "no";
    }],
    ["usage", (state: Record<string, unknown>) => {
      (state.usage as Record<string, unknown>).totalTokens = -1;
    }],
    ["timestamp", (state: Record<string, unknown>) => { state.updatedAt = Number.POSITIVE_INFINITY; }],
    ["counter", (state: Record<string, unknown>) => { state.currentStep = 0.5; }],
    ["scope", (state: Record<string, unknown>) => {
      (state.scope as Record<string, unknown>).tenantId = "";
    }]
  ])("rejects invalid deeply nested %s", (_label, mutate) => {
    const state = structuredClone(validState()) as unknown as Record<string, unknown>;
    mutate(state);
    expect(() => normalizeAgentRunState(state)).toThrow(/AgentRunState/);
  });

  it("rejects non-JSON metadata and circular structures", () => {
    expect(() => normalizeAgentRunState({
      ...validState(),
      metadata: { invalid: Number.NaN }
    })).toThrow(/finite JSON numbers/);

    const state = validState() as AgentRunState & { cycle?: unknown };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    state.metadata = cycle as AgentRunState["metadata"];
    expect(() => normalizeAgentRunState(state)).toThrow(/circular references/);
  });
});

describe("agent handoff IDs", () => {
  it("uses UUID-backed IDs by default and supports deterministic caller IDs", () => {
    const source = validState();
    expect(createAgentHandoff({ source }).id).toMatch(
      /^handoff_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(createAgentHandoff({ source, id: "handoff_durable_1" }).id).toBe("handoff_durable_1");
  });
});
