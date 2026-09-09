import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, createInMemoryAgentRunStore, createTextMessage, generateText, streamText, tool, ValidationError, type ToolCall, type GenerateTextOptions, type GenerateResult } from "../src/index.js";
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
