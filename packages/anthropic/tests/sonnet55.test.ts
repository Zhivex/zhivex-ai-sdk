import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getAgentCapabilities, hostedTool, inspectProviderAgentSupport, providerDataPart, type ModelGenerateInput } from "@zhivex-ai/core";
import { createAnthropic, createAnthropicMessagesModel } from "../src/index.js";

const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];
const response = () => Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
const bodyAt = (fetcher: ReturnType<typeof vi.fn>, index = 0) => JSON.parse(String(fetcher.mock.calls[index][1].body));
const nativeTool = (type: string, config = {}) => ({ native: hostedTool({ provider: "anthropic", name: "native", type, config }) });

describe.each(["claude-sonnet-5-5", "claude-sonnet-5-5-20260928", "claude-sonnet-5-5@20260928"])("%s", (id) => {
  it("advertises computer use through the public capability helpers", () => {
    const model = createAnthropic({ apiKey: "test" })(id);
    expect(getAgentCapabilities(model)).toMatchObject({ computerUse: true, hostedWebSearch: true, codeExecution: true, toolsets: true });
    expect(inspectProviderAgentSupport(model).hostedToolSummary).toContain("computer use");
  });

  it("maps none to between_tools, leaves default thinking to the API, and accepts the effort ladder", async () => {
    const fetcher = vi.fn(async () => response());
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    expect(model.capabilities.reasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    await model.generate({ messages });
    expect(bodyAt(fetcher)).not.toHaveProperty("thinking");
    expect(bodyAt(fetcher)).not.toHaveProperty("output_config");
    await model.generate({ messages, reasoning: { effort: "none" } });
    expect(bodyAt(fetcher, 1).thinking).toEqual({ type: "between_tools" });
    expect(new Headers(fetcher.mock.calls[1][1].headers).has("anthropic-beta")).toBe(false);
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      await model.generate({ messages, reasoning: { effort } });
      expect(bodyAt(fetcher, fetcher.mock.calls.length - 1)).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort } });
    }
  });

  it.each(["low", "medium", "high"] as const)("accepts explicit between_tools with %s effort", async (effort) => {
    const fetcher = vi.fn(async () => response());
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    await model.generate({ messages, reasoning: { effort }, providerOptions: { thinking: { type: "between_tools" } } });
    expect(bodyAt(fetcher)).toMatchObject({ thinking: { type: "between_tools" }, output_config: { effort } });
  });

  it("rejects invalid thinking, sampling, prefill, and forced tools before generation or streaming", async () => {
    const fetcher = vi.fn();
    const model = createAnthropic({ apiKey: "test", fetch: fetcher })(id);
    const invalid: Partial<ModelGenerateInput>[] = [
      { reasoning: { budgetTokens: 2048 } },
      { reasoning: { effort: "minimal" } },
      { reasoning: { effort: "none", budgetTokens: 2048 } },
      { providerOptions: { thinking: { type: "disabled" } } },
      { providerOptions: { thinking: { type: "enabled", budget_tokens: 2048 } } },
      ...["display", "budget_tokens", "block_binding"].map((key) => ({ providerOptions: { thinking: { type: "between_tools", [key]: key === "display" ? "updates" : key === "budget_tokens" ? 2048 : { prefix_mismatch_behavior: "drop_block" } } } })),
      ...["xhigh", "max"].map((effort) => ({ providerOptions: { thinking: { type: "between_tools" }, output_config: { effort } } })),
      { reasoning: { effort: "max" }, providerOptions: { thinking: { type: "between_tools" } } },
      { reasoning: { effort: "none" }, providerOptions: { output_config: { effort: "xhigh" } } },
      { toolChoice: "required" },
      { toolChoice: { toolName: "sum" } },
      { providerOptions: { tool_choice: { type: "any" } } },
      { providerOptions: { tool_choice: { type: "tool", name: "sum" } } },
      { temperature: 0.5 },
      { providerOptions: { top_p: 0.5 } },
      { providerOptions: { top_k: 1 } },
      { messages: [...messages, { role: "assistant", parts: [{ type: "text", text: "Prefill" }] }] },
    ];
    for (const options of invalid) {
      await expect(model.generate({ messages, ...options })).rejects.toThrow();
      await expect(model.stream({ messages, ...options })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves signed thinking and native JSON output with binding and progress controls", async () => {
    const thinking = { type: "thinking", thinking: "Checking.", signature: "opaque-signature" };
    const fetcher = vi.fn(async () => Response.json({ content: [thinking, { type: "text", text: '{"ok":true}' }], stop_reason: "end_turn" }));
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    const result = await model.generate({ messages, toolChoice: "auto", reasoning: { effort: "low" },
      structuredOutput: { mode: "native", name: "result", schema: z.object({ ok: z.boolean() }) },
      providerOptions: { thinking: { type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } } } });
    expect(result.messages[0].parts[0]).toEqual(providerDataPart("anthropic", thinking));
    expect(bodyAt(fetcher).output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    const betas = new Headers(fetcher.mock.calls[0][1].headers).get("anthropic-beta");
    expect(betas).toContain("thinking-binding-controls-2026-08-01");
    expect(betas).toContain("thinking-display-updates-2026-08-18");
    await model.generate({ messages: [...messages, ...result.messages, ...messages], toolChoice: "none" });
    expect(bodyAt(fetcher, 1).messages[1].content[0]).toEqual(thinking);
    expect(bodyAt(fetcher, 1).tool_choice).toEqual({ type: "none" });
  });

  it("rejects legacy computer tools and incompatible advisors, and accepts the toolset", async () => {
    const fetcher = vi.fn(async () => response());
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
    const rejected = [nativeTool("computer_20250124"), nativeTool("computer_20251124"),
      ...["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"].map((model) => nativeTool("advisor_20260301", { model }))];
    for (const tools of rejected) {
      await expect(model.generate({ messages, tools })).rejects.toThrow();
      await expect(model.stream({ messages, tools })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
    await model.generate({ messages, tools: nativeTool("computer_toolset_20260801") });
    expect(bodyAt(fetcher).tools).toEqual([{ type: "computer_toolset_20260801" }]);
    for (const advisor of ["claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-5-1", "claude-sonnet-5-5"]) {
      await model.generate({ messages, tools: nativeTool("advisor_20260301", { model: advisor }) });
      expect(bodyAt(fetcher, fetcher.mock.calls.length - 1).tools[0].model).toBe(advisor);
    }
  });

  it("supports default server fallback and its beta header", async () => {
    const fetcher = vi.fn(async () => response());
    await createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })(id).generate({ messages, providerOptions: { fallbacks: "default" } });
    expect(bodyAt(fetcher).fallbacks).toBe("default");
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
  });

  it("streams between-tools progress, signatures, text and tool calls without losing metadata", async () => {
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
    for await (const event of await model.stream({ messages, reasoning: { effort: "none" } })) received.push(event);
    expect(bodyAt(fetcher).thinking).toEqual({ type: "between_tools" });
    expect(received).toContainEqual(expect.objectContaining({ type: "provider-data", data: { type: "thinking_delta", thinking: "Checking." } }));
    expect(received).toContainEqual(expect.objectContaining({ type: "provider-data", data: { type: "signature_delta", signature: "opaque-signature" } }));
    expect(received).toContainEqual(expect.objectContaining({ type: "tool-call", toolCall: expect.objectContaining({ name: "click", input: { x: 1 }, providerMetadata: { toolset_name: "computer" } }) }));
    expect(received).toContainEqual({ type: "text-delta", textDelta: "Done." });
  });
});

it.each(["claude-sonnet-5", "claude-sonnet-5-50", "claude-opus-5-5", "claude-haiku-4-5"])("does not enable between_tools on %s", async (id) => {
  const fetcher = vi.fn();
  const model = createAnthropic({ apiKey: "test", fetch: fetcher })(id);
  expect(getAgentCapabilities(model).computerUse).toBe(false);
  const input = { messages, providerOptions: { thinking: { type: "between_tools" as const } } };
  await expect(model.generate(input)).rejects.toThrow("requires Claude Sonnet 5.5");
  await expect(model.stream(input)).rejects.toThrow("requires Claude Sonnet 5.5");
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves Sonnet 5 disabled thinking and forced tools", async () => {
  const fetcher = vi.fn(async () => response());
  await createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })("claude-sonnet-5").generate({ messages, reasoning: { effort: "none" }, toolChoice: "required" });
  expect(bodyAt(fetcher)).toMatchObject({ thinking: { type: "disabled" }, tool_choice: { type: "any" } });
});

it("retains the legacy computer tool for custom Bedrock Messages transports", async () => {
  const send = vi.fn(async (_body: string) => response());
  const model = createAnthropicMessagesModel({ modelId: "claude-sonnet-5-5", provider: "bedrock", transport: { send } });
  await model.generate({ messages, tools: nativeTool("computer_20251124") });
  expect(JSON.parse(send.mock.calls[0][0]).tools[0].type).toBe("computer_20251124");
});
