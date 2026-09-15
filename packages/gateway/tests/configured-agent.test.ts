import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, createInMemoryAgentRunStore, tool, ConflictError } from "@zhivex-ai/core";
import { createMockLanguageModel } from "../../core/src/testing.js";
import { createGateway } from "../src/index.js";
const primary = { provider: "gemini" as const, modelId: "fixture" };
it("preserves configured context, compaction, hooks, store and approval resume", async () => {
  const execute = vi.fn((_input, context) => ({ tenant: context?.context?.tenant }));
  const compactor = vi.fn(() => ({ summary: "Earlier history." }));
  const guardrail = vi.fn(() => undefined), telemetry = vi.fn();
  const model = createMockLanguageModel({ capabilities: { toolHistory: "native" }, responses: [
    { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "new-call", name: "effect", input: {} } }] }], finishReason: "tool-calls" },
    { text: "done", messages: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }], finishReason: "stop" }
  ] });
  const store = createInMemoryAgentRunStore();
  const agent = createAgent({ id: "configured", model, contextSchema: z.object({ tenant: z.string() }), store,
    tools: { effect: tool({ name: "effect", schema: z.object({}), requiresApproval: true, approvalMode: "interrupt", execute }) }, maxSteps: 3,
    compaction: { maxMessages: 3, keepRecentMessages: 1, compactor }, inputGuardrails: [guardrail], onTelemetryEvent: telemetry
  });
  const gateway = createGateway({ adapters: { gemini: { name: "fixture", languageModel: () => model } } });
  const messages = [
    { role: "user" as const, parts: [{ type: "text" as const, text: "old" }] },
    { role: "assistant" as const, parts: [{ type: "tool-call" as const, toolCall: { id: "old-call", name: "effect", input: {} } }] },
    { role: "tool" as const, parts: [{ type: "tool-result" as const, toolResult: { toolCallId: "old-call", toolName: "effect", output: "already done", isError: false } }] },
    { role: "user" as const, parts: [{ type: "text" as const, text: "continue" }] }
  ];
  const initial = await gateway.runAgent({ primary, agent, messages, context: { tenant: "one" } });
  expect(initial.status).toBe("waiting_approval"); expect(execute).not.toHaveBeenCalled();
  const resumed = await gateway.runAgent({ primary, agent, runId: initial.state.runId, context: { tenant: "one" }, approvals: initial.state.pendingApprovals.map(x => ({ provider: x.provider, approvalRequestId: x.id, approve: true })) });
  expect(resumed.status).toBe("completed"); expect(resumed.state.runId).toBe(initial.state.runId);
  expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.results[0]!.value).toEqual({ tenant: "one" });
  expect(compactor).toHaveBeenCalled(); expect(guardrail).toHaveBeenCalled(); expect(telemetry).toHaveBeenCalled();
  expect((await store.load(resumed.state.runId))?.status).toBe("completed");
  await expect(gateway.runAgent({ primary: { ...primary, modelId: "different" }, agent, runId: resumed.state.runId, context: { tenant: "one" } })).rejects.toBeInstanceOf(ConflictError);
});
it("validates configured context before provider calls and respects invocation overrides", async () => {
  const model = createMockLanguageModel({ responses: [{ text: "ok", messages: [] }] }); model.generate = vi.fn(model.generate);
  const agent = createAgent({ id: "configured", model, contextSchema: z.object({ tenant: z.string() }), instructions: "default", maxTokens: 100 });
  const gateway = createGateway({ adapters: { gemini: { name: "fixture", languageModel: () => model } } });
  await expect(gateway.runAgent({ primary, agent, prompt: "hello", context: {} })).rejects.toThrow("Invalid agent context");
  expect(model.generate).not.toHaveBeenCalled();
  await gateway.runAgent({ primary, agent, prompt: "hello", context: { tenant: "one" }, maxTokens: 7 });
  expect(model.generate).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 7 }));
});
