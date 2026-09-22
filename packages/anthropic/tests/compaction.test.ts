import { describe, expect, it, vi } from "vitest";
import { providerDataPart } from "@zhivex-ai/core";
import { createAnthropic } from "../src/index.js";

const block = { type: "compaction", content: "Keep the agreed recipe schema.", signature: "opaque-signature" };
const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "Summarize our work" }] }];

describe.each(["claude-opus-5", "claude-opus-5-5"])("Anthropic on-demand compaction: %s", (modelId) => {
  it("summarizes a completed assistant turn without treating it as a prefill", async () => {
    const fetcher = vi.fn(async () => Response.json({ content: [block], stop_reason: "compaction" }));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(modelId);
    const history = [...messages, { role: "assistant" as const, parts: [{ type: "text" as const, text: "Use Recipe and Ingredient entities." }] }];
    await expect(model.generate({ messages: history })).rejects.toThrow("prefill");
    await expect(model.generate({ messages: history, providerOptions: { compaction: { type: "summarize" } } })).resolves.toMatchObject({ providerFinishReason: "compaction" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves the signed block across requests and accounts for billed iterations", async () => {
    const fetcher = vi.fn(async () => Response.json({ content: [block], stop_reason: "compaction", usage: {
      input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", input_tokens: 144, output_tokens: 276 }]
    } }));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(modelId);
    const result = await model.generate({ messages, providerOptions: { compaction: { type: "summarize" } } });
    expect(result.providerFinishReason).toBe("compaction");
    expect(result.text).toBe("");
    expect(result.usage).toMatchObject({ inputTokens: 144, outputTokens: 276, totalTokens: 420 });
    expect(result.messages[0].parts).toEqual([providerDataPart("anthropic", block)]);
    await model.generate({ messages: [...result.messages, ...messages] });
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(new Headers(calls[0][1].headers).get("anthropic-beta")).toContain("compact-2026-09-04");
    expect(new Headers(calls[1][1].headers).get("anthropic-beta")).toContain("compact-2026-09-04");
    expect(JSON.parse(calls[1][1].body as string).messages[0].content[0]).toEqual(block);
  });

  it("rejects misplaced blocks and incompatible compaction options before I/O", async () => {
    const fetcher = vi.fn();
    const model = createAnthropic({ apiKey: "test", fetch: fetcher })(modelId);
    await expect(model.generate({ messages: [...messages, { role: "assistant", parts: [providerDataPart("anthropic", block)] }] })).rejects.toThrow("first block");
    for (const incompatible of [{ context_management: {} }, { stop_sequences: [] }, { output_config: { format: { type: "json_schema", schema: {} } } }]) {
      await expect(model.generate({ messages, providerOptions: { compaction: { type: "summarize" }, ...incompatible } })).rejects.toThrow("cannot combine");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("streams the whole signed block and preserves an empty unsuccessful summary", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "compaction" }, usage: { iterations: [{ type: "compaction", input_tokens: 10, output_tokens: 20 }] } },
      { type: "message_stop" }
    ];
    const fetcher = vi.fn(async () => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(modelId);
    const received = [];
    for await (const event of await model.stream({ messages, providerOptions: { compaction: { type: "summarize" } } })) received.push(event);
    expect(received).toContainEqual(expect.objectContaining({ type: "provider-data", data: block }));
    fetcher.mockImplementationOnce(async () => Response.json({ content: [], stop_reason: "max_tokens", usage: { iterations: [{ input_tokens: 10, output_tokens: 20 }] } }));
    const result = await model.generate({ messages, providerOptions: { compaction: { type: "summarize" } } });
    expect(result.messages[0].parts).toEqual([]);
    expect(result.providerFinishReason).toBe("max_tokens");
  });
});
