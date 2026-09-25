import { describe, expect, it } from "vitest";
import { Agent, createInMemoryAgentRunStore, createTextMessage } from "../src/index.js";
import { createMockLanguageModel } from "../src/testing.js";
import type { AgentCompactionAuxiliaryRoute } from "../src/types.js";

const route: AgentCompactionAuxiliaryRoute = {
  provider: "fixture", modelId: "summary", fingerprint: "prompt-v1", priceRevision: "fixture-v1",
  reservation: { inputTokens: 40, outputTokens: 5, totalTokens: 45 }
};
const auxiliaryUsage = { inputTokens: 40, outputTokens: 5, totalTokens: 45 };
const messages = [createTextMessage("user", "x".repeat(1000)), createTextMessage("assistant", "Earlier answer."), createTextMessage("user", "Continue.")];
const model = () => createMockLanguageModel({ responses: [{ messages: [createTextMessage("assistant", "done")], text: "done", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }], streamEvents: [[{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }]] });

describe("durable auxiliary compaction", () => {
  it.each([false, true])("accounts 100+20 main and 40+5 auxiliary once (stream=%s)", async streaming => {
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ model: model(), store, compaction: { maxMessages: 2, keepRecentMessages: 1, auxiliary: route, compactor: () => ({ summary: "Earlier context.", usage: auxiliaryUsage }) } });
    const result = streaming ? await agent.stream({ messages }).collect() : await agent.run({ messages });
    expect(result.usage).toEqual({ inputTokens: 140, outputTokens: 25, totalTokens: 165 });
    const persisted = (await store.load(result.state.runId))!;
    expect(persisted.usage).toEqual(result.usage);
    expect(persisted.compactionAttempts).toMatchObject([{ status: "confirmed", usage: auxiliaryUsage, route }]);
    expect(persisted.compactions).toHaveLength(1);
    await expect(agent.resume({ state: persisted, compaction: { maxMessages: 2, auxiliary: { ...route, modelId: "changed" }, compactor: () => ({ summary: "s" }) } })).rejects.toThrow("different auxiliary");
  });

  it("persists rejected summary consumption and refuses a paid retry", async () => {
    const store = createInMemoryAgentRunStore(); let calls = 0;
    const agent = new Agent({ model: model(), store, compaction: { maxMessages: 2, auxiliary: route, compactor: () => { calls++; return { summary: "", usage: auxiliaryUsage }; } } });
    await expect(agent.run({ runId: "reject", messages })).rejects.toThrow("empty summary");
    const persisted = (await store.load("reject"))!;
    expect(persisted.usage).toEqual(auxiliaryUsage);
    expect(persisted.compactionAttempts?.[0]?.status).toBe("confirmed");
    expect(persisted.compactions).toHaveLength(0);
    await expect(agent.resume({ state: persisted })).rejects.toThrow("already attempted");
    expect(calls).toBe(1);
  });

  it.each(["throw", "missing"])("persists unknown receipt and blocks resume after %s", async mode => {
    const store = createInMemoryAgentRunStore(); let calls = 0;
    const agent = new Agent({ model: model(), store, compaction: { maxMessages: 2, auxiliary: route, compactor: () => { calls++; if (mode === "throw") throw new Error("interrupted"); return { summary: "Short" }; } } });
    await expect(agent.run({ runId: mode, messages })).rejects.toThrow();
    const persisted = (await store.load(mode))!;
    expect(persisted.compactionAttempts?.[0]?.status).toBe("unknown");
    await expect(agent.resume({ state: persisted })).rejects.toThrow("consumption is unknown");
    expect(calls).toBe(1);
  });

  it("reserves before any call and refuses insufficient budget", async () => {
    let calls = 0;
    const agent = new Agent({ model: model(), store: createInMemoryAgentRunStore(), policy: { budget: { maxTotalTokens: 44 } }, compaction: { maxMessages: 2, auxiliary: route, compactor: () => { calls++; return { summary: "Short", usage: auxiliaryUsage }; } } });
    await expect(agent.run({ messages })).rejects.toThrow("reservation exceeds");
    expect(calls).toBe(0);
  });

  it("saves the in-flight reservation before dispatch and blocks crash replay", async () => {
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ model: model(), store, compaction: { maxMessages: 2, auxiliary: route, compactor: async () => {
      const inflight = (await store.load("crash"))!;
      expect(inflight.compactionAttempts?.[0]?.status).toBe("in-flight");
      await expect(agent.resume({ state: inflight })).rejects.toThrow("consumption is unknown");
      return { summary: "Short", usage: auxiliaryUsage };
    } } });
    await agent.run({ runId: "crash", messages });
  });
  it("preserves a billable receipt when its first save fails", async () => {
    const store = createInMemoryAgentRunStore();
    const save = store.save.bind(store); let failed = false;
    store.save = async (state, options) => {
      if (!failed && state.compactionAttempts?.[0]?.status === "confirmed") { failed = true; throw new Error("receipt save interrupted"); }
      await save(state, options);
    };
    const agent = new Agent({ model: model(), store, compaction: { maxMessages: 2, auxiliary: route, compactor: () => ({ summary: "Short", usage: auxiliaryUsage }) } });
    await expect(agent.run({ runId: "save-failure", messages })).rejects.toThrow("receipt save interrupted");
    const persisted = (await store.load("save-failure"))!;
    expect(persisted.usage).toEqual(auxiliaryUsage);
    expect(persisted.compactionAttempts?.[0]?.status).toBe("confirmed");
  });

  it("recalculates primary output headroom after paid compaction", async () => {
    const primary = model(); const generate = primary.generate.bind(primary);
    let ceiling: number | undefined;
    primary.generate = async request => { ceiling = request.maxTokens; return generate(request); };
    const agent = new Agent({ model: primary, store: createInMemoryAgentRunStore(), policy: { budget: { maxOutputTokens: 25 } }, compaction: { maxMessages: 2, auxiliary: route, compactor: () => ({ summary: "Short", usage: auxiliaryUsage }) } });
    await agent.run({ messages });
    expect(ceiling).toBe(20);
  });

  it("does not treat inconsistent provider totals as confirmed zero usage", async () => {
    const store = createInMemoryAgentRunStore();
    const agent = new Agent({ model: model(), store, compaction: { maxMessages: 2, auxiliary: route, compactor: () => ({ summary: "Short", usage: { ...auxiliaryUsage, totalTokens: 0 } }) } });
    await expect(agent.run({ runId: "bad-total", messages })).rejects.toThrow("unknown token");
    expect((await store.load("bad-total"))?.compactionAttempts?.[0]?.status).toBe("unknown");
  });

});
