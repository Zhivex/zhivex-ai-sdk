import { describe, expect, it, vi } from "vitest";
import { tool } from "@zhivex-ai/core";
import { z } from "zod";
import { createGemini } from "../src/index.js";

const fixture = (events: unknown[] = []) => {
  const sent: Record<string, unknown>[] = [];
  let finish: (value: undefined) => void = () => {};
  const wait = new Promise<undefined>((resolve) => { finish = resolve; });
  const pending = [{ setupComplete: {} }, ...events];
  const factory = vi.fn(async () => ({
    async sendJson(value: Record<string, unknown>) { sent.push(value); },
    async recvJson() { return pending.length ? pending.shift() : wait; },
    async close() { finish(undefined); }
  }));
  return { sent, factory, provider: createGemini({ apiKey: "test", realtimeConnectionFactory: factory }) };
};

describe("Gemini 3.8 Live", () => {
  it.each(["gemini-3.8-live", "gemini-3.8-live-extended-thinking"])("maps non-blocking tools and text on %s", async (id) => {
    const { provider, sent } = fixture();
    const session = await provider.realtimeModel!(id).connect({
      tools: { weather: tool({ name: "weather", schema: z.object({ city: z.string() }), execute: () => "sunny" }) },
      ...(id.endsWith("thinking") ? { reasoning: { effort: "high" as const } } : {})
    });
    expect(sent[0]).toMatchObject({ setup: { model: `models/${id}`, tools: [{ functionDeclarations: [expect.objectContaining({ name: "weather", behavior: "NON_BLOCKING" })] }] } });
    await session.sendText("Hello");
    expect(sent[1]).toEqual({ clientContent: { turns: [{ role: "user", parts: [{ text: "Hello" }] }], turnComplete: true } });
    await session.sendToolResult({ toolCallId: "call-1", toolName: "weather", output: "sunny" });
    expect(sent[2]).toMatchObject({ toolResponse: { functionResponses: [{ id: "call-1", name: "weather" }] } });
    await session.close();
  });

  it("rejects unsupported reasoning and raw setup overrides before opening a socket", async () => {
    const { provider, factory } = fixture();
    await expect(provider.realtimeModel!("gemini-3.8-live").connect({ reasoning: { effort: "low" } })).rejects.toThrow("only Extended");
    await expect(provider.realtimeModel!("gemini-3.8-live-extended-thinking").connect({ reasoning: { effort: "minimal" } })).rejects.toThrow("only Extended");
    await expect(provider.realtimeModel!("gemini-3.8-live-extended-thinking").connect({ reasoning: { budgetTokens: 100 } })).rejects.toThrow("budgets");
    await expect(provider.realtimeModel!("gemini-3.8-live").connect({ providerOptions: { tools: [] } })).rejects.toThrow("shared session");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not complete background reasoning at intermediate spoken turn boundaries", async () => {
    const { provider } = fixture([
      { serverContent: { turnComplete: true, generationComplete: true, interactionStatus: "IN_PROGRESS", modelTurn: { parts: [{ text: "Checking" }, { inlineData: { data: "AQID", mimeType: "audio/pcm" } }] } } },
      { toolCall: { functionCalls: [{ id: "call-1", name: "weather", args: {} }] }, interactionStatus: "IN_PROGRESS" },
      { serverContent: { turnComplete: true, interactionStatus: "IDLE" } }
    ]);
    const session = await provider.realtimeModel!("gemini-3.8-live-extended-thinking").connect();
    const received = [];
    for await (const event of session.eventStream()) {
      received.push(event);
      if (event.type === "realtime-response-complete") break;
    }
    expect(received.filter((event) => event.type === "realtime-response-complete")).toHaveLength(1);
    expect(received).toContainEqual(expect.objectContaining({ type: "realtime-tool-call" }));
    expect(received).toContainEqual(expect.objectContaining({ type: "realtime-audio-output" }));
    expect(received).toContainEqual({ type: "realtime-provider-data", provider: "gemini", data: { interactionStatus: "IDLE" } });
    await session.close();
  });
});
