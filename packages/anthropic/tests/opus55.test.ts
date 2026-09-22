import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { hostedTool, providerDataPart } from "@zhivex-ai/core";
import { createAnthropic } from "../src/index.js";

const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];
const thinking = { type: "thinking", thinking: "", signature: "opaque-signature" };

describe.each(["claude-opus-5-5", "claude-opus-5-5-20260922"])("%s", (id) => {
  it("rejects disabled/manual thinking and forced tools before generation or streaming", async () => {
    const fetcher = vi.fn();
    const model = createAnthropic({ apiKey: "test", fetch: fetcher })(id);
    expect(model.capabilities.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const options of [
      { reasoning: { effort: "none" as const } },
      { reasoning: { budgetTokens: 2048 } },
      { providerOptions: { thinking: { type: "disabled" as const } } },
      { providerOptions: { thinking: { type: "enabled" as const, budget_tokens: 2048 } } },
      { toolChoice: "required" as const },
      { toolChoice: { toolName: "sum" } },
      { providerOptions: { tool_choice: { type: "any" as const } } },
      { providerOptions: { tool_choice: { type: "tool" as const, name: "sum" } } },
    ]) {
      await expect(model.generate({ messages, ...options })).rejects.toThrow();
      await expect(model.stream({ messages, ...options })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves opaque thinking and accepts progress, binding controls, and native structured output", async () => {
    const fetcher = vi.fn(async () => Response.json({ content: [thinking, { type: "text", text: '{"ok":true}' }], stop_reason: "end_turn" }));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    const result = await model.generate({ messages, reasoning: { effort: "low" }, toolChoice: "auto",
      structuredOutput: { mode: "native", name: "result", schema: z.object({ ok: z.boolean() }) },
      providerOptions: { thinking: { type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } } } });
    expect(result.text).toBe('{"ok":true}');
    expect(result.messages[0].parts[0]).toEqual(providerDataPart("anthropic", thinking));
    await model.generate({ messages: [...messages, ...result.messages, ...messages] });
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    const body = JSON.parse(String(calls[0][1].body));
    expect(body.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    expect(body.thinking).toMatchObject({ type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(new Headers(calls[0][1].headers).get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01");
    expect(new Headers(calls[0][1].headers).get("anthropic-beta")).toContain("thinking-display-updates-2026-08-18");
    expect(JSON.parse(String(calls[1][1].body)).messages[1].content[0]).toEqual(thinking);
  });

  it("rejects legacy computer use and serializes the new toolset without a name", async () => {
    const fetcher = vi.fn(async () => Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    const computer = (type: string) => ({ computer: hostedTool({ name: "computer", provider: "anthropic", type, config: {} }) });
    await expect(model.generate({ messages, tools: computer("computer_20251124") })).rejects.toThrow("computer_toolset_20260801");
    await expect(model.stream({ messages, tools: computer("computer_20251124") })).rejects.toThrow("computer_toolset_20260801");
    expect(fetcher).not.toHaveBeenCalled();
    await model.generate({ messages, tools: computer("computer_toolset_20260801") });
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[0][1].body)).tools).toEqual([{ type: "computer_toolset_20260801" }]);
  });

  it("streams progress and opaque signatures as provider data alongside tool calls", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking the result." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "click", toolset_name: "computer", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];
    const fetcher = vi.fn(async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    const received = [];
    for await (const event of await model.stream({ messages, providerOptions: { thinking: { type: "adaptive", display: "updates" } } })) received.push(event);
    expect(received).toContainEqual(expect.objectContaining({ type: "provider-data", data: { type: "thinking_delta", thinking: "Checking the result." } }));
    expect(received).toContainEqual(expect.objectContaining({ type: "provider-data", data: { type: "signature_delta", signature: "opaque-signature" } }));
    expect(received).toContainEqual(expect.objectContaining({ type: "tool-call", toolCall: expect.objectContaining({ id: "call_1", name: "click", input: { x: 1 }, providerMetadata: { toolset_name: "computer" } }) }));
  });
});

it("keeps Opus 5 thinking-disabled compatibility", async () => {
  const fetcher = vi.fn(async () => Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })("claude-opus-5");
  await expect(model.generate({ messages, reasoning: { effort: "none" } })).resolves.toMatchObject({ text: "ok" });
});
