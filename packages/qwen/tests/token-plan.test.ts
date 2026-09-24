import { describe, expect, it, vi } from "vitest";
import { generateObject, tool } from "@zhivex-ai/core";
import { z } from "zod";
import { createQwen, QWEN_TOKEN_PLAN_BASE_URL, qwenWebSearchTool } from "../src/index.js";

const currentURL = "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1";
const legacyURL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];
const chat = { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };

describe("Qwen Token Plan routing", () => {
  it("exports the current Personal and Team endpoint", () => {
    expect(QWEN_TOKEN_PLAN_BASE_URL).toBe(currentURL);
  });

  for (const baseURL of [currentURL, legacyURL]) {
    it.each(["qwen3.8-omni-flash", "qwen3.8-max-0902"])(`does not infer plan entitlement for %s on ${baseURL}`, async (modelId) => {
      const fetch = vi.fn();
      const model = createQwen({ apiKey: "sk-sp-test", baseURL, fetch })(modelId);
      await expect(model.generate({ messages })).rejects.toThrow("standard Model Studio");
      await expect(model.stream({ messages })).rejects.toThrow("standard Model Studio");
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each(["qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max-preview"])(
      `routes %s Chat and Responses through ${baseURL}`,
      async (modelId) => {
        const fetch = vi.fn().mockResolvedValueOnce(Response.json(chat)).mockResolvedValueOnce(Response.json({
          id: "resp-plan", status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
        }));
        const model = createQwen({ apiKey: "sk-sp-test", baseURL, fetch })(modelId);
        expect((await model.generate({ messages, providerOptions: { apiMode: "chat" } })).text).toBe("ok");
        expect((await model.generate({ messages, tools: { search: qwenWebSearchTool() } })).text).toBe("ok");
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${baseURL}/chat/completions`, `${baseURL}/responses`]);
        for (const [, init] of fetch.mock.calls) {
          expect(init.headers.authorization).toBe("Bearer sk-sp-test");
          expect(JSON.parse(init.body).model).toBe(modelId);
        }
        expect(JSON.parse(fetch.mock.calls[1]![1].body).tools).toEqual([expect.objectContaining({ type: "web_search" })]);
      }
    );

    it.each(["qwen3.8-max", "qwen3.8-flash"])(`streams %s on ${baseURL}`, async (modelId) => {
      const fetch = vi.fn().mockResolvedValue(new Response([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ].join(""), { headers: { "content-type": "text/event-stream" } }));
      const model = createQwen({ apiKey: "sk-sp-test", baseURL, fetch })(modelId);
      const events = [];
      for await (const event of await model.stream({ messages, providerOptions: { apiMode: "chat" } })) events.push(event);
      expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", textDelta: "ok" }));
      expect(fetch.mock.calls[0]![0]).toBe(`${baseURL}/chat/completions`);
    });

    it("preserves provider quota errors", async () => {
      const fetch = vi.fn().mockResolvedValue(Response.json({ error: { message: "quota exceeded" } }, { status: 429 }));
      const model = createQwen({ apiKey: "sk-sp-test", baseURL, fetch })("qwen3.8-max");
      await expect(model.generate({ messages, maxRetries: 0 })).rejects.toMatchObject({ status: 429 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(["qwen3.8-max", "qwen3.8-flash"])(`keeps %s structured output on plan Chat at ${baseURL}`, async (modelId) => {
      const fetch = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }));
      const model = createQwen({ apiKey: "sk-sp-test", baseURL, fetch })(modelId);
      const result = await generateObject({ model, prompt: "Return JSON", schema: z.object({ ok: z.boolean() }), mode: "native", reasoning: { effort: "none" } });
      expect(result.object).toEqual({ ok: true });
      expect(fetch.mock.calls[0]![0]).toBe(`${baseURL}/chat/completions`);
      const body = JSON.parse(fetch.mock.calls[0]![1].body);
      expect(body.response_format.type).toBe(modelId === "qwen3.8-flash" ? "json_schema" : "json_object");
      expect(body.enable_thinking).toBe(false);
    });

    it.each(["qwen3.8-max", "qwen3.8-flash"])(`streams %s hosted tools via Responses on ${baseURL}`, async (modelId) => {
      const fetch = vi.fn().mockResolvedValue(new Response([
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp-plan","status":"completed","output":[]}}\n\n'
      ].join(""), { headers: { "content-type": "text/event-stream" } }));
      const model = createQwen({ apiKey: "sk-sp-test", baseURL, fetch })(modelId);
      const events = [];
      for await (const event of await model.stream({ messages, tools: { search: qwenWebSearchTool() } })) events.push(event);
      expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", textDelta: "ok" }));
      expect(fetch.mock.calls[0]![0]).toBe(`${baseURL}/responses`);
      expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ stream: true, model: modelId, tools: [{ type: "web_search" }] });
    });

    it("preserves callable tool and thinking history across plan turns", async () => {
      const fetch = vi.fn().mockResolvedValueOnce(Response.json({ choices: [{ message: {
        role: "assistant", reasoning_content: "Need weather", content: null,
        tool_calls: [{ id: "call-plan", type: "function", function: { name: "weather", arguments: '{"city":"Paris"}' } }]
      }, finish_reason: "tool_calls" }] })).mockResolvedValueOnce(Response.json(chat));
      const model = createQwen({ apiKey: "sk-sp-test", baseURL, fetch })("qwen3.8-max");
      const tools = { weather: tool({ name: "weather", schema: z.object({ city: z.string() }), execute: () => "sunny" }) };
      const first = await model.generate({ messages, tools, providerOptions: { apiMode: "chat" } });
      expect(first.finishReason).toBe("tool-calls");
      const result = await model.generate({ messages: [...messages, ...first.messages, {
        role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: "call-plan", toolName: "weather", isError: false, output: "sunny" } }]
      }], tools, providerOptions: { apiMode: "chat" } });
      expect(result.text).toBe("ok");
      const body = JSON.parse(fetch.mock.calls[1]![1].body);
      expect(body.messages[1]).toMatchObject({ reasoning_content: "Need weather", tool_calls: [{ id: "call-plan" }] });
      expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call-plan" });
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${baseURL}/chat/completions`, `${baseURL}/chat/completions`]);
    });
  }

  it.each([currentURL + "?redirect=paygo", currentURL + "#fragment", currentURL + "/other", currentURL.replace("qwencloudapi.com", "qwencloudapi.com.example.com")])(
    "rejects noncanonical preview endpoint %s before either transport", async (baseURL) => {
      const fetch = vi.fn();
      const model = createQwen({ apiKey: "sk-sp-test", baseURL, fetch })("qwen3.8-max-preview");
      await expect(model.generate({ messages })).rejects.toThrow("is Token Plan only");
      await expect(model.stream({ messages })).rejects.toThrow("is Token Plan only");
      expect(fetch).not.toHaveBeenCalled();
    }
  );
});
