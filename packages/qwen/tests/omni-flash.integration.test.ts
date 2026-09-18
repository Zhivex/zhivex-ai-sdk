import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateObject, generateText, tool, type ModelMessage } from "@zhivex-ai/core";
import { createQwen, qwenWebSearchTool, type QwenRegion } from "../src/index.js";

const enabled = process.env.QWEN_OMNI_INTEGRATION === "1";
const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
if (enabled && !apiKey) throw new Error("QWEN_OMNI_INTEGRATION requires QWEN_API_KEY or DASHSCOPE_API_KEY.");
const model = () => createQwen({ apiKey, baseURL: process.env.QWEN_BASE_URL,
  workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION as QwenRegion | undefined })("qwen3.8-omni-flash");
const limits = { timeoutMs: 90_000, maxRetries: 0 };
const text = (prompt: string): ModelMessage[] => [{ role: "user", parts: [{ type: "text", text: prompt }] }];
// Public samples from the official Qwen Omni guide; no private media is uploaded.
const audio = "https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3";
const video = "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241115/cqqkru/1.mp4";
const image = "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog_and_girl.jpeg";

describe.skipIf(!enabled)("Qwen3.8-Omni-Flash live", () => {
  for (const apiMode of ["chat", "responses"] as const) {
    it(`${apiMode}: non-streaming text and usage`, async () => {
      const result = await generateText({ model: model(), prompt: "Reply only OMNI_OK.", reasoning: { effort: "none" }, providerOptions: { apiMode }, ...limits });
      expect(result.text).toContain("OMNI_OK");
      expect(result.usage?.inputTokens).toBeGreaterThan(0);
      expect(result.usage?.outputTokens).toBeGreaterThan(0);
    }, 100_000);

    it(`${apiMode}: streaming reasoning, text and final usage`, async () => {
      const events = [];
      for await (const event of await model().stream({ messages: text("Compute 17*19. Reply with the number."), reasoning: { effort: "low" }, providerOptions: { apiMode }, ...limits })) events.push(event);
      expect(events.filter(e => e.type === "text-delta").map(e => e.textDelta).join("")).toContain("323");
      expect(events.find(e => e.type === "finish")?.usage?.outputTokens).toBeGreaterThan(0);
      expect(events.some(e => e.type === "provider-data")).toBe(true);
    }, 100_000);

    it(`${apiMode}: image plus audio understanding`, async () => {
      const result = await model().generate({ messages: [{ role: "user", parts: [
        { type: "image", image }, { type: "audio", data: audio, mediaType: "audio/mpeg" },
        { type: "text", text: "In English, briefly describe the image and transcribe the audio." }
      ] }], reasoning: { effort: "none" }, providerOptions: { apiMode }, ...limits });
      expect(result.text.toLowerCase()).toMatch(/dog|labrador|retriever/);
      expect(result.text.toLowerCase()).toMatch(/alibaba/);
      expect(result.usage?.inputTokens).toBeGreaterThan(0);
    }, 100_000);

    it(`${apiMode}: video understanding`, async () => {
      const result = await model().generate({ messages: [{ role: "user", parts: [
        { type: "file", data: video, mediaType: "video/mp4" },
        { type: "text", text: "Briefly describe the visible actions in this video in English." }
      ] }], reasoning: { effort: "none" }, providerOptions: { apiMode }, ...limits });
      expect(result.text.length).toBeGreaterThan(20);
      expect(result.usage?.inputTokens).toBeGreaterThan(0);
    }, 100_000);

    it(`${apiMode}: callable tool execution and continuation`, async () => {
      let calls = 0;
      const result = await generateText({ model: model(), prompt: "Call lookup_code for the secret code, then reply with that exact code. Do not guess it.",
        tools: { lookup_code: tool({ name: "lookup_code", description: "Return the secret code", schema: z.object({}), execute: async () => { calls++; return { code: "OMNI_SECRET_731" }; } }) },
        maxSteps: 3, reasoning: { effort: "none" }, providerOptions: { apiMode }, ...limits });
      expect(calls).toBe(1);
      expect(result.text).toContain("OMNI_SECRET_731");
    }, 100_000);
  }

  it("prompted structured output with local schema validation", async () => {
    const result = await generateObject({ model: model(), prompt: "Return name Omni and count 3.", schema: z.object({ name: z.literal("Omni"), count: z.literal(3) }), mode: "prompted", reasoning: { effort: "none" }, ...limits });
    expect(result.object).toEqual({ name: "Omni", count: 3 });
  }, 100_000);

  it("Responses hosted web search", async () => {
    const result = await model().generate({ messages: text("Search the web for the official Qwen website and return its URL."), tools: { search: qwenWebSearchTool() }, toolChoice: "required", reasoning: { effort: "none" }, providerOptions: { apiMode: "responses" }, ...limits });
    expect((result.rawResponse as { status?: string }).status).toBe("completed");
    // Required hosted-tool selection can complete with only the search item.
    // Verify the actual tool result, then request a final answer in a new turn.
    const output = (result.rawResponse as { output?: Array<{ type: string; status?: string; action?: { sources?: Array<{ url: string }> } }> })?.output;
    const search = output?.find(item => item.type === "web_search_call");
    expect(search?.status).toBe("completed");
    expect(search?.action?.sources?.some(source => /qwen\.(ai|cloud)/.test(source.url))).toBe(true);
    const final = await model().generate({ messages: [...result.messages, ...text("Using those search results, return the official Qwen website URL.")],
      reasoning: { effort: "none" }, providerOptions: { apiMode: "responses" }, ...limits });
    expect(final.text).toMatch(/qwen\.(ai|cloud)/);
  }, 190_000);
});
