import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool, type ModelMessage, type ProviderAdapter, type StreamEvent } from "@zhivex-ai/core";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createGateway, GatewayError, type GatewayRequest } from "../src/index.js";
import { gatewayMessagesToModelMessages } from "../src/compat.js";

const primary = { provider: "anthropic", modelId: "claude-sonnet-4-6" } as const;
const history = (error = false): ModelMessage[] => [
  { role: "user", parts: [{ type: "text", text: "¿Qué temperatura hace en Buenos Aires?" }] },
  { role: "assistant", parts: [
    { type: "text", text: "Consulto el tiempo." },
    { type: "tool-call", toolCall: { id: "call_weather_1", name: "weather", input: { city: "Buenos Aires", nested: { units: ["C"] } } } },
    { type: "tool-call", toolCall: { id: "call_weather_2", name: "weather", input: { city: "Madrid" } } }
  ] },
  { role: "tool", parts: [
    { type: "tool-result", toolResult: { toolCallId: "call_weather_2", toolName: "weather", output: "sunny", isError: false } },
    { type: "tool-result", toolResult: error
      ? { toolCallId: "call_weather_1", toolName: "weather", error: { message: "private tool error" }, isError: true }
      : { toolCallId: "call_weather_1", toolName: "weather", output: { temperatureC: 18 }, isError: false }
    }
  ] }
];
const response = () => Response.json({ content: [{ type: "text", text: "18 °C" }], stop_reason: "end_turn", usage: { input_tokens: 40, output_tokens: 5 } });
const streamResponse = () => new Response([
  'event: message_start\ndata: {"message":{"usage":{"input_tokens":40}}}\n\n',
  'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"18 °C"}}\n\n',
  'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {}\n\n'
].join(""), { headers: { "content-type": "text/event-stream" } });

function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const adapter = createAnthropic({ apiKey: "test", fetch });
  const attempts = vi.fn();
  return { fetch, adapter, attempts, gateway: createGateway({ adapters: { anthropic: adapter }, maxRetries: 0, scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0, onAttempt: attempts }) };
}

describe("gateway canonical tool history", () => {
  it.each([false, true])("preserves Anthropic transport, association and error=%s without reexecution", async (error) => {
    const { gateway, fetch } = fixture();
    fetch.mockResolvedValue(response());
    const execute = vi.fn();
    const messages = history(error);
    const request: GatewayRequest = { primary, messages, tools: { weather: tool({ name: "weather", schema: z.object({ city: z.string() }), execute }) } };
    const result = await gateway.generate(request);
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "Consulto el tiempo." },
      { type: "tool_use", id: "call_weather_1", name: "weather", input: { city: "Buenos Aires", nested: { units: ["C"] } } },
      { type: "tool_use", id: "call_weather_2", name: "weather", input: { city: "Madrid" } }
    ]);
    expect(body.messages[2]).toEqual({ role: "user", content: [
      { type: "tool_result", tool_use_id: "call_weather_2", content: '"sunny"', is_error: false },
      { type: "tool_result", tool_use_id: "call_weather_1", content: JSON.stringify(error ? { message: "private tool error" } : { temperatureC: 18 }), is_error: error }
    ] });
    expect(result).toMatchObject({ text: "18 °C", finishReason: "stop", usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45, estimated: false } });
    expect(result.attempts).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(messages).toEqual(history(error));
  });

  it("streams the same history and falls back to a compatible Claude before output", async () => {
    const { gateway, fetch } = fixture();
    fetch.mockResolvedValueOnce(Response.json({ error: { message: "private provider payload" } }, { status: 503 }));
    fetch.mockResolvedValueOnce(streamResponse());
    const result = await gateway.streamText({ primary, fallbacks: [{ ...primary, modelId: "claude-opus-4-6" }], messages: history() }).collect();
    expect(result).toMatchObject({ text: "18 °C", finishReason: "stop", modelUsed: "claude-opus-4-6", usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 } });
    expect(result.attempts.map((attempt) => attempt.ok)).toEqual([false, true]);
    const bodies = fetch.mock.calls.map((call) => JSON.parse(String(call[1]!.body)));
    expect(bodies[0].messages).toEqual(bodies[1].messages);
    expect(JSON.stringify(result.attempts)).not.toContain("private provider payload");
  });

  it("skips incompatible destinations even when they advertise tools", async () => {
    const { adapter, fetch, attempts } = fixture();
    fetch.mockResolvedValue(response());
    const generate = vi.fn();
    const incompatible: ProviderAdapter = { name: "openai", languageModel: (modelId) => ({ ...adapter(modelId), provider: "openai", generate }) };
    const gateway = createGateway({ adapters: { anthropic: adapter, openai: incompatible }, scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0, onAttempt: attempts });
    const result = await gateway.generate({ primary: { provider: "openai", modelId: "unsupported" }, fallbacks: [primary], messages: history() });
    expect(generate).not.toHaveBeenCalled();
    expect(result.attempts[0]).toMatchObject({ ok: false, reasonCode: "model-capabilities" });
    await expect(gateway.generate({ primary: { provider: "openai", modelId: "unsupported" }, messages: history() })).rejects.toBeInstanceOf(GatewayError);
  });

  it("requires tool capability without tool definitions and includes history in estimated usage", async () => {
    const { adapter } = fixture();
    const generate = vi.fn().mockResolvedValue({ text: "ok", messages: [{ role: "assistant", parts: [{ type: "text", text: "ok" }] }] });
    const gateway = createGateway({ adapters: { anthropic: { name: "anthropic", languageModel: (id) => ({ ...adapter(id), generate }) } } });
    const result = await gateway.generate({ primary, messages: history() });
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(40);
    const unsupported = createGateway({ adapters: { anthropic: { name: "anthropic", languageModel: (id) => { const model = adapter(id); return { ...model, capabilities: { ...model.capabilities, tools: false }, generate }; } } } });
    await expect(unsupported.generate({ primary, messages: history(), requiredCapabilities: { tools: false } })).rejects.toBeInstanceOf(GatewayError);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["orphan", [{ role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "secret", toolName: "weather", output: null, isError: false } }] }]],
    ["unresolved", history().slice(0, 2)],
    ["duplicate", [...history(), ...history().slice(1)]],
    ["wrong name", [...history().slice(0, 2), { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "call_weather_1", toolName: "secret", output: null, isError: false } }] }]],
    ["wrong role", [{ ...history()[1], role: "user" }]],
    ["ambiguous", [{ ...history()[0], content: "secret" }]],
    ["unsupported", [{ role: "user", parts: [{ type: "provider-data", provider: "anthropic", data: "secret" }] }]],
    ["mid-system", [...history(), { role: "system", parts: [{ type: "text", text: "secret" }] }]],
    ["non-json", [{ role: "assistant", parts: [{ type: "tool-call", toolCall: { id: "a", name: "weather", input: { secret: undefined } } }] }]],
    ["duplicate result", [...history(), history()[2]]],
    ["interrupted", [...history().slice(0, 2), history()[0], history()[2]]]
  ])("rejects %s with sanitized diagnostics before adapter construction", async (_name, messages) => {
    const languageModel = vi.fn();
    const gateway = createGateway({ adapters: { anthropic: { name: "anthropic", languageModel } } });
    // Intentional untyped boundary: runtime callers must receive typed validation errors too.
    const request = { primary, messages } as unknown as GatewayRequest;
    await expect(gateway.generate(request)).rejects.toThrow("Invalid or unsupported gateway message history.");
    expect(() => gateway.streamText(request)).toThrow(GatewayError);
    expect(languageModel).not.toHaveBeenCalled();
  });

  it("preserves legacy image conversion and snapshots canonical JSON", () => {
    expect(gatewayMessagesToModelMessages([{ role: "user", content: "photo", images: [{ dataUrl: "data:image/png;base64,AA==", mimeType: "image/png" }] }], "system")).toEqual([
      { role: "system", parts: [{ type: "text", text: "system" }] },
      { role: "user", parts: [{ type: "text", text: "photo" }, { type: "image", image: "data:image/png;base64,AA==", mediaType: "image/png" }] }
    ]);
    const messages = history();
    const converted = gatewayMessagesToModelMessages(messages);
    expect(converted).toEqual(messages);
    expect(converted[1]!.parts).not.toBe(messages[1]!.parts);
  });

  it("keeps generation fallback history immutable when an adapter mutates its input", async () => {
    const { adapter } = fixture();
    const observed: ModelMessage[][] = [];
    const gateway = createGateway({ adapters: { anthropic: {
      name: "anthropic", languageModel: (id) => ({ ...adapter(id), generate: async (input) => {
        observed.push(structuredClone(input.messages));
        if (id === primary.modelId) { input.messages.length = 0; throw new Error("private input"); }
        return { text: "ok", messages: [{ role: "assistant", parts: [{ type: "text", text: "ok" }] }], finishReason: "stop" };
      } })
    } }, maxRetries: 0, scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0 });
    const result = await gateway.generate({ primary, fallbacks: [{ ...primary, modelId: "claude-opus-4-6" }], messages: history() });
    expect(observed[0]).toEqual(observed[1]);
    expect(observed[1]).toEqual(history());
    expect(result.attempts.map((attempt) => attempt.ok)).toEqual([false, true]);
  });

  it("streams historical errors without running registered executors", async () => {
    const { gateway, fetch } = fixture();
    fetch.mockResolvedValueOnce(streamResponse());
    const execute = vi.fn();
    await gateway.streamText({ primary, messages: history(true), tools: { weather: tool({ name: "weather", schema: z.object({ city: z.string() }), execute }) } }).collect();
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).messages[2].content[1]).toMatchObject({ type: "tool_result", is_error: true });
  });

  it.each([false, true])("continues object output through the same transport (stream=%s)", async (streaming) => {
    const { gateway, fetch } = fixture();
    const text = '{"temperatureC":18}';
    if (streaming) {
      fetch.mockResolvedValueOnce(new Response(
        'event: content_block_delta\ndata: ' + JSON.stringify({ index: 0, delta: { type: "text_delta", text } }) + '\n\n' +
        'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n' +
        'event: message_stop\ndata: {}\n\n', { headers: { "content-type": "text/event-stream" } }
      ));
    } else fetch.mockResolvedValueOnce(Response.json({ content: [{ type: "text", text }], stop_reason: "end_turn" }));
    const request = { primary, messages: history(), schema: z.object({ temperatureC: z.number() }) };
    const result = streaming ? await gateway.streamObject(request).collect() : await gateway.generateObject(request);
    expect(result.object).toEqual({ temperatureC: 18 });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).messages[2].content[1]).toMatchObject({ type: "tool_result", tool_use_id: "call_weather_1" });
  });

  it.each([false, true])("sanitizes failure after first output (event=%s) without restarting", async (event) => {
    const { adapter } = fixture();
    const stream = vi.fn(async () => (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "partial" };
      if (event) yield { type: "error", error: new Error("private result and credential") };
      else throw new Error("private result and credential");
    })());
    const gateway = createGateway({ adapters: { anthropic: { name: "anthropic", languageModel: (id) => ({ ...adapter(id), stream }) } }, maxRetries: 2 });
    const result = gateway.streamText({ primary, fallbacks: [{ ...primary, modelId: "claude-opus-4-6" }], messages: history() });
    await expect(result.collect()).rejects.toThrow("Gateway provider failed while continuing tool history.");
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("sanitizes caller cancellation and stops fallback", async () => {
    const { adapter, attempts } = fixture();
    const controller = new AbortController();
    const generate = vi.fn(async () => { controller.abort(new Error("private cancellation context")); await new Promise((resolve) => setTimeout(resolve, 10)); return { text: "late", messages: [] }; });
    const gateway = createGateway({ adapters: { anthropic: { name: "anthropic", languageModel: (id) => ({ ...adapter(id), generate }) } }, onAttempt: attempts });
    await expect(gateway.generate({ primary, fallbacks: [{ ...primary, modelId: "claude-opus-4-6" }], messages: history(), abortSignal: controller.signal })).rejects.toThrow("Gateway request aborted.");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(attempts.mock.calls)).not.toContain("private cancellation");
  });

  it("does not expose provider iterator cleanup failures", async () => {
    const { adapter } = fixture();
    let first = true;
    const stream = vi.fn(async (): Promise<AsyncIterable<StreamEvent>> => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (first) { first = false; return { done: false, value: { type: "text-delta", textDelta: "partial" } }; }
          throw new Error("private provider failure");
        },
        return: async () => { throw new Error("private cleanup credential"); }
      })
    }));
    const gateway = createGateway({ adapters: { anthropic: { name: "anthropic", languageModel: (id) => ({ ...adapter(id), stream }) } } });
    await expect(gateway.streamText({ primary, messages: history() }).collect()).rejects.toThrow("Gateway provider failed while continuing tool history.");
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("explicitly rejects canonical histories on agent surfaces", async () => {
    const { gateway, fetch } = fixture();
    // JS users cannot bypass the deliberately legacy-only agent input contract.
    const request = { primary, messages: history() } as unknown as Parameters<typeof gateway.runAgent>[0];
    await expect(gateway.runAgent(request)).rejects.toThrow("not supported by agent");
    expect(() => gateway.streamAgent(request)).toThrow("not supported by agent");
    expect(fetch).not.toHaveBeenCalled();
  });
});
