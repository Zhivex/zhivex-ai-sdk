import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateObject } from "@zhivex-ai/sdk";
import { createVertex } from "../src/index.js";

const id = "minimaxai/minimax-m2-maas";
const envelope = '  <think>Consider an example {"ok":false}, then answer.</think>';
const answer = '\n{"ok":true}';
const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "Return ok=true" }] }] };
const json = (content: string) => Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json(envelope + answer));
  return { fetch, provider: createVertex({ projectId: "p", accessToken: "test", fetch }) };
};

describe("Vertex MiniMax inline thinking", () => {
  it("parses native objects without treating reasoning JSON as the answer", async () => {
    const { provider } = setup();
    const result = await generateObject({ model: provider(id), ...input, schema: z.object({ ok: z.literal(true) }), mode: "native" });
    expect(result.object).toEqual({ ok: true });
    expect(result.objectMode).toBe("native");
  });
  it("separates parts and restores exact assistant content for subsequent tool turns", async () => {
    const { provider, fetch } = setup();
    const model = provider(id);
    const result = await model.generate(input);
    expect(result.text).toBe(answer);
    expect(result.messages[0].parts).toEqual([
      { type: "provider-data", provider: "vertex", data: { type: "vertex_inline_thinking", content: envelope } },
      { type: "text", text: answer }
    ]);
    await model.generate({ messages: [...input.messages, ...result.messages] });
    const body = JSON.parse(fetch.mock.lastCall![1]!.body as string);
    expect(body.messages[1].content).toBe(envelope + answer);
    expect(body.messages[1].reasoning_content).toBeUndefined();
  });
  it("recognizes delimiters split at every character and preserves literal answer tags", async () => {
    const { provider, fetch } = setup();
    const content = envelope + 'Answer contains <think>literal</think> text.';
    fetch.mockResolvedValue(new Response([...content].map(char => `data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`).join("")
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    const events = [];
    for await (const event of await provider(id).stream(input)) events.push(event);
    expect(events.filter(event => event.type === "text-delta").map(event => event.textDelta).join("")).toBe('Answer contains <think>literal</think> text.');
    expect(events.filter(event => event.type === "provider-data")).toContainEqual({ type: "provider-data", provider: "vertex", data: { type: "vertex_inline_thinking", content: envelope } });
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });
  it("leaves other models, deployed endpoints and untagged MiniMax responses untouched", async () => {
    const { provider, fetch } = setup();
    expect((await provider("moonshotai/kimi-k2-thinking-maas").generate(input)).text).toBe(envelope + answer);
    expect((await provider.chatModel(id, { endpoint: "42" }).generate(input)).text).toBe(envelope + answer);
    fetch.mockResolvedValue(json('An answer with <think>literal</think>.'));
    expect((await provider(id).generate(input)).text).toBe('An answer with <think>literal</think>.');
  });
  it("rejects incomplete and oversized leading thinking instead of exposing it as answer text", async () => {
    const { provider, fetch } = setup();
    for (const content of ['<think>unfinished', '<think>' + 'x'.repeat(1024 * 1024) + '</think>answer']) {
      fetch.mockResolvedValue(json(content));
      await expect(provider(id).generate(input)).rejects.toThrow(/thinking envelope/);
    }
  });
});
