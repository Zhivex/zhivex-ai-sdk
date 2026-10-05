import { describe, expect, it, vi } from "vitest";
import { generateText, streamText, tool, type StreamEvent } from "@zhivex-ai/core";
import { z } from "zod";
import { createMeta } from "../src/index.js";
import capturedUsage from "./fixtures/responses-reasoning-usage.json" with { type: "json" };

// Redacted usage projection from the retained Contributor diagnostic. The text
// and response identifiers below are synthetic; no provider traffic is needed.
const text = '{"answer":"offline usage regression"}';
const variants = [
  { label: "reported reasoning", details: capturedUsage.output_tokens_details, expected: 790 },
  { label: "explicit zero", details: { reasoning_tokens: 0 }, expected: 0 },
  { label: "unreported reasoning", details: undefined, expected: undefined },
  { label: "empty details", details: {}, expected: undefined }
];
const responseBody = (details: unknown) => ({
  id: "resp_usage_fixture",
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { ...capturedUsage, output_tokens_details: details }
});
const sse = (events: unknown[]) => new Response(
  events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } }
);
const expectUsage = (usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; totalTokens?: number } | undefined, reasoning: number | undefined) => {
  expect(usage).toMatchObject({ inputTokens: 1679, outputTokens: 830, totalTokens: 2509 });
  expect(usage?.reasoningTokens).toBe(reasoning);
  // Reasoning is already included in outputTokens, so it must not be added again.
  expect(usage?.totalTokens).toBe(usage!.inputTokens! + usage!.outputTokens!);
};

describe("Meta token usage", () => {
  it.each(variants)("preserves Responses generate usage: $label", async ({ details, expected }) => {
    const body = responseBody(details);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
    const provider = createMeta({ apiKey: "offline-usage-fixture", fetch });
    const result = await generateText({ model: provider("muse-spark-1.3-contributor"), prompt: "offline fixture", providerOptions: { apiMode: "responses" }, maxRetries: 0 });
    expectUsage(result.usage, expected);
    expect(result.steps[0].response.usage?.reasoningTokens).toBe(expected);
    expect(result.text).toBe(text);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe("https://api.meta.ai/v1/responses");
  });

  it.each(variants)("preserves grounded Responses usage: $label", async ({ details, expected }) => {
    const body = responseBody(details);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
    const provider = createMeta({ apiKey: "offline-usage-fixture", fetch });
    const result = await provider.groundedLanguageModel("muse-spark-1.3-contributor").generate({ prompt: "offline fixture" });
    expectUsage(result.usage, expected);
    expect(result.text).toBe(text);
    expect(result.rawResponse).toEqual(body);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  for (const status of ["completed", "failed", "incomplete"] as const) {
    it.each(variants)(`preserves response.${status} stream usage: $label`, async ({ details, expected }) => {
      const body = { ...responseBody(details), status };
      const fetch = vi.fn<typeof globalThis.fetch>(async () => sse([
        { type: "response.output_text.delta", delta: text },
        { type: `response.${status}`, response: body }
      ]));
      const model = createMeta({ apiKey: "offline-usage-fixture", fetch })("muse-spark-1.3-contributor");
      const events: StreamEvent[] = [];
      for await (const event of await model.stream({ messages: [], providerOptions: { apiMode: "responses" }, maxRetries: 0 })) events.push(event);
      const finishes = events.filter(event => event.type === "finish");
      expect(finishes).toHaveLength(1);
      expectUsage(finishes[0].usage, expected);
      expect(finishes[0].providerFinishReason).toBe(status);
      expect(events.filter(event => event.type === "text-delta").map(event => event.textDelta).join("")).toBe(text);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  it.each(variants)("preserves usage through streamText collection: $label", async ({ details, expected }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => sse([
      { type: "response.output_text.delta", delta: text },
      { type: "response.completed", response: responseBody(details) }
    ]));
    const model = createMeta({ apiKey: "offline-usage-fixture", fetch })("muse-spark-1.3-contributor");
    const result = await streamText({ model, prompt: "offline fixture", providerOptions: { apiMode: "responses" }, maxRetries: 0 }).collect();
    expectUsage(result.usage, expected);
    expect(result.text).toBe(text);
  });

  for (const streaming of [false, true]) {
    it.each(variants)(`retains Chat Completions compatibility (${streaming ? "stream" : "generate"}): $label`, async ({ details, expected }) => {
      const usage = { prompt_tokens: 1679, completion_tokens: 830, total_tokens: 2509, completion_tokens_details: details, prompt_tokens_details: { cached_tokens: 113 } };
      const fetch = vi.fn<typeof globalThis.fetch>(async () => streaming ? sse([
        { choices: [{ delta: { content: text }, finish_reason: "stop" }] }, { choices: [], usage }
      ]) : Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage }));
      const model = createMeta({ apiKey: "offline-usage-fixture", fetch })("muse-spark-1.3-contributor");
      const input = { model, prompt: "offline fixture", maxRetries: 0 };
      const result = streaming ? await streamText(input).collect() : await generateText(input);
      expectUsage(result.usage, expected);
      expect(result.usage?.cachedInputTokens).toBe(113);
      expect(result.text).toBe(text);
      expect(String(fetch.mock.calls[0][0])).toBe("https://api.meta.ai/v1/chat/completions");
    });
  }

  it("leaves absent Responses usage unknown without inventing zero counters", async () => {
    const body = { ...responseBody(undefined), usage: undefined };
    const provider = createMeta({ apiKey: "offline-usage-fixture", fetch: async () => Response.json(body) });
    const result = await provider("muse-spark-1.3-contributor").generate({ messages: [], providerOptions: { apiMode: "responses" } });
    const grounded = await provider.groundedLanguageModel("muse-spark-1.3-contributor").generate({ prompt: "offline fixture" });
    for (const usage of [result.usage, grounded.usage]) {
      for (const field of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens"] as const) expect(usage?.[field]).toBeUndefined();
    }
    const model = createMeta({ apiKey: "offline-usage-fixture", fetch: async () => sse([{ type: "response.completed", response: body }]) })("muse-spark-1.3-contributor");
    const events: StreamEvent[] = [];
    for await (const event of await model.stream({ messages: [], providerOptions: { apiMode: "responses" } })) events.push(event);
    expect(events.find(event => event.type === "finish")?.usage).toBeUndefined();
  });

  it.each([false, true])("aggregates reasoning as a subset across tool steps (streaming=%s)", async streaming => {
    const first = { ...responseBody(capturedUsage.output_tokens_details), id: "resp_usage_first",
      output: [{ type: "function_call", id: "item_usage", call_id: "call_usage", name: "ack", arguments: "{}" }] };
    const second = { ...responseBody({ reasoning_tokens: 2 }), id: "resp_usage_second",
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } };
    const responses = [first, second];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const body = responses.shift()!;
      if (!streaming) return Response.json(body);
      const events = body === first
        ? [{ type: "response.output_item.done", item: first.output[0] }]
        : [{ type: "response.output_text.delta", delta: text }];
      return sse([...events, { type: "response.completed", response: body }]);
    });
    const execute = vi.fn(() => "acknowledged");
    const input = { model: createMeta({ apiKey: "offline-usage-fixture", fetch })("muse-spark-1.3-contributor"),
      prompt: "offline fixture", providerOptions: { apiMode: "responses" as const }, maxSteps: 2, maxRetries: 0,
      tools: { ack: tool({ name: "ack", schema: z.object({}), execute }) } };
    const result = streaming ? await streamText(input).collect() : await generateText(input);
    expect(result.usage).toMatchObject({ inputTokens: 1681, outputTokens: 833, totalTokens: 2514, reasoningTokens: 792 });
    expect(result.text).toBe(text);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
