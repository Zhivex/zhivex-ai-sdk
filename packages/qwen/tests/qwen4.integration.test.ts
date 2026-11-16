import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateText, generateObject, streamText, tool, type ModelMessage } from "@zhivex-ai/core";
import { createQwen, qwenWebSearchTool, type QwenRegion } from "../src/index.js";

const enabled = process.env.QWEN4_INTEGRATION === "1";
const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
if (enabled && !apiKey) throw new Error("QWEN4_INTEGRATION requires QWEN_API_KEY or DASHSCOPE_API_KEY.");
const model = () => createQwen({ apiKey, baseURL: process.env.QWEN_BASE_URL,
  workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION as QwenRegion | undefined })("qwen4-max");
const limits = { maxTokens: 2048, timeoutMs: 90_000, maxRetries: 0 };
const text = (text: string): ModelMessage[] => [{ role: "user", parts: [{ type: "text", text }] }];
const image = "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog_and_girl.jpeg";
const video = "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241115/cqqkru/1.mp4";
const hasCipher = (messages: ModelMessage[]) => messages.some(m => m.parts.some(p => p.type === "provider-data" && p.provider === "qwen" && p.data && typeof p.data === "object" && !Array.isArray(p.data) && (p.data.encryptedContent || p.data.encrypted_content)));

describe.skipIf(!enabled)("Qwen4-Max live", () => {
  for (const apiMode of ["chat", "responses"] as const) {
    it(`${apiMode}: text, usage and disabled reasoning`, async () => {
      const r = await generateText({ model: model(), prompt: "Reply only QWEN4_OK", reasoning: { effort: "none" }, providerOptions: { apiMode }, ...limits });
      expect(r.text).toContain("QWEN4_OK");
      expect(r.usage?.inputTokens).toBeGreaterThan(0);
    }, 100_000);
    it(`${apiMode}: summary encryption and stateless continuation`, async () => {
      const messages = text("Compute 17 times 23. Answer with the number only.");
      const options = { apiMode, thinking_display: "summarized" as const, store: false };
      const r = await model().generate({ messages, reasoning: { effort: "low" }, providerOptions: options, ...limits });
      expect(r.text).toContain("391");
      expect(hasCipher(r.messages)).toBe(true);
      const next = await model().generate({ messages: [...messages, ...r.messages, ...text("Add 9 to that result. Answer with the number only.")], reasoning: { effort: "low" }, providerOptions: options, ...limits });
      expect(next.text).toContain("400");
    }, 190_000);
    it(`${apiMode}: streamed ciphertext survives the shared messages contract`, async () => {
      const messages = text("Compute 19 times 17. Answer with the number only.");
      const options = { apiMode, thinking_display: "summarized" as const, store: false };
      const r = streamText({ model: model(), messages, reasoning: { effort: "low" }, providerOptions: options, ...limits });
      for await (const _ of r.eventStream) { /* consume every frame, including ciphertext-only frames */ }
      const collected = await r.collect();
      expect(collected.text).toContain("323");
      const history = collected.messages;
      expect(hasCipher(history)).toBe(true);
      const next = await model().generate({ messages: [...messages, ...history, ...text("Add 7. Answer with the number only.")], reasoning: { effort: "low" }, providerOptions: options, ...limits });
      expect(next.text).toContain("330");
    }, 190_000);
    it(`${apiMode}: callable tools with encrypted reasoning and continuation`, async () => {
      let calls = 0;
      const r = await generateText({ model: model(), prompt: "Use lookup_code to retrieve the code, then report the exact code. Never guess.", tools: {
        lookup_code: tool({ name: "lookup_code", description: "Retrieve a code", schema: z.object({}), execute: async () => { calls++; return { code: "QWEN4_SECRET_731" }; } })
      }, maxSteps: 3, reasoning: { effort: "low" }, providerOptions: { apiMode, thinking_display: "summarized", store: false, parallel_tool_calls: true }, ...limits });
      expect(calls).toBe(1);
      expect(r.text).toContain("QWEN4_SECRET_731");
    }, 190_000);
    it(`${apiMode}: streamed callable tools and continuation`, async () => {
      const called: string[] = [];
      const r = await streamText({ model: model(), prompt: "Call lookup for both IDs alpha and beta before answering. Return both secret codes.", tools: {
        lookup: tool({ name: "lookup", description: "Retrieve the secret code for an ID", schema: z.object({ id: z.enum(["alpha", "beta"]) }), execute: async ({ id }) => { called.push(id); return { code: id === "alpha" ? "ALPHA_731" : "BETA_952" }; } })
      }, maxSteps: 4, reasoning: { effort: "low" }, providerOptions: { apiMode, thinking_display: "summarized", store: false, parallel_tool_calls: true, ...(apiMode === "chat" ? { tool_stream: true } : {}) }, ...limits }).collect();
      expect(new Set(called)).toEqual(new Set(["alpha", "beta"]));
      expect(r.text).toContain("ALPHA_731");
      expect(r.text).toContain("BETA_952");
    }, 190_000);
    it(`${apiMode}: native JSON Schema`, async () => {
      const r = await generateObject({ model: model(), prompt: "Return name Qwen and count 4", schema: z.object({ name: z.literal("Qwen"), count: z.literal(4) }), mode: "native", reasoning: { effort: "none" }, providerOptions: { apiMode }, ...limits });
      expect(r.object).toEqual({ name: "Qwen", count: 4 });
    }, 100_000);
    it(`${apiMode}: image understanding`, async () => {
      const r = await model().generate({ messages: [{ role: "user", parts: [{ type: "image", image }, { type: "text", text: "What animal is visible? Reply briefly in English." }] }], reasoning: { effort: "none" }, providerOptions: { apiMode }, ...limits });
      expect(r.text.toLowerCase()).toMatch(/dog|labrador|retriever/);
    }, 100_000);
    it(`${apiMode}: video understanding`, async () => {
      const r = await model().generate({ messages: [{ role: "user", parts: [{ type: "file", data: video, mediaType: "video/mp4" }, { type: "text", text: "Describe the visible action in English." }] }], reasoning: { effort: "none" }, providerOptions: { apiMode }, ...limits });
      expect(r.text.length).toBeGreaterThan(20);
      expect(r.usage?.inputTokens).toBeGreaterThan(0);
    }, 100_000);
    it(`${apiMode}: explicit prompt cache`, async () => {
      const messages: ModelMessage[] = [{ role: "user", parts: [
        { type: "text", text: "Cache reference: Paris is the capital of France. ".repeat(400), providerMetadata: { prompt_cache_breakpoint: { mode: "explicit" } } },
        { type: "text", text: "What is the capital of France? One word." }
      ] }];
      const options = { apiMode, prompt_cache_options: { mode: "explicit" as const, ttl: "5m" as const }, store: false };
      await model().generate({ messages, reasoning: { effort: "none" }, providerOptions: options, ...limits });
      const r = await model().generate({ messages, reasoning: { effort: "none" }, providerOptions: options, ...limits });
      expect(r.text).toContain("Paris");
      expect(r.usage?.cachedInputTokens).toBeGreaterThan(0);
    }, 190_000);
  }
  it("hosted web search on Responses", async () => {
    const r = await model().generate({ messages: text("Search the web for the official Qwen website."), tools: { search: qwenWebSearchTool() }, toolChoice: "required", reasoning: { effort: "none" }, providerOptions: { apiMode: "responses" }, ...limits });
    const output = (r.rawResponse as { output?: { type: string; status?: string }[] }).output;
    expect(output?.some(item => item.type === "web_search_call" && item.status === "completed")).toBe(true);
  }, 100_000);
});
