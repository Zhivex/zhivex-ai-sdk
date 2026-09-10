import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, createInMemoryAgentRunStore, createTextMessage, generateText, streamText, tool, hostedTool, ValidationError, type ToolCall, type GenerateTextOptions, type GenerateResult } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";

const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
const call = (id: string, input: any = { endLine: "private-value" }): ToolCall => ({ id, name: "read", input });
const reply = (...calls: ToolCall[]): GenerateResult => ({ messages: [{ role: "assistant", parts: calls.map(toolCall => ({ type: "tool-call", toolCall })) }], finishReason: "tool-calls", usage });
const done: GenerateResult = { text: "done", messages: [createTextMessage("assistant", "done")], finishReason: "stop", usage };
const mock = (responses: GenerateResult[]) => createMockLanguageModel({ responses, streamEvents: responses.map(response => [
  ...response.messages.flatMap(m => m.parts.flatMap(p => p.type === "tool-call" ? [{ type: "tool-call" as const, toolCall: p.toolCall }] : p.type === "text" ? [{ type: "text-delta" as const, textDelta: p.text }] : [])),
  { type: "finish", finishReason: response.finishReason!, usage: response.usage }
]) });
const run = async (streaming: boolean, options: GenerateTextOptions) => {
  if (!streaming) return generateText(options);
  const result = streamText(options);
  const events = Array.fromAsync(result.eventStream);
  const [output] = await Promise.all([result.collect(), events]);
  return output;
};

describe("explicit tool schema recovery", () => {
  it.each([false, true])("returns sanitized errors and permits a validated correction (stream=%s)", async streaming => {
    let executions = 0, approvals = 0;
    const result = await run(streaming, {
      model: mock([reply(call("bad")), reply(call("good", { endLine: 4 })), done]), prompt: "Read", maxSteps: 3,
      toolExecution: { validationErrorMode: "tool-result" }, toolApprovalPolicy: () => { approvals++; return true; },
      tools: { read: tool({ name: "read", schema: z.object({ endLine: z.number().int() }), execute: input => { executions++; expect(input.endLine).toBe(4); return "ok"; } }) }
    });
    expect(executions).toBe(1); expect(approvals).toBe(1);
    expect(result.toolResults[0]).toEqual({ toolCallId: "bad", toolName: "read", isError: true, error: { code: "TOOL_INPUT_VALIDATION_ERROR", message: "Tool arguments do not match the input schema.", issues: [{ code: "invalid_type", path: ["endLine"] }] } });
    expect(JSON.stringify(result.toolResults)).not.toContain("private-value");
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 6, totalTokens: 36 });
    expect(result.steps).toHaveLength(3);
  });

  it.each([false, true])("preserves strict default even with stopOnError=false (stream=%s)", async streaming => {
    await expect(run(streaming, { model: mock([reply(call("bad")), done]), prompt: "Read", maxSteps: 3, toolExecution: { stopOnError: false }, tools: { read: tool({ name: "read", schema: z.object({ endLine: z.number() }), execute: () => { throw new Error("must not execute"); } }) } })).rejects.toBeInstanceOf(ValidationError);
  });

  it.each([false, true])("bounds repeated invalid calls by maxSteps (stream=%s)", async streaming => {
    const result = await run(streaming, { model: mock([reply(call("bad-1")), reply(call("bad-2")), done]), prompt: "Read", maxSteps: 2, toolExecution: { validationErrorMode: "tool-result" }, tools: { read: tool({ name: "read", schema: z.object({ endLine: z.number() }), execute: () => { throw new Error("must not execute"); } }) } });
    expect(result.steps).toHaveLength(2); expect(result.toolResults).toHaveLength(2);
    expect(result.usage?.inputTokens).toBe(20);
  });

  it.each([false, true])("preserves mixed batches across durable approval resume (parallel=%s)", async parallel => {
    let executions = 0;
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ model: mock([reply(call("bad"), call("good", { endLine: 4 })), done]), maxSteps: 3, store,
      toolExecution: { validationErrorMode: "tool-result", parallel },
      tools: { read: tool({ name: "read", schema: z.object({ endLine: z.number() }), requiresApproval: true, approvalMode: "interrupt", execute: () => { executions++; return "ok"; } }) }
    });
    const waiting = await agent.run({ prompt: "Read" });
    expect(waiting.status).toBe("waiting_approval"); expect(executions).toBe(0);
    expect(waiting.state.pendingApprovals).toHaveLength(1);
    const approval = waiting.state.pendingApprovals[0]!;
    expect(approval.toolCallId).toBe("good");
    const output = await agent.resume({ state: (await store.load(waiting.state.runId))!, approvals: [{ provider: approval.provider, approvalRequestId: approval.id, approve: true }] });
    expect(output.status).toBe("completed"); expect(executions).toBe(1);
    expect(output.toolResults.map(r => [r.toolCallId, r.isError])).toEqual([["bad", true], ["good", false]]);
    expect(output.usage?.inputTokens).toBe(20);
    expect((await store.load(output.state.runId))?.toolResults).toEqual(output.toolResults);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])("counts validation errors against agent maxToolErrors (store=%s, stream=%s)", async (persist, streaming) => {
    const model = mock([reply(call("bad-1")), reply(call("bad-2")), done]);
    let requests = 0; const original = model.generate; model.generate = async input => { requests++; return original(input); };
    const originalStream = model.stream!; model.stream = async input => { requests++; return originalStream(input); };
    const agent = new Agent({ model, maxSteps: 3, store: persist ? createInMemoryAgentRunStore() : undefined,
      policy: { budget: { maxToolErrors: 1 } }, toolExecution: { validationErrorMode: "tool-result" },
      tools: { read: tool({ name: "read", schema: z.object({ endLine: z.number() }), execute: () => { throw new Error("must not execute"); } }) }
    });
    if (streaming) {
      const stream = agent.stream({ prompt: "Read" });
      await Promise.allSettled([stream.collect(), Array.fromAsync(stream.eventStream)]);
    } else await agent.run({ prompt: "Read" }).catch(() => undefined);
    expect(requests).toBe(2);
  });

  it.each(["unknown", "disabled", "guardrail", "abort"])("does not recover %s restrictions", async kind => {
    const controller = new AbortController(); if (kind === "abort") controller.abort(new Error("cancelled"));
    let executed = 0;
    const target = call("call", kind === "guardrail" ? { endLine: 1 } : undefined);
    if (kind === "unknown") target.name = "missing";
    await expect(generateText({ model: mock([reply(target), done]), prompt: "Read", maxSteps: 2, abortSignal: controller.signal,
      toolExecution: { validationErrorMode: "tool-result" }, tools: { read: tool({ name: "read", schema: z.object({ endLine: z.number() }),
        ...(kind === "disabled" ? { isEnabled: () => false } : {}),
        ...(kind === "guardrail" ? { inputGuardrails: [() => ({ triggered: true as const, reason: "blocked" })] } : {}),
        execute: () => { executed++; return "ok"; }
      }) }
    })).rejects.toThrow();
    expect(executed).toBe(0);
  });
});

describe("unregistered tool accounting and explicit recovery", () => {
  const unknown = (id = "unknown"): ToolCall => ({ id, name: "not_in_catalog", input: { secret: "private-argument" } });
  const tools = { read: tool({ name: "read", schema: z.object({ endLine: z.number() }), execute: () => "ok" }) };

  it.each([false, true])("checkpoints strict mixed rejection exactly once (stream=%s)", async streaming => {
    const store = createInMemoryAgentRunStore();
    let approvals = 0, executions = 0;
    const agent = new Agent({ store, maxSteps: 4, model: mock([reply(call("first", { endLine: 1 })), reply(unknown(), call("unexecuted", { endLine: 2 })), done]),
      toolExecution: { stopOnError: false, validationErrorMode: "tool-result" },
      toolApprovalPolicy: () => { approvals++; return true; },
      tools: { read: tool({ name: "read", schema: z.object({ endLine: z.number() }), execute: () => { executions++; return "ok"; } }) }
    });
    let failure: any;
    if (streaming) {
      const stream = agent.stream({ runId: "strict", prompt: "Read" });
      const results = await Promise.allSettled([stream.collect(), Array.fromAsync(stream.eventStream)]);
      failure = results[0].status === "rejected" ? results[0].reason : undefined;
    } else await agent.run({ runId: "strict", prompt: "Read" }).catch(error => { failure = error; });
    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure.code).toBe("TOOL_NOT_REGISTERED");
    expect(failure.usage).toEqual({ inputTokens: 20, outputTokens: 4, totalTokens: 24 });
    expect(failure.finishReason).toBe("tool-calls");
    expect(JSON.stringify(failure)).not.toContain("private-argument");
    const state = (await store.load("strict"))!;
    expect(state.error?.diagnosticCode).toBe("TOOL_NOT_REGISTERED");
    expect(state.status).toBe("failed"); expect(state.steps).toHaveLength(2);
    expect(state.usage).toEqual(failure.usage); expect(state.finishReason).toBe("tool-calls");
    expect(state.toolResults.map(result => result.error?.code)).toEqual([undefined, "TOOL_NOT_REGISTERED", "TOOL_BATCH_NOT_EXECUTED"]);
    expect(approvals).toBe(1); expect(executions).toBe(1);
    agent.model.generate = async () => done;
    const resumed = await agent.resume({ state });
    expect(resumed.status).toBe("completed"); expect(executions).toBe(1);
    expect(resumed.usage?.inputTokens).toBe(30);
  });

  it.each([false, true])("recovers unknown names with exact correlation (stream=%s)", async streaming => {
    const result = await run(streaming, { model: mock([reply(unknown(), call("valid", { endLine: 2 })), done]), prompt: "Read", tools, maxSteps: 2,
      toolExecution: { unknownToolMode: "tool-result" } });
    expect(result.toolResults.map(result => [result.toolCallId, result.error?.code])).toEqual([["unknown", "TOOL_NOT_REGISTERED"], ["valid", undefined]]);
    expect(result.usage?.inputTokens).toBe(20);
    expect(result.toolResults[0]?.error).toEqual({ code: "TOOL_NOT_REGISTERED", message: "Tool is not registered. Use an available tool with its exact name." });
  });

  it.each([false, true])("retains unknown usage as absent in strict mode (stream=%s)", async streaming => {
    const response = reply(unknown()); delete response.usage;
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ store, model: mock([response]), tools });
    if (streaming) {
      const stream = agent.stream({ runId: "no-usage", prompt: "Read" });
      await Promise.allSettled([stream.collect(), Array.fromAsync(stream.eventStream)]);
    } else await agent.run({ runId: "no-usage", prompt: "Read" }).catch(() => undefined);
    const state = (await store.load("no-usage"))!;
    expect(state.steps).toHaveLength(1); expect(state.usage).toBeUndefined();
    expect(state.toolResults[0]?.error?.code).toBe("TOOL_NOT_REGISTERED");
  });

  it.each([false, true])("preserves approval resume without duplicate effects (parallel=%s)", async parallel => {
    let executions = 0;
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ model: mock([reply(unknown(), call("valid", { endLine: 2 })), done]), tools: {
      read: tool({ name: "read", schema: z.object({ endLine: z.number() }), requiresApproval: true, approvalMode: "interrupt", execute: () => { executions++; return "ok"; } })
    }, store, maxSteps: 3, toolExecution: { unknownToolMode: "tool-result", parallel } });
    const waiting = await agent.run({ prompt: "Read" });
    expect(waiting.state.pendingApprovals).toHaveLength(1); expect(executions).toBe(0);
    const approval = waiting.state.pendingApprovals[0]!;
    expect(approval.toolCallId).toBe("valid");
    const result = await agent.resume({ state: (await store.load(waiting.state.runId))!, approvals: [{ provider: approval.provider, approvalRequestId: approval.id, approve: true }] });
    expect(executions).toBe(1); expect(result.toolResults).toHaveLength(2); expect(result.usage?.inputTokens).toBe(20);
  });

  it.each([false, true])("bounds unknown recovery by agent error budget (stream=%s)", async streaming => {
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ store, model: mock([reply(unknown("one")), reply(unknown("two")), done]), tools, maxSteps: 4,
      toolExecution: { unknownToolMode: "tool-result" }, policy: { budget: { maxToolErrors: 1 } } });
    if (streaming) {
      const stream = agent.stream({ runId: "bounded", prompt: "Read" });
      await Promise.allSettled([stream.collect(), Array.fromAsync(stream.eventStream)]);
    } else await agent.run({ runId: "bounded", prompt: "Read" }).catch(() => undefined);
    const state = (await store.load("bounded"))!;
    expect(state.steps).toHaveLength(2); expect(state.toolResults).toHaveLength(2); expect(state.usage?.inputTokens).toBe(20);
  });


  it.each([false, true])("preserves accounting through compaction (strict=%s)", async strict => {
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ store, model: mock([reply(call("first", { endLine: 1 })), reply(unknown()), done]), tools, maxSteps: 3,
      toolExecution: { unknownToolMode: strict ? "throw" : "tool-result" },
      compaction: { maxMessages: 3, keepRecentMessages: 2, compactor: () => ({ summary: "Earlier steps", usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 } }) } });
    await agent.run({ runId: "compacted", messages: [createTextMessage("user", "Read"), createTextMessage("assistant", "Ready"), createTextMessage("user", "Continue")] }).catch(error => {
      if (!strict) throw error;
    });
    const state = (await store.load("compacted"))!;
    expect(state.compactions!.length).toBeGreaterThan(0);
    expect(state.usage?.inputTokens).toBe(state.steps.length * 10 + state.compactions!.length * 7);
    const pending = new Set<string>();
    for (const message of state.messages) for (const part of message.parts) {
      if (part.type === "tool-call") pending.add(part.toolCall.id);
      if (part.type === "tool-result") { expect(pending.has(part.toolResult.toolCallId)).toBe(true); pending.delete(part.toolResult.toolCallId); }
    }
    expect(pending.size).toBe(0);
  });

  it.each(["disabled", "hosted", "guardrail", "abort", "denied"])("does not bypass %s under unknown recovery", async kind => {
    let executions = 0;
    const controller = new AbortController(); if (kind === "abort") controller.abort(new Error("cancelled"));
    const registered = kind === "hosted"
      ? hostedTool({ name: "read", provider: "openai", type: "web_search" })
      : tool({ name: "read", schema: z.object({ endLine: z.number() }), execute: () => { executions++; return "ok"; },
          ...(kind === "disabled" ? { isEnabled: () => false } : {}),
          ...(kind === "guardrail" ? { inputGuardrails: [() => ({ triggered: true as const, reason: "blocked" })] } : {}) });
    const operation = generateText({ model: mock([reply(unknown(), call("valid", { endLine: 1 }))]), prompt: "Read", tools: { read: registered },
      abortSignal: controller.signal, toolExecution: { unknownToolMode: "tool-result" }, toolApprovalPolicy: () => kind !== "denied" });
    if (kind === "denied") expect((await operation).toolResults.every(result => result.isError)).toBe(true);
    else await expect(operation).rejects.toThrow(kind === "hosted" ? "provider-hosted" : kind === "disabled" ? "disabled" : kind === "guardrail" ? "blocked" : "cancelled");
    expect(executions).toBe(0);
  });

  it("retains strict accounting when stopOnError overrides recovery", async () => {
    let checkpoint: any;
    await expect(generateText({ model: mock([reply(unknown())]), prompt: "Read", tools,
      toolExecution: { unknownToolMode: "tool-result", stopOnError: true }, onModelStep: event => { checkpoint = event; }
    })).rejects.toMatchObject({ code: "TOOL_NOT_REGISTERED", usage });
    expect(checkpoint.failedToolResults[0].error.code).toBe("TOOL_NOT_REGISTERED");
  });

  it.each(["__proto__", "constructor", "toString", "secret\n".repeat(2000)])("treats inherited or hostile names as absent", async name => {
    const result = await generateText({ model: mock([reply({ ...unknown(), name })]), prompt: "Read", tools, toolExecution: { unknownToolMode: "tool-result" } });
    expect(result.toolResults[0]?.error?.code).toBe("TOOL_NOT_REGISTERED");
    await expect(generateText({ model: mock([reply({ ...unknown(), name })]), prompt: "Read", tools })).rejects.toMatchObject({ code: "TOOL_NOT_REGISTERED", toolNameHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
});
