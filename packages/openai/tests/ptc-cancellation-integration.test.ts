import { describe, expect, it, vi } from "vitest";
import { cancelAgentRun, createAgent, createAgentBudgetCoordinator, createInMemoryAgentRunStore, getAgentBudgetStatus, ProviderToolCallError, runAgent, streamAgent, type AgentRunState } from "@zhivex-ai/core";
import { createOpenAI, openAIProgrammaticToolCallingTool } from "../src/index.js";

const usage = { inputTokens: 4, outputTokens: 3, totalTokens: 7 };
const program = () => Response.json({ id: "resp_program", status: "completed",
  output: [{ type: "program_output", call_id: "call_program", result: "{}", status: "completed" }],
  usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } });

describe("PTC accounting with durable cancellation", () => {
  it.each([false, true])("keeps cumulative usage for a successful PTC response completed during cancellation (stream=%s)", async streaming => {
    const store = createInMemoryAgentRunStore();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(program()).mockImplementation(async () => {
      await cancelAgentRun(store, "ptc-success", { reason: "Stop" });
      return Response.json({ id: "resp_final", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } });
    });
    const model = createOpenAI({ apiKey: "offline", fetch })("gpt-5.6-sol");
    const agent = createAgent({ model, store, tools: { programmatic: openAIProgrammaticToolCallingTool() } });
    const request = { runId: "ptc-success", prompt: "calculate" };
    const result = streaming ? await streamAgent(agent, request).collect() : await runAgent(agent, request);
    expect(result.state).toMatchObject({ status: "cancel_requested", cancellationReason: "Stop", currentStep: 1,
      usage: { inputTokens: 6, outputTokens: 5, totalTokens: 11 }, steps: [expect.objectContaining({ response: expect.objectContaining({ providerRequestCount: 2 }) })] });
    expect(await store.load(request.runId)).toEqual(result.state);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("preserves an intervening checkpoint and returns the unsaved receipt explicitly (stream=%s)", async streaming => {
    const store = createInMemoryAgentRunStore();
    let authoritative: AgentRunState | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(program()).mockImplementation(async () => {
      const current = (await store.load("ptc-intervening"))!;
      await store.save({ ...current, memory: false, metadata: { owner: "newer" }, outputText: "authoritative output",
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 } }, { expectedRevision: current.revision });
      await cancelAgentRun(store, current.runId, { mode: "final", reason: "Stop" });
      authoritative = await store.load(current.runId);
      throw new Error("offline second request failed");
    });
    const model = createOpenAI({ apiKey: "offline", fetch })("gpt-5.6-sol");
    const agent = createAgent({ model, store, tools: { programmatic: openAIProgrammaticToolCallingTool() } });
    const request = { runId: "ptc-intervening", prompt: "calculate" };
    const stream = streaming ? streamAgent(agent, request) : undefined;
    const events = stream ? Array.fromAsync(stream.eventStream).catch(error => error) : undefined;
    const result = stream ? stream.collect() : runAgent(agent, request);
    await expect(result).rejects.toMatchObject({ confirmedUsage: usage, usageComplete: false, providerRequestCount: 2 });
    if (events) expect(await events).toBeInstanceOf(ProviderToolCallError);
    expect(await store.load(request.runId)).toEqual(authoritative);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  for (const streaming of [false, true]) {
    for (const mode of ["request", "final"] as const) {
      it.each(["partial", "complete-shared", "uncertain-shared"] as const)("retains %s receipts (stream=" + streaming + ", mode=" + mode + ")", async scenario => {
        const store = createInMemoryAgentRunStore();
        const shared = scenario !== "partial";
        const complete = scenario === "complete-shared";
        const coordinator = shared ? createAgentBudgetCoordinator({ store, budgetId: "ptc-cancel",
          limits: { inputTokens: 100, outputTokens: 100, totalTokens: 200 } }) : undefined;
        const settle = coordinator ? vi.spyOn(coordinator, "settle") : undefined;
        const fetch = vi.fn<typeof globalThis.fetch>();
        if (!shared) fetch.mockResolvedValueOnce(program());
        fetch.mockImplementation(async () => {
          await cancelAgentRun(store, "ptc-cancel", { mode, reason: "Stop" });
          if (complete) return program();
          throw new Error("offline request failed after cancellation");
        });
        const model = createOpenAI({ apiKey: "offline", fetch })("gpt-5.6-sol");
        const agent = createAgent({ model, store, tools: { programmatic: openAIProgrammaticToolCallingTool() },
          ...(coordinator ? { policy: { budgetCoordinator: coordinator, modelReservation: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } } } : {}) });
        const request = { runId: "ptc-cancel", prompt: "calculate", memory: false as const };
        const result = streaming ? await streamAgent(agent, request).collect() : await runAgent(agent, request);
        expect(result.status).toBe(mode === "final" ? "cancelled" : "cancel_requested");
        expect(fetch).toHaveBeenCalledTimes(shared ? 1 : 2);
        const durable = (await store.load("ptc-cancel"))!;
        expect(durable).toMatchObject({ memory: false, status: result.status, cancellationReason: "Stop",
          error: { usageComplete: complete, providerRequestCount: shared ? 1 : 2, effectsPossible: true, retryable: false } });
        expect(result.state).toEqual(durable);
        if (scenario !== "uncertain-shared") expect(durable.usage).toEqual(usage);
        expect(getAgentBudgetStatus(durable, {}).unknownUsageRunIds).toEqual(complete ? [] : ["ptc-cancel"]);
        if (coordinator) {
          expect(settle).toHaveBeenCalledWith("model:ptc-cancel:1", complete ? expect.objectContaining(usage) : undefined);
          const ledger = await store.list!({}, { tenantId: "__zhivex_unscoped_budget__", namespace: "__zhivex_budget__" });
          expect(Object.values(ledger.items[0]!.metadata!.allocations as object)).toEqual([expect.objectContaining({
            status: complete ? "confirmed" : "unknown", tokens: complete ? usage : { inputTokens: 10, outputTokens: 10, totalTokens: 20 } })]);
        }
        if (mode === "request") {
          const finalized = (await cancelAgentRun(store, durable.runId, { mode: "final", reason: "Finalize cancellation" }))!;
          expect(finalized).toMatchObject({ status: "cancelled", cancellationReason: "Stop", error: durable.error });
          expect(finalized.usage).toEqual(durable.usage);
          expect(getAgentBudgetStatus(finalized, {}).unknownUsageRunIds).toEqual(complete ? [] : [durable.runId]);
        }
      });
    }
  }
});
