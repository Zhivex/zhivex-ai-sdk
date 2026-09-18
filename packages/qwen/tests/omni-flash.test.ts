import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateObject, type ModelGenerateInput, type ModelMessage } from "@zhivex-ai/core";
import { createQwen, qwenCodeInterpreterTool, qwenWebSearchTool, QWEN_TOKEN_PLAN_BASE_URL } from "../src/index.js";

const messages: ModelMessage[] = [{ role: "user", parts: [{ type: "text", text: "Describe this." }] }];
const setup = () => {
  const fetch = vi.fn(async (_url: unknown, _options: RequestInit) => new Response(JSON.stringify({ id: "r1", status: "completed", output: [], choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] })));
  return { fetch, model: createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })("qwen3.8-omni-flash") };
};

describe("Qwen3.8-Omni-Flash", () => {
  it("advertises its own contract without borrowing legacy Omni or general hosted capabilities", () => {
    expect(setup().model.capabilities).toMatchObject({ audioInput: true, audioOutput: false, files: true, vision: true,
      reasoning: true, structuredOutput: false, jsonMode: false, parallelToolCalls: false,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      agentCapabilities: { hostedWebSearch: true, hostedFileSearch: false, remoteMcp: false, codeExecution: false, webExtraction: false } });
  });

  it.each(["chat", "responses"] as const)("maps combined media through %s", async (apiMode) => {
    const { fetch, model } = setup();
    await model.generate({ messages: [{ role: "user", parts: [
      { type: "image", image: "https://example.com/image.jpg" },
      { type: "audio", data: new Uint8Array([1, 2]), mediaType: "audio/mpeg", providerMetadata: { use_multichannel: true } },
      { type: "file", data: "https://example.com/video.mp4", mediaType: "video/mp4" }
    ] }], providerOptions: { apiMode }, reasoning: { effort: "low" } });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(String(fetch.mock.calls[0]![0])).toContain(apiMode === "chat" ? "/chat/completions" : "/responses");
    if (apiMode === "chat") {
      expect(body).toMatchObject({ modalities: ["text"], reasoning_effort: "low", preserve_thinking: true });
      expect(body.messages[0].content).toEqual([
        { type: "image_url", image_url: { url: "https://example.com/image.jpg" } },
        { type: "input_audio", input_audio: { data: "data:audio/mpeg;base64,AQI=", format: "mp3", use_multichannel: true } },
        { type: "video_url", video_url: { url: "https://example.com/video.mp4" } }
      ]);
    } else {
      expect(body.reasoning).toEqual({ effort: "low" });
      expect(body.input[0].content).toEqual([
        { type: "input_image", image_url: "https://example.com/image.jpg" },
        { type: "input_audio", audio_url: "data:audio/mpeg;base64,AQI=", format: "mp3", use_multichannel: true },
        { type: "input_video", video_url: "https://example.com/video.mp4" }
      ]);
    }
  });

  it.each([["minimal", "low"], ["high", "xhigh"], ["max", "xhigh"], ["none", "none"]] as const)("maps Chat effort %s to %s", async (effort, expected) => {
    const { fetch, model } = setup();
    await model.generate({ messages, reasoning: { effort }, maxTokens: 128, providerOptions: { apiMode: "chat" } });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ reasoning_effort: expected, max_completion_tokens: 128, preserve_thinking: true });
    expect(body.max_tokens).toBeUndefined();
    if (effort === "none") expect(body.enable_thinking).toBe(false);
  });

  it("preserves assistant thinking across Chat tool continuations", async () => {
    const { fetch, model } = setup();
    await model.generate({ messages: [
      ...messages,
      { role: "assistant", parts: [
        { type: "provider-data", provider: "qwen", data: { type: "reasoning_content", reasoningContent: "Need the code." } },
        { type: "tool-call", toolCall: { id: "call-1", name: "lookup", input: {} } }
      ] },
      { role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "call-1", toolName: "lookup", output: "731", isError: false } }] }
    ], reasoning: { effort: "low" }, providerOptions: { apiMode: "chat" } });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.messages[1]).toMatchObject({ reasoning_content: "Need the code.", tool_calls: [{ id: "call-1" }] });
    expect(body.messages[2]).toMatchObject({ tool_call_id: "call-1" });
  });

  it.each(["chat", "responses"] as const)("streams media through %s without dropping reasoning or usage", async (apiMode) => {
    const chunks = apiMode === "chat" ? [
      { choices: [{ delta: { reasoning_content: "Inspecting." } }] },
      { choices: [{ delta: { content: "A dog." }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }
    ] : [
      { type: "response.output_text.delta", delta: "A dog." },
      { type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }
    ];
    const fetch = vi.fn(async (_url: unknown, _options: RequestInit) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"));
    const model = createQwen({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })("qwen3.8-omni-flash");
    const events = [];
    for await (const event of await model.stream({ messages: [{ role: "user", parts: [{ type: "file", mediaType: "video/mp4", data: "AA==" }] }], providerOptions: { apiMode } })) events.push(event);
    expect(events.filter(e => e.type === "text-delta").map(e => e.textDelta).join("")).toBe("A dog.");
    expect(events.find(e => e.type === "finish")?.usage?.totalTokens).toBe(14);
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    const content = apiMode === "chat" ? body.messages[0].content : body.input[0].content;
    expect(JSON.stringify(content)).toContain("data:video/mp4;base64,AA==");
    if (apiMode === "chat") expect(events.some(e => e.type === "provider-data")).toBe(true);
  });

  it("allows web search with audio on Responses in auto mode", async () => {
    const { fetch, model } = setup();
    await model.generate({ messages: [{ role: "user", parts: [{ type: "audio", data: "https://example.com/a.wav", mediaType: "audio/wav" }] }], tools: { search: qwenWebSearchTool() } });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.tools[0].type).toBe("web_search");
    expect(body.input[0].content[0].type).toBe("input_audio");
  });

  const invalid: Array<[string, Partial<ModelGenerateInput>]> = [
    ["audio output", { providerOptions: { modalities: ["text", "audio"] } }],
    ["audio configuration", { providerOptions: { audio: { voice: "Tina" } } }],
    ["native JSON", { providerOptions: { response_format: { type: "json_schema" } } }],
    ["hosted code", { tools: { code: qwenCodeInterpreterTool() } }],
    ["conflicting thinking controls", { reasoning: { effort: "low", budgetTokens: 100 } }],
    ["disabled thinking with effort", { reasoning: { effort: "low" }, providerOptions: { enable_thinking: false } }],
    ["non-user audio", { messages: [{ role: "assistant", parts: [{ type: "audio", data: "AA==", mediaType: "audio/wav" }] }] }],
    ["document", { messages: [{ role: "user", parts: [{ type: "file", data: "https://example.com/a.pdf", mediaType: "application/pdf" }] }] }],
    ["invalid multichannel", { messages: [{ role: "user", parts: [{ type: "audio", data: "AA==", mediaType: "audio/wav", providerMetadata: { use_multichannel: "yes" } }] }] }]
  ];
  it.each(invalid)("rejects %s before either transport", async (_, extra) => {
    const { fetch, model } = setup();
    await expect(model.generate({ messages, ...extra })).rejects.toThrow();
    await expect(model.stream({ messages, ...extra })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects Token Plan credentials routing", async () => {
    const model = createQwen({ apiKey: "test", baseURL: QWEN_TOKEN_PLAN_BASE_URL })("qwen3.8-omni-flash");
    await expect(model.generate({ messages })).rejects.toThrow("standard Model Studio");
  });

  it("supports prompted structured output without sending native response_format", async () => {
    const { model, fetch } = setup();
    const result = await generateObject({ model, prompt: "Return ok true", schema: z.object({ ok: z.boolean() }), mode: "prompted", providerOptions: { apiMode: "chat" } });
    expect(result.object).toEqual({ ok: true });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).response_format).toBeUndefined();
  });
});
it("cancels realtime inference without closing the session", async () => {
  const sent: unknown[] = []; let end!: (value: undefined) => void;
  const provider = createQwen({ apiKey: "test", realtimeConnectionFactory: async () => ({
    sendJson: async value => { sent.push(value); },
    recvJson: () => new Promise(resolve => { end = resolve; }), close: async () => { end?.(undefined); }
  }) });
  const session = await provider.realtimeModel!("qwen3.5-omni-flash-realtime").connect();
  await session.interrupt!();
  expect(sent).toContainEqual({ type: "response.cancel" });
  await session.sendText("continue");
  expect(sent.some(value => (value as { type: string }).type === "conversation.item.create")).toBe(true);
  await session.close();
});
