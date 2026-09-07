import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool, type ModelMessage, type ModelGenerateInput } from "@zhivex-ai/core";
import { createOpenAI } from "@zhivex-ai/openai";
import { createDeepSeek } from "@zhivex-ai/deepseek";
import { createQwen } from "../../qwen/src/index.js";
import { createGateway, type GatewayProviderId } from "../src/index.js";

const cases = [
  { provider: "openai", modelId: "gpt-4.1", apiMode: "chat", factory: createOpenAI },
  { provider: "openai", modelId: "gpt-4.1", apiMode: "responses", factory: createOpenAI },
  { provider: "deepseek", modelId: "deepseek-chat", apiMode: "chat", factory: createDeepSeek },
  { provider: "qwen", modelId: "qwen-plus", apiMode: "chat", factory: createQwen },
  { provider: "qwen", modelId: "qwen-plus", apiMode: "responses", factory: createQwen }
] as const;
const messages: ModelMessage[] = [
  { role: "user", parts: [{ type: "text", text: "Use the previous results." }] },
  { role: "assistant", parts: [
    { type: "text", text: "Looking up two cities." },
    { type: "tool-call", toolCall: { id: "weather_1", name: "weather", input: { city: "Buenos Aires", nested: { units: ["C"] } } } },
    { type: "tool-call", toolCall: { id: "weather_2", name: "weather", input: { city: "Madrid" } } }
  ] },
  { role: "tool", parts: [
    { type: "tool-result", toolResult: { toolCallId: "weather_2", toolName: "weather", error: { message: "private failure" }, isError: true } },
    // Deliberately error-shaped success: an outer discriminant must distinguish the two.
    { type: "tool-result", toolResult: { toolCallId: "weather_1", toolName: "weather", output: { error: { message: "private failure" } }, isError: false } }
  ] }
];
function response(apiMode: string, streaming: boolean) {
  const usage = { input_tokens: 20, output_tokens: 3, total_tokens: 23 };
  if (apiMode === "responses") {
    const body = { id: "resp_1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "continued" }] }], usage };
    return streaming ? new Response('data: {"type":"response.output_text.delta","delta":"continued"}\n\n' + 'data: ' + JSON.stringify({ type: "response.completed", response: body }) + '\n\n', { headers: { "content-type": "text/event-stream" } }) : Response.json(body);
  }
  const chatUsage = { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 };
  return streaming ? new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: "continued" }, finish_reason: "stop" }], usage: chatUsage }) + '\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) : Response.json({ choices: [{ message: { role: "assistant", content: "continued" }, finish_reason: "stop" }], usage: chatUsage });
}

describe.each(cases)("$provider $apiMode canonical history", ({ provider, modelId, apiMode, factory }) => {
  it.each([false, true])("preserves every result and its error discriminant (stream=%s)", async (streaming) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(apiMode, streaming));
    const adapter = factory({ apiKey: "test", fetch });
    const execute = vi.fn();
    const gateway = createGateway({ adapters: { [provider]: adapter }, maxRetries: 0 });
    const request = { primary: { provider, modelId }, messages, providerOptions: provider === "deepseek" ? {} : { apiMode }, tools: { weather: tool({ name: "weather", schema: z.object({ city: z.string() }), execute }) } };
    const result = streaming ? await gateway.streamText(request).collect() : await gateway.generate(request);
    expect(result).toMatchObject({ text: "continued", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23, estimated: false } });
    expect(result.attempts).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    const results = apiMode === "chat" ? body.messages.filter((m: any) => m.role === "tool") : body.input.filter((m: any) => m.type === "function_call_output");
    expect(results.map((r: any) => r.tool_call_id ?? r.call_id)).toEqual(["weather_2", "weather_1"]);
    expect(results.map((r: any) => JSON.parse(r.content ?? r.output))).toEqual([
      { error: { message: "private failure" } }, { output: { error: { message: "private failure" } } }
    ]);
    const calls = apiMode === "chat" ? body.messages[1].tool_calls : body.input.filter((m: any) => m.type === "function_call");
    expect(calls.map((c: any) => c.id ?? c.call_id)).toEqual(["weather_1", "weather_2"]);
    expect(JSON.parse(calls[0].arguments ?? calls[0].function.arguments)).toEqual({ city: "Buenos Aires", nested: { units: ["C"] } });
    if (provider === "deepseek") expect(body.thinking).toEqual({ type: "disabled" });
    if (provider === "qwen") expect(body.enable_thinking).toBe(false);
    expect(result.messages.slice(0, messages.length)).toEqual(messages);
  });

  it("retains raw serialization for existing direct SDK consumers and fixes multiple results", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(apiMode, false));
    await factory({ apiKey: "test", fetch })(modelId).generate({ messages, providerOptions: provider === "deepseek" ? { thinking: { type: "disabled" } } : { apiMode, enable_thinking: false } });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    const results = apiMode === "chat" ? body.messages.filter((m: any) => m.role === "tool") : body.input.filter((m: any) => m.type === "function_call_output");
    expect(results).toHaveLength(2);
    expect(JSON.parse(results[1].content ?? results[1].output)).toEqual({ error: { message: "private failure" } });
  });
});

describe("cross-provider history routing", () => {
  it.each([false, true])("falls back OpenAI -> DeepSeek -> Qwen with unchanged canonical input (stream=%s)", async (streaming) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: "private payload" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: { message: "private payload" } }, { status: 503 }))
      .mockResolvedValueOnce(response("responses", streaming));
    const gateway = createGateway({ adapters: { openai: createOpenAI({ apiKey: "test", fetch }), deepseek: createDeepSeek({ apiKey: "test", fetch }), qwen: createQwen({ apiKey: "test", fetch }) }, maxRetries: 0, scoreTarget: ({ target }) => ({ openai: 3, deepseek: 2, qwen: 1 })[target.provider as "openai" | "deepseek" | "qwen"] });
    const request = { primary: { provider: "openai" as GatewayProviderId, modelId: "gpt-4.1" }, fallbacks: [{ provider: "deepseek" as GatewayProviderId, modelId: "deepseek-chat" }, { provider: "qwen" as GatewayProviderId, modelId: "qwen-plus" }], messages };
    const result = streaming ? await gateway.streamText(request).collect() : await gateway.generate(request);
    expect(result.providerUsed).toBe("qwen");
    expect(result.attempts.map((a) => a.ok)).toEqual([false, false, true]);
    const bodies = fetch.mock.calls.map((c) => JSON.parse(String(c[1]!.body)));
    const outputs = bodies.map((body) => body.input
      ? body.input.filter((item: any) => item.type === "function_call_output").map((item: any) => ({ id: item.call_id, value: item.output }))
      : body.messages.filter((item: any) => item.role === "tool").map((item: any) => ({ id: item.tool_call_id, value: item.content })));
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[1]).toEqual(outputs[2]);
    expect(JSON.stringify(result.attempts)).not.toContain("private payload");
  });

  it.each(["deepseek", "qwen"] as const)("rejects explicit thinking replay on %s before HTTP", async (provider) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = provider === "deepseek" ? createDeepSeek({ apiKey: "test", fetch }) : createQwen({ apiKey: "test", fetch });
    const gateway = createGateway({ adapters: { [provider]: adapter } });
    await expect(gateway.generate({ primary: { provider, modelId: provider === "qwen" ? "qwen-plus" : "deepseek-chat" }, messages, reasoning: { effort: "high" } })).rejects.toThrow("thinking state");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects text after calls rather than reordering it on JSON transports", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const gateway = createGateway({ adapters: { openai: createOpenAI({ apiKey: "test", fetch }) } });
    const history = structuredClone(messages);
    history[1]!.parts.push({ type: "text", text: "Must remain after the calls" });
    await expect(gateway.generate({ primary: { provider: "openai", modelId: "gpt-4.1" }, messages: history })).rejects.toThrow("interleaved");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets custom adapters explicitly opt in without a provider-name allowlist", async () => {
    const base = createDeepSeek({ apiKey: "test" })("deepseek-chat");
    const generate = vi.fn(async (input: ModelGenerateInput) => {
      expect(input.toolResultFormat).toBe("envelope");
      expect(input.messages).toEqual(messages);
      return { text: "custom", messages: [] };
    });
    const gateway = createGateway({ adapters: { ollama: { name: "custom", languageModel: () => ({ ...base, provider: "custom", capabilities: { ...base.capabilities, toolHistory: "json" }, generate }) } } });
    expect((await gateway.generate({ primary: { provider: "ollama", modelId: "custom" }, messages })).text).toBe("custom");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary callable names separate from OpenAI hosted tool heuristics", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response("responses", false));
    const gateway = createGateway({ adapters: { openai: createOpenAI({ apiKey: "test", fetch }) } });
    const input = structuredClone(messages);
    for (const message of input) for (const part of message.parts) {
      if (part.type === "tool-call") part.toolCall.name = "computer";
      if (part.type === "tool-result") part.toolResult.toolName = "computer";
    }
    await gateway.generate({ primary: { provider: "openai", modelId: "gpt-4.1" }, messages: input, providerOptions: { apiMode: "responses" } });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.input.filter((item: any) => item.type === "function_call_output")).toHaveLength(2);
    expect(body.input.some((item: any) => item.type === "computer_call_output")).toBe(false);
  });
});
