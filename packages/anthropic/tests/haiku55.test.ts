import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getAgentCapabilities, hostedTool, inspectProviderAgentSupport, providerDataPart, type ModelGenerateInput } from "@zhivex-ai/core";
import { createAnthropic, createAnthropicMessagesModel } from "../src/index.js";

const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];
const response = () => Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
const bodyAt = (fetcher: ReturnType<typeof vi.fn>, index = 0) => JSON.parse(String(fetcher.mock.calls[index][1].body));
const nativeTool = (type: string, config = {}) => ({ native: hostedTool({ provider: "anthropic", name: "native", type, config }) });

describe.each(["claude-haiku-5-5", "claude-haiku-5-5-20261007", "claude-haiku-5-5@20261007"])("%s", (id) => {
  it("advertises computer use through the public capability helpers", () => {
    const model = createAnthropic({ apiKey: "test" })(id);
    expect(getAgentCapabilities(model)).toMatchObject({ computerUse: true, hostedWebSearch: true, codeExecution: true, toolsets: true });
    expect(inspectProviderAgentSupport(model).hostedToolSummary).toContain("computer use");
  });

  it("accepts the adaptive effort ladder and leaves default thinking to the API", async () => {
    const fetcher = vi.fn(async () => response());
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    expect(model.capabilities.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    await model.generate({ messages });
    expect(bodyAt(fetcher)).not.toHaveProperty("thinking");
    expect(bodyAt(fetcher)).not.toHaveProperty("output_config");
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      await model.generate({ messages, reasoning: { effort } });
      expect(bodyAt(fetcher, fetcher.mock.calls.length - 1)).toMatchObject({
        thinking: { type: "adaptive" },
        output_config: { effort }
      });
    }
  });

  it("rejects none/disabled/manual thinking, sampling, and prefill before generation or streaming", async () => {
    const fetcher = vi.fn();
    const model = createAnthropic({ apiKey: "test", fetch: fetcher })(id);
    const invalid: Partial<ModelGenerateInput>[] = [
      { reasoning: { effort: "none" } },
      { reasoning: { budgetTokens: 2048 } },
      { reasoning: { effort: "minimal" } },
      { providerOptions: { thinking: { type: "disabled" } } },
      { providerOptions: { thinking: { type: "enabled", budget_tokens: 2048 } } },
      { providerOptions: { thinking: { type: "between_tools" } } },
      { temperature: 0.5 },
      { providerOptions: { top_p: 0.5 } },
      { providerOptions: { top_k: 1 } },
      { messages: [...messages, { role: "assistant", parts: [{ type: "text", text: "Prefill" }] }] },
      { providerOptions: { fallbacks: "default" } },
    ];
    for (const options of invalid) {
      await expect(model.generate({ messages, ...options })).rejects.toThrow();
      await expect(model.stream({ messages, ...options })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows forced tool choice unlike Sonnet/Opus 5.5 and preserves structured output with binding controls", async () => {
    const thinking = { type: "thinking", thinking: "Checking.", signature: "opaque-signature" };
    const fetcher = vi.fn(async () => Response.json({ content: [thinking, { type: "text", text: '{"ok":true}' }], stop_reason: "end_turn" }));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    const result = await model.generate({
      messages,
      toolChoice: "required",
      reasoning: { effort: "low" },
      structuredOutput: { mode: "native", name: "result", schema: z.object({ ok: z.boolean() }) },
      providerOptions: {
        thinking: { type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } }
      }
    });
    expect(result.messages[0].parts[0]).toEqual(providerDataPart("anthropic", thinking));
    expect(bodyAt(fetcher).tool_choice).toEqual({ type: "any" });
    expect(bodyAt(fetcher).output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    const betas = new Headers(fetcher.mock.calls[0][1].headers).get("anthropic-beta");
    expect(betas).toContain("thinking-binding-controls-2026-08-01");
    expect(betas).toContain("thinking-display-updates-2026-08-18");
  });

  it("rejects legacy computer tools and accepts the toolset", async () => {
    const fetcher = vi.fn(async () => response());
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    for (const tools of [nativeTool("computer_20250124"), nativeTool("computer_20251124")]) {
      await expect(model.generate({ messages, tools })).rejects.toThrow();
      await expect(model.stream({ messages, tools })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
    await model.generate({ messages, tools: nativeTool("computer_toolset_20260801") });
    expect(bodyAt(fetcher).tools).toEqual([{ type: "computer_toolset_20260801" }]);
  });

  it("streams progress and signatures as provider data alongside tool calls", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: "click", toolset_name: "computer", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Done." } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];
    const fetcher = vi.fn(async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    const received = [];
    for await (const event of await model.stream({ messages, reasoning: { effort: "low" } })) received.push(event);
    expect(bodyAt(fetcher)).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(received).toContainEqual(expect.objectContaining({ type: "provider-data", data: { type: "thinking_delta", thinking: "Checking." } }));
    expect(received).toContainEqual(expect.objectContaining({ type: "provider-data", data: { type: "signature_delta", signature: "opaque-signature" } }));
    expect(received).toContainEqual(expect.objectContaining({ type: "tool-call", toolCall: expect.objectContaining({ name: "click", input: { x: 1 }, providerMetadata: { toolset_name: "computer" } }) }));
    expect(received).toContainEqual({ type: "text-delta", textDelta: "Done." });
  });
});

it("keeps Sonnet-only between_tools and Haiku 4.5 budget thinking", async () => {
  const fetcher = vi.fn();
  const haiku55 = createAnthropic({ apiKey: "test", fetch: fetcher })("claude-haiku-5-5");
  await expect(haiku55.generate({ messages, providerOptions: { thinking: { type: "between_tools" } } })).rejects.toThrow("requires Claude Sonnet 5.5");
  expect(getAgentCapabilities(createAnthropic({ apiKey: "test" })("claude-haiku-4-5")).computerUse).toBe(false);
});

it("retains the legacy computer tool for custom Bedrock Messages transports", async () => {
  const send = vi.fn(async (_body: string) => response());
  const model = createAnthropicMessagesModel({ modelId: "claude-haiku-5-5", provider: "bedrock", transport: { send } });
  await model.generate({ messages, tools: nativeTool("computer_20251124") });
  expect(JSON.parse(send.mock.calls[0][0]).tools[0].type).toBe("computer_20251124");
});
