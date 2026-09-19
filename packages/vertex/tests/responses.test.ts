import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateText, generateObject, hostedTool, type ModelGenerateInput } from "@zhivex-ai/core";
import { createVertex } from "../src/index.js";
const input: ModelGenerateInput = { messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }] };
const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }];
const response = () => Response.json({ id: "r1", status: "completed", output, usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 6 } } });
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response());
  const provider = createVertex({ projectId: "p", location: "global", accessToken: "google-token", fetch });
  return { fetch, provider, model: provider.responsesModel("xai/grok-4.20-reasoning") };
};
const body = (fetch: ReturnType<typeof setup>["fetch"]) => JSON.parse(fetch.mock.lastCall![1]!.body as string);

describe("Vertex Grok Responses", () => {
  it("routes to Google, uses Google credentials, and preserves identity and token usage", async () => {
    const { fetch, model } = setup();
    const result = await model.generate({ ...input, maxTokens: 40 });
    expect(fetch.mock.lastCall![0]).toBe("https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi/responses");
    expect(new Headers(fetch.mock.lastCall![1]!.headers).get("authorization")).toBe("Bearer google-token");
    expect(fetch.mock.lastCall![1]!.redirect).toBe("error");
    expect(body(fetch)).toMatchObject({ store: false, model: "xai/grok-4.20-reasoning", max_output_tokens: 40 });
    expect(model.provider).toBe("vertex");
    expect(result.text).toBe("ok");
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20, cachedInputTokens: 4, reasoningTokens: 6 });
    expect(result.messages![0].parts.filter(p => p.type === "provider-data").every(p => p.provider === "vertex")).toBe(true);
  });

  it("sends native JSON Schema through text.format", async () => {
    const { fetch, model } = setup();
    fetch.mockImplementationOnce(async () => Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}' }] }] }));
    expect((await generateObject({ model, prompt: "test", schema: z.object({ ok: z.boolean() }), mode: "native" })).object).toEqual({ ok: true });
    expect(body(fetch).text.format).toMatchObject({ type: "json_schema", strict: true, schema: { type: "object", required: ["ok"] } });
    expect(body(fetch).response_format).toBeUndefined();
  });

  it("replays complete function history without response IDs, including reserved function names", async () => {
    const { fetch, model } = setup();
    fetch.mockImplementationOnce(async () => Response.json({ id: "r1", status: "completed", output: [
      { type: "function_call", id: "item1", call_id: "c1", name: "shell", arguments: '{"n":2}' }
    ] }));
    const execute = vi.fn(async ({ n }: { n: number }) => n + 3);
    const result = await generateText({ model, prompt: "Compute", tools: { shell: { name: "shell", schema: z.object({ n: z.number() }), execute } }, maxSteps: 3 });
    expect(result.text).toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(body(fetch).previous_response_id).toBeUndefined();
    expect(body(fetch).store).toBe(false);
    expect(body(fetch).input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "c1", name: "shell" }),
      expect.objectContaining({ type: "function_call_output", call_id: "c1" })
    ]));
    const calls = body(fetch).input.filter((v: any) => v.type === "function_call");
    expect(calls).toHaveLength(1);
    // Direct low-level raw mode must not turn local shell into an OpenAI hosted tool.
    await model.generate({ messages: [{ role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "c2", toolName: "computer", output: { ok: true } } }] }], toolResultFormat: "raw" });
    expect(body(fetch).input[0]).toEqual({ type: "function_call_output", call_id: "c2", output: '{"ok":true}' });
  });

  it("maps streaming text, function calls and provider-data with a terminal finish", async () => {
    const { fetch, model } = setup();
    const call = { type: "function_call", id: "item1", call_id: "c1", name: "sum", arguments: '{"a":2}' };
    const events = [
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "item1", output_index: 1, delta: '{"a":2}' },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [...output, call], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } }
    ];
    fetch.mockImplementationOnce(async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    const collected = [];
    for await (const event of await model.stream!({ ...input, tools: { sum: { name: "sum", schema: z.object({ a: z.number() }) } } })) collected.push(event);
    expect(collected).toContainEqual({ type: "text-delta", textDelta: "ok" });
    expect(collected.filter(e => e.type === "tool-call")).toHaveLength(1);
    expect(collected.filter(e => e.type === "provider-data").every(e => e.provider === "vertex")).toBe(true);
    expect(collected).toEqual(expect.arrayContaining([expect.objectContaining({ type: "finish", finishReason: "tool-calls" })]));
    expect(body(fetch).stream).toBe(true);
  });

  it("rejects unsupported options and hosted tools before fetching", async () => {
    const { fetch, model } = setup();
    for (const providerOptions of [{ store: true }, { previous_response_id: "r1" }, { apiMode: "chat" }, { background: true }, { tools: [] }, { reasoning: { effort: "high" } }, { include: ["reasoning.encrypted_content"] }, { model: "gpt-5" }]) {
      await expect(model.generate({ ...input, providerOptions })).rejects.toThrow("Vertex Grok Responses");
      await expect(model.stream!({ ...input, providerOptions })).rejects.toThrow("Vertex Grok Responses");
    }
    await expect(model.generate({ ...input, reasoning: { effort: "high" } })).rejects.toThrow("model-defined");
    await expect(model.generate({ ...input, tools: { search: hostedTool({ provider: "openai", type: "web_search", name: "search" }) } })).rejects.toThrow("hosted tools");
    for (const metadata of [{ "openai.responses_tool_type": "shell" }, { "openai.responses_function_config": { type: "web_search" } }]) {
      await expect(model.generate({ ...input, tools: { f: { name: "f", schema: z.object({}), metadata } } })).rejects.toThrow("OpenAI tool metadata");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps image inputs and rejects file/audio inputs without requests", async () => {
    const { fetch, model } = setup();
    await model.generate({ messages: [{ role: "user", parts: [{ type: "image", image: "AQI=", mediaType: "image/png" }] }] });
    expect(body(fetch).input[0].content[0]).toEqual({ type: "input_image", image_url: "data:image/png;base64,AQI=" });
    fetch.mockClear();
    for (const type of ["audio", "file"] as const) await expect(model.generate({ messages: [{ role: "user", parts: [{ type, data: "AQI=", mediaType: "application/octet-stream" }] }] })).rejects.toThrow("does not support");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not accept a truncated stream as completed or retry emitted text", async () => {
    const { fetch, model } = setup();
    fetch.mockImplementationOnce(async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', { headers: { "content-type": "text/event-stream" } }));
    const events = await model.stream!({ ...input, maxRetries: 2 });
    const seen = [];
    await expect((async () => { for await (const event of events) seen.push(event); })()).rejects.toThrow();
    expect(seen).toContainEqual({ type: "text-delta", textDelta: "partial" });
    expect(seen.some(event => event.type === "finish")).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects API keys, regional endpoints and unrecognized models", () => {
    const { provider } = setup();
    for (const id of ["gemini-2.5-flash", "xai/grok-unknown", "openai/gpt-oss-120b-maas"]) expect(() => provider.responsesModel(id)).toThrow("model ID");
    expect(() => createVertex({ apiKey: "key" }).responsesModel("grok-4.3")).toThrow("bearer");
    expect(() => createVertex({ projectId: "p", accessToken: "token", location: "us-central1" }).responsesModel("grok-4.3")).toThrow("global");
  });

  it("retries HTTP failures and reports them as Vertex errors", async () => {
    const { fetch, model } = setup();
    fetch.mockImplementationOnce(async () => new Response('busy', { status: 503 }));
    expect((await model.generate({ ...input, maxRetries: 1, retryBackoffMs: 1 })).text).toBe("ok");
    fetch.mockImplementationOnce(async () => new Response('denied', { status: 403 }));
    await expect(model.generate({ ...input, maxRetries: 0 })).rejects.toMatchObject({ status: 403, message: "Vertex Responses request failed with status 403." });
  });
});
