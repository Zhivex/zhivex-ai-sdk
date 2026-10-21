import { describe, expect, it } from "vitest";
import {
  createAgent,
  createMockLanguageModel,
  streamAgent,
  type AgentStreamEvent
} from "@zhivex-ai/core";
import { applyJsonPatch, collectAgUiEvents, diffJson } from "../src/index.js";

const options = { threadId: "thread-1", runId: "run-1", now: () => 1_700_000_000_000 };

const secret = "launch-code-42";

describe("toAgUiEvents", () => {
  it("maps text, tools, state, and a successful run without copying hidden state", async () => {
    const events: AgentStreamEvent[] = [
      { type: "agent-run-start", currentStep: 1, maxSteps: 3 },
      {
        type: "agent-run-update",
        run: {
          runId: "run-1",
          status: "running",
          currentStep: 1,
          maxSteps: 3,
          provider: "mock",
          modelId: "mock-model"
        }
      },
      { type: "agent-step-start", stepIndex: 0 },
      { type: "text-delta", textDelta: "Hello" },
      { type: "text-delta", textDelta: " world" },
      {
        type: "tool-call",
        toolCall: { id: "call-1", name: "deploy", input: { target: "staging" } }
      },
      {
        type: "tool-result",
        toolResult: { toolCallId: "call-1", toolName: "deploy", output: { ok: true }, isError: false }
      },
      {
        type: "agent-step-finish",
        step: { index: 0, status: "completed", startedAt: 1, finishedAt: 2 }
      },
      {
        type: "agent-run-update",
        run: {
          runId: "run-1",
          status: "completed",
          currentStep: 1,
          maxSteps: 3,
          provider: "mock",
          modelId: "mock-model"
        }
      },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      },
      {
        type: "provider-data",
        provider: "mock",
        data: { token: secret }
      },
      {
        type: "image-generation",
        provider: "mock",
        partial: false,
        image: { data: Uint8Array.from([1, 2, 3]), mediaType: "image/png", text: secret }
      },
      {
        type: "agent-run-finish",
        status: "completed",
        state: {
          schemaVersion: 1,
          runId: "run-1",
          provider: "mock",
          modelId: "mock-model",
          status: "completed",
          messages: [{ role: "assistant", parts: [{ type: "text", text: secret }] }],
          steps: [],
          toolResults: [],
          currentStep: 1,
          maxSteps: 3,
          outputText: "Hello world",
          pendingApprovals: [],
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
            cacheWriteTokens: 7,
            cacheWriteTokensDetails: { ttl30mTokens: 3, ttl12hTokens: 4 }
          }
        }
      }
    ];

    const agui = await collectAgUiEvents(events, options);
    expect(agui.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "STATE_SNAPSHOT",
      "STEP_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "STEP_FINISHED",
      "STATE_DELTA",
      "CUSTOM",
      "CUSTOM",
      "STATE_DELTA",
      "RUN_FINISHED"
    ]);
    expect(agui[0]).toMatchObject({
      type: "RUN_STARTED",
      threadId: "thread-1",
      runId: "run-1",
      protocolVersion: "1.0"
    });
    expect(agui.find((event) => event.type === "TEXT_MESSAGE_CONTENT")).toMatchObject({ delta: "Hello" });
    expect(agui.find((event) => event.type === "TOOL_CALL_ARGS")).toMatchObject({
      toolCallId: "call-1",
      delta: JSON.stringify({ target: "staging" })
    });
    expect(agui.find((event) => event.type === "TOOL_CALL_RESULT")).toMatchObject({
      toolCallId: "call-1",
      content: JSON.stringify({ ok: true }),
      role: "tool"
    });
    const finished = agui.at(-1);
    expect(finished).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "success" },
      usage: [{
        provider: "mock",
        model: "mock-model",
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        cacheWriteInputTokens: 7,
        cacheWriteTokensDetails: { ttl30mTokens: 3, ttl12hTokens: 4 }
      }]
    });
    const snapshot = agui.find((event) => event.type === "STATE_SNAPSHOT");
    const deltas = agui.filter((event) => event.type === "STATE_DELTA");
    expect(snapshot && snapshot.type === "STATE_SNAPSHOT").toBe(true);
    let state = snapshot && snapshot.type === "STATE_SNAPSHOT" ? snapshot.snapshot : {};
    for (const delta of deltas) {
      if (delta.type === "STATE_DELTA") state = applyJsonPatch(state, delta.delta) as typeof state;
    }
    expect(state).toMatchObject({
      run: { runId: "run-1", status: "completed", outputText: "Hello world", pendingApprovals: 0 }
    });
    expect(JSON.stringify(agui)).not.toContain(secret);
    expect(JSON.stringify(agui)).not.toContain("messages");
  });

  it("ends an approval pause as an AG-UI interrupt and omits approval arguments", async () => {
    const events: AgentStreamEvent[] = [
      { type: "agent-step-start", stepIndex: 0 },
      {
        type: "tool-call",
        toolCall: { id: "call-9", name: "deploy", input: { target: "prod" } }
      },
      {
        type: "agent-approval-request",
        approval: {
          kind: "local-tool",
          provider: "zhivex",
          id: "approval_1",
          name: "deploy",
          arguments: secret,
          toolCallId: "call-9",
          signature: "sig-secret",
          rawData: { secret }
        }
      },
      {
        type: "agent-run-finish",
        status: "waiting_approval",
        state: {
          schemaVersion: 1,
          runId: "run-1",
          provider: "mock",
          modelId: "mock-model",
          status: "waiting_approval",
          messages: [],
          steps: [],
          toolResults: [],
          currentStep: 1,
          maxSteps: 3,
          outputText: "",
          pendingApprovals: [{
            kind: "local-tool",
            provider: "zhivex",
            id: "approval_1",
            name: "deploy",
            arguments: secret,
            toolCallId: "call-9",
            rawData: { secret }
          }]
        }
      }
    ];
    const agui = await collectAgUiEvents(events, options);
    const finished = agui.at(-1);
    expect(finished).toMatchObject({
      type: "RUN_FINISHED",
      outcome: {
        type: "interrupt",
        interrupts: [{
          id: "zhivex:approval_1",
          reason: "tool_approval",
          toolCallId: "call-9",
          metadata: {
            provider: "zhivex",
            approvalRequestId: "approval_1",
            name: "deploy",
            kind: "local-tool"
          }
        }]
      }
    });
    expect(JSON.stringify(finished)).not.toContain(secret);
    expect(JSON.stringify(finished)).not.toContain("sig-secret");
    expect(agui.filter((event) => event.type === "RUN_FINISHED")).toHaveLength(1);
    expect(agui[0]).toMatchObject({ type: "RUN_STARTED" });
  });

  it("maps a mock agent stream and closes the run", async () => {
    const agent = createAgent({
      id: "writer",
      maxSteps: 1,
      model: createMockLanguageModel({
        provider: "mock",
        modelId: "mock-model",
        capabilities: { streaming: true, tools: false },
        streamEvents: [[
          { type: "text-delta", textDelta: "done" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
        ]]
      })
    });
    const stream = streamAgent(agent, { prompt: "hi", runId: "run-1" });
    const events: AgentStreamEvent[] = [];
    const reading = (async () => {
      for await (const event of stream.eventStream) events.push(event);
    })();
    await stream.collect();
    await reading;
    const agui = await collectAgUiEvents(events, options);
    expect(agui[0]).toMatchObject({ type: "RUN_STARTED", protocolVersion: "1.0" });
    expect(agui.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "done")).toBe(true);
    expect(agui.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } });
  });

  it("diffs and applies JSON state patches", () => {
    const before = { run: { status: "running", nested: { a: 1 } }, extra: true };
    const after = { run: { status: "completed", nested: { a: 1, b: 2 } } };
    const delta = diffJson(before, after);
    expect(delta).toEqual([
      { op: "remove", path: "/extra" },
      { op: "replace", path: "/run/status", value: "completed" },
      { op: "add", path: "/run/nested/b", value: 2 }
    ]);
    expect(applyJsonPatch(before, delta)).toEqual(after);
    expect(before).toEqual({ run: { status: "running", nested: { a: 1 } }, extra: true });
  });
});
