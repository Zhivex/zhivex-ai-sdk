import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, createFileAgentRunStore, createInMemoryAgentRunStore, createRedactionPolicy, createTextMessage, tool, type AgentTelemetryEvent } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";

const fixture = "token: synthetic_redaction_fixture";
const clean = (value: unknown) => expect(JSON.stringify(value).includes("synthetic_redaction_fixture")).toBe(false);
const response = (text = fixture) => ({ messages: [createTextMessage("assistant", text)], text, finishReason: "stop" as const });

describe("durable output redaction", () => {
  for (const stream of [false, true]) for (const file of [false, true]) for (const reject of [false, true]) {
    it(`preserves redaction: stream=${stream}, file=${file}, reject=${reject}`, async () => {
      const directory = file ? await mkdtemp(join(tmpdir(), "sdk-redaction-")) : undefined;
      try {
        const store = directory ? createFileAgentRunStore({ directory }) : createInMemoryAgentRunStore();
        const terminalEvents: AgentTelemetryEvent[] = [];
        const agent = new Agent({
          model: createMockLanguageModel({ responses: [response()], streamEvents: [[{ type: "text-delta", textDelta: fixture }, { type: "finish", finishReason: "stop" }]] }),
          store,
          onTelemetryEvent: event => { if (event.type === "step-finish" || event.type === "run-finish") terminalEvents.push(structuredClone(event)); },
          outputGuardrails: [createRedactionPolicy().outputGuardrail, request => {
            clean(request.output);
            clean(request.state);
            // Snapshot control mutations must never be promoted to durable state.
            request.state.runId = "tampered";
            request.state.maxSteps = 999;
            return reject ? { triggered: true, reason: "Primary rejection" } : undefined;
          }]
        });
        const input = { prompt: "Reply", metadata: { note: fixture } };
        const streamed = stream ? agent.stream(input) : undefined;
        const events = streamed ? Array.fromAsync(streamed.eventStream) : undefined;
        const result = streamed ? await streamed.collect() : await agent.run(input);
        if (events) clean((await events).filter(event => event.type === "agent-run-finish" || event.type === "agent-step-finish"));
        expect(result.status).toBe(reject ? "failed" : "completed");
        if (reject) expect(result.error?.message).toBe("Primary rejection");
        expect(result.state.runId).not.toBe("tampered");
        expect(result.state.maxSteps).not.toBe(999);
        clean(result);
        clean(terminalEvents);
        const reopened = directory ? createFileAgentRunStore({ directory }) : store;
        clean(await reopened.load(result.state.runId));
      } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    });
  }

  it("redacts structured output and executed tool results without losing receipts", async () => {
    const agent = new Agent({
      model: createMockLanguageModel({ responses: [
        { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "call-1", name: "inspect", input: {} } }] }], finishReason: "tool-calls" },
        response(JSON.stringify({ answer: fixture }))
      ] }),
      tools: { inspect: tool({ name: "inspect", schema: z.object({}), execute: () => ({ note: fixture }) }) },
      maxSteps: 3,
      outputSchema: z.object({ answer: z.string() }),
      outputGuardrails: [createRedactionPolicy().outputGuardrail]
    });
    const result = await agent.run({ prompt: "Inspect" });
    clean(result);
    expect(result.finalOutput).toEqual({ answer: "[REDACTED]" });
    expect(result.toolResults[0]).toMatchObject({ toolCallId: "call-1", toolName: "inspect", output: { note: "[REDACTED]" } });
  });

  it("reopens and resumes a redacted approval checkpoint without changing controls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sdk-redaction-resume-"));
    try {
      const model = createMockLanguageModel({ responses: [
        { messages: [{ role: "assistant", parts: [{ type: "text", text: fixture }, { type: "tool-call", toolCall: { id: "call-1", name: "inspect", input: {} } }] }], text: fixture, finishReason: "tool-calls" },
        response("Finished")
      ] });
      let calls = 0;
      const config = { model, maxSteps: 3, tools: { inspect: tool({ name: "inspect", schema: z.object({}), requiresApproval: true, approvalMode: "interrupt" as const, execute: () => { calls++; return { note: fixture }; } }) }, outputGuardrails: [createRedactionPolicy({ rules: [{ pattern: /control-id|call-1|inspect/g }] }).outputGuardrail] };
      const first = await new Agent({ ...config, store: createFileAgentRunStore({ directory }) }).run({ prompt: "Inspect", runId: "control-id", scope: { tenantId: "control-id" } });
      expect(first.state.runId).toBe("control-id");
      expect(first.state.scope).toEqual({ tenantId: "control-id" });
      expect(first.state.pendingApprovals[0]?.name).toBe("inspect");
      expect(first.status).toBe("waiting_approval");
      expect(calls).toBe(0);
      clean(first);
      const store = createFileAgentRunStore({ directory });
      const saved = (await store.load(first.state.runId, first.state.scope))!;
      expect(saved.pendingApprovals).toEqual(first.state.pendingApprovals);
      const resumed = await new Agent({ ...config, store }).resume({ state: saved, approvals: saved.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true })) });
      expect(resumed.status).toBe("completed");
      expect(calls).toBe(1);
      clean(resumed);
      clean(await store.load(first.state.runId, first.state.scope));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([false, true])("does not restore raw checkpoints when a later guardrail throws: stream=%s", async stream => {
    const store = createInMemoryAgentRunStore();
    const primary = new Error("Primary guardrail error");
    const agent = new Agent({ store, model: createMockLanguageModel({ responses: [response()], streamEvents: [[{ type: "text-delta", textDelta: fixture }, { type: "finish", finishReason: "stop" }]] }), outputGuardrails: [createRedactionPolicy().outputGuardrail, () => { throw primary; }] });
    const input = { prompt: "Reply", runId: "throw-test" };
    await expect(stream ? agent.stream(input).collect() : agent.run(input)).rejects.toBe(primary);
    const saved = await store.load(input.runId);
    expect(saved?.status).toBe("failed");
    expect(saved?.error?.message).toBe(primary.message);
    clean(saved);
  });

  it("retains redaction across a child run and its parent tool receipt", async () => {
    const store = createInMemoryAgentRunStore();
    const child = new Agent({ id: "child", store, model: createMockLanguageModel({ responses: [response()] }), outputGuardrails: [createRedactionPolicy().outputGuardrail] });
    const parent = new Agent({ store, maxSteps: 3, subagents: [{ name: "delegate", agent: child.toDefinition() }], model: createMockLanguageModel({ responses: [
      { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "child-call", name: "delegate", input: { prompt: "Reply" } } }] }], finishReason: "tool-calls" },
      response("Finished")
    ] }), outputGuardrails: [createRedactionPolicy().outputGuardrail] });
    const result = await parent.run({ prompt: "Delegate" });
    expect(result.status).toBe("completed");
    expect(result.state.childRuns).toHaveLength(1);
    clean(result);
    clean(await store.load(result.state.childRuns![0]!.runId));
  });
});
