import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent, createAgentBudgetCoordinator, createInMemoryAgentRunStore, createTextMessage, getAgentBudgetStatus, ProviderToolCallError, runAgent } from "@zhivex-ai/core";
import { createOpenAI, openAIProgrammaticToolCallingTool } from "../src/index.js";
import { createGateway } from "../../gateway/src/index.js";

const usage = { inputTokens: 4, outputTokens: 3, totalTokens: 7 };
const program = (withUsage = true) => Response.json({ id: "resp_program", status: "completed", output: [{ type: "program_output", call_id: "call_program", result: "{}", status: "completed" }], ...(withUsage ? { usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } : {}) });
const final = () => Response.json({ id: "resp_final", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } });
const input = () => ({ messages: [createTextMessage("user", "calculate")], maxRetries: 2, retryBackoffMs: 0, tools: { programmatic: openAIProgrammaticToolCallingTool() } });
const fixture = () => { const fetch = vi.fn<typeof globalThis.fetch>(); const provider = createOpenAI({ apiKey: "offline", fetch }); return { fetch, provider, model: provider("gpt-5.6-sol") }; };
afterEach(() => vi.useRealTimers());

describe("PTC internal request accounting", () => {
  it("uses one cumulative output allowance across internal requests", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(program()).mockResolvedValueOnce(final());
    const result = await f.model.generate({ ...input(), maxTokens: 5 });
    expect(f.fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)).max_output_tokens)).toEqual([5, 2]);
    expect(result).toMatchObject({ usage: { inputTokens: 6, outputTokens: 5, totalTokens: 11 }, providerRequestCount: 2 });
  });
  it("stops before another request when the cumulative output allowance is exhausted", async () => {
    const f = fixture(); f.fetch.mockImplementation(async () => program());
    await expect(f.model.generate({ ...input(), maxTokens: 3 })).rejects.toMatchObject({ usage, usageComplete: true, effectsPossible: true, retryable: false, providerRequestCount: 1 });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("retains confirmed usage when a later dispatch fails without retrying paid work", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(program()).mockRejectedValue(new Error("network down"));
    const error = await f.model.generate(input()).catch(error => error);
    expect(error).toBeInstanceOf(ProviderToolCallError);
    expect(error).toMatchObject({ confirmedUsage: usage, usageComplete: false, providerRequestCount: 2, retryable: false, effectsPossible: true });
    expect(error.usage).toBeUndefined();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("does not continue after missing provider accounting", async () => {
    const f = fixture(); f.fetch.mockImplementation(async () => program(false));
    await expect(f.model.generate(input())).rejects.toMatchObject({ usageComplete: false, providerRequestCount: 1, retryable: false });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("reports continuation exhaustion as a nonretryable typed failure with complete usage", async () => {
    const f = fixture(); f.fetch.mockImplementation(async () => program());
    await expect(f.model.generate(input())).rejects.toMatchObject({ confirmedUsage: { inputTokens: 32, outputTokens: 24, totalTokens: 56 }, usageComplete: true, providerRequestCount: 8, retryable: false });
    expect(f.fetch).toHaveBeenCalledTimes(8);
  });
  it("releases PTC stream timeout resources when generation rejects before returning an iterator", async () => {
    vi.useFakeTimers(); const f = fixture(); f.fetch.mockRejectedValue(new Error("network down"));
    await expect(f.model.stream({ ...input(), timeoutMs: 10000, maxRetries: 0 })).rejects.toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("charges internal requests to the Gateway total attempt ceiling", async () => {
    const f = fixture(); f.fetch.mockImplementation(async () => program());
    const gateway = createGateway({ adapters: { openai: f.provider }, maxTotalAttempts: 2, maxRetries: 2, retryBackoffMs: 0 });
    await expect(gateway.generate({ primary: { provider: "openai", modelId: "gpt-5.6-sol" }, messages: [{ role: "user", content: "calculate" }], tools: input().tools })).rejects.toMatchObject({ providerRequestCount: 2, retryable: false });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("fails closed after one request under a Core per-step token budget", async () => {
    const f = fixture(); f.fetch.mockImplementation(async () => program()); const store = createInMemoryAgentRunStore();
    const agent = createAgent({ model: f.model, store, tools: input().tools, policy: { budget: { maxTotalTokens: 100 } } });
    await expect(runAgent(agent, { runId: "ptc-budget", prompt: "calculate" })).rejects.toMatchObject({ providerRequestCount: 1 });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const state = await store.load("ptc-budget");
    expect(state).toMatchObject({ usage, error: { confirmedUsage: usage, usageComplete: true, providerRequestCount: 1 } });
    expect(getAgentBudgetStatus(state!, { maxTotalTokens: 100 }).consumption.totalTokens).toBe(7);
  });
  it.each([false, true])("prevents unsafe fallback after a partial PTC failure (stream=%s)", async streaming => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(program()).mockRejectedValue(new Error("network down"));
    const fallback = vi.fn(); const attempts = vi.fn();
    const gateway = createGateway({ adapters: { openai: f.provider, anthropic: { name: "anthropic", languageModel: () => ({ ...f.model, provider: "anthropic", generate: fallback, stream: fallback }) } }, maxRetries: 2, retryBackoffMs: 0, onAttempt: attempts });
    const request = { primary: { provider: "openai" as const, modelId: "gpt-5.6-sol" }, fallbacks: [{ provider: "anthropic" as const, modelId: "test" }], messages: [{ role: "user" as const, content: "calculate" }], tools: input().tools };
    const result = streaming ? gateway.streamText(request).collect() : gateway.generate(request);
    await expect(result).rejects.toMatchObject({ confirmedUsage: usage, usageComplete: false, providerRequestCount: 2 });
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(fallback).not.toHaveBeenCalled();
    expect(attempts).toHaveBeenCalledWith(expect.objectContaining({ confirmedUsage: usage, usageComplete: false, providerRequestCount: 2, usage: undefined }));
  });
  it("retains uncertain usage durably and refuses automatic resume", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(program()).mockRejectedValue(new Error("network down"));
    const store = createInMemoryAgentRunStore(); const agent = createAgent({ model: f.model, store, tools: input().tools });
    await expect(runAgent(agent, { runId: "ptc-uncertain", prompt: "calculate" })).rejects.toMatchObject({ usageComplete: false });
    const state = await store.load("ptc-uncertain");
    expect(state).toMatchObject({ usage, error: { confirmedUsage: usage, usageComplete: false, providerRequestCount: 2 } });
    expect(getAgentBudgetStatus(state!, {}).unknownUsageRunIds).toEqual(["ptc-uncertain"]);
    await expect(runAgent(agent, { runId: "ptc-uncertain" })).rejects.toThrow("automatic resume is unsafe");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("settles complete shared-budget receipts and retains uncertain allocations (uncertain=%s)", async uncertain => {
    const f = fixture();
    if (uncertain) f.fetch.mockRejectedValue(new Error("network down"));
    else f.fetch.mockImplementation(async () => program());
    const store = createInMemoryAgentRunStore();
    const coordinator = createAgentBudgetCoordinator({ store, budgetId: "ptc", limits: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } });
    const settle = vi.spyOn(coordinator, "settle");
    const agent = createAgent({ model: f.model, store, tools: input().tools, policy: { budgetCoordinator: coordinator, modelReservation: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } } });
    await expect(runAgent(agent, { runId: "ptc-shared", prompt: "calculate" })).rejects.toBeInstanceOf(ProviderToolCallError);
    expect(settle).toHaveBeenCalledWith("model:ptc-shared:1", uncertain ? undefined : expect.objectContaining(usage));
    const ledger = await store.list!({}, { tenantId: "__zhivex_unscoped_budget__", namespace: "__zhivex_budget__" });
    expect(Object.values(ledger.items[0]!.metadata!.allocations as object)).toEqual([expect.objectContaining({ status: uncertain ? "unknown" : "confirmed", tokens: uncertain ? { inputTokens: 10, outputTokens: 10, totalTokens: 20 } : usage })]);
  });

});
