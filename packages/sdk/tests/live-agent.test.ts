import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent, createTextMessage, runRealtimeDelegations, tool, type LanguageModel, type RealtimeConnection } from "../src/index.js";
import { runRealtimeDelegations as coreBridge } from "@zhivex-ai/core";
import { runRealtimeDelegations as agentsBridge } from "../../agents/src/realtime.js";
import { connectOpenAILiveAgent } from "../../../examples/openai-live-agent.js";

describe("public Live backend bridge", () => {
  it("exports one bridge and runs a Zhivex tool loop before returning a reviewed result", async () => {
    expect(runRealtimeDelegations).toBe(coreBridge);
    expect(agentsBridge).toBe(coreBridge);
    const execute = vi.fn(async () => ({ status: "shipped" }));
    let calls = 0;
    const model: LanguageModel = {
      provider: "test", modelId: "backend",
      capabilities: { streaming: false, tools: true, structuredOutput: false, jsonMode: false, toolChoice: true, parallelToolCalls: false, vision: false, audioInput: false, audioOutput: false, embeddings: false, reasoning: false, webSearch: false },
      async generate() {
        if (++calls === 1) return { messages: [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "tool_1", name: "lookup", input: {} } }] }], finishReason: "tool-calls" };
        return { messages: [createTextMessage("assistant", "Your order shipped.")], text: "Your order shipped.", finishReason: "stop" };
      },
      async stream() { throw new Error("not used"); }
    };
    const backend = createAgent({ model, maxSteps: 3, tools: { lookup: tool({ name: "lookup", schema: z.object({}), execute }) } });
    const queue: unknown[] = [];
    let waiter: ((v: unknown) => void) | undefined;
    const push = (value: unknown) => { if (waiter) { const resolve = waiter; waiter = undefined; resolve(value); } else queue.push(value); };
    const sent: Record<string, unknown>[] = [];
    const connection: RealtimeConnection = {
      async sendJson(payload) {
        sent.push(payload);
        if (payload.type === "session.start") push({ type: "session.started", session: { id: "live_test" } });
        if (payload.type === "session.close") push({ type: "session.closed", usage: { duration_seconds: 1 } });
      },
      async recvJson() { return queue.length ? queue.shift() : new Promise((resolve) => { waiter = resolve; }); },
      async close() { push(undefined); }
    };
    const review = vi.fn(async (output) => output.status === "completed" ? output.outputText : undefined);
    const { session, done } = await connectOpenAILiveAgent({ apiKey: "fake", realtimeConnectionFactory: async () => connection, backend, resultForSpeech: review });
    push({ type: "session.input_transcript.delta", delta: "Where is my order?", start_ms: 0, end_ms: 100 });
    push({ type: "session.delegation.created", delegation: { id: "item_external", target: "client" }, offset_ms: 100 });
    await vi.waitFor(() => expect(sent.some((p) => p.type === "session.commentary.append")).toBe(true));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toMatchObject({ type: "session.commentary.append", delegation_id: "item_external", content: "Your order shipped." });
    expect(sent.some((p) => p.type === "response.create" || p.type === "conversation.item.create")).toBe(false);
    await session.close();
    await done;
  });
});
