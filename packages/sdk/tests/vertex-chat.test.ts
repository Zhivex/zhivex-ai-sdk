import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateText, generateObject, streamText, tool } from "../src/index.js";
import { createVertex } from "../../vertex/src/index.js";
import { createGateway } from "../../gateway/src/index.js";

describe("SDK Vertex partner consumption", () => {
  it("routes publisher-qualified models and falls back within the Vertex host", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: "model unavailable in this region" } }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ id: "msg-1", type: "message", role: "assistant", content: [{ type: "text", text: "Claude fallback" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 3 } }));
    const vertex = createVertex({ projectId: "project", accessToken: "test", fetch });
    const gateway = createGateway({ adapters: { vertex }, maxRetries: 0, scoreTarget: ({ isPrimary }) => isPrimary ? 1 : 0 });
    const result = await gateway.generate({
      primary: { provider: "vertex", modelId: "meta/llama-4-maverick-17b-128e-instruct-maas" },
      fallbacks: [{ provider: "vertex", modelId: "claude-sonnet-4-6" }],
      messages: [{ role: "user", content: "hello" }]
    });
    expect(result.text).toBe("Claude fallback");
    expect(result.providerUsed).toBe("vertex");
    expect(result.attempts).toHaveLength(2);
    expect(String(fetch.mock.calls[0][0])).toContain("endpoints/openapi/chat/completions");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).model).toBe("meta/llama-4-maverick-17b-128e-instruct-maas");
    expect(String(fetch.mock.calls[1][0])).toContain("publishers/anthropic/models/claude-sonnet-4-6:rawPredict");
  });
  it("executes a client tool loop and preserves Google-hosted model identity", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"id":1}' } }] }, finish_reason: "tool_calls" }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "found" }, finish_reason: "stop" }] }));
    const execute = vi.fn(async () => ({ found: true }));
    const model = createVertex({ projectId: "project", accessToken: "test", fetch })("qwen/qwen3-next-80b-a3b-instruct-maas");
    const result = await generateText({ model, prompt: "lookup 1", maxSteps: 2, tools: { lookup: tool({ name: "lookup", schema: z.object({ id: z.number() }), execute }) } });
    expect(result.text).toBe("found");
    expect(execute).toHaveBeenCalledTimes(1);
    const second = JSON.parse(fetch.mock.calls[1][1]!.body as string);
    expect(second.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
    expect(model.provider).toBe("vertex");
  });

  it("validates native structured output through the SDK", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }));
    const model = createVertex({ projectId: "project", accessToken: "test", fetch })("meta/llama-4-maverick-17b-128e-instruct-maas");
    const result = await generateObject({ model, prompt: "return ok", schema: z.object({ ok: z.boolean() }), mode: "native" });
    expect(result.object).toEqual({ ok: true });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).response_format.type).toBe("json_schema");
  });

  it("streams partner text through the SDK", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }));
    const model = createVertex({ projectId: "project", accessToken: "test", fetch })("mistral-medium-3");
    const result = await streamText({ model, prompt: "hello" }).collect();
    expect(result.text).toBe("hello");
    expect(String(fetch.mock.calls[0][0])).toContain(":streamRawPredict");
  });
});
