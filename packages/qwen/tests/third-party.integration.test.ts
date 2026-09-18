import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateText, generateObject, streamText, tool } from "@zhivex-ai/core";
import { createQwen, qwenWebSearchTool, qwenCodeInterpreterTool, type QwenRegion } from "../src/index.js";

// Deliberately opt-in: model availability and billing differ by region/plan.
const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
const models = (process.env.QWEN_THIRD_PARTY_MODELS ?? "deepseek-v4.1-flash,deepseek-v4-pro,deepseek-v4-flash,deepseek-v4-pro-0813,deepseek-v4-flash-0731,glm-5.2,glm-5.3,ZHIPU/GLM-5.3,kimi-k3,MiniMax-M2.5").split(",").map(id => id.trim()).filter(Boolean);
const requested = process.env.QWEN_THIRD_PARTY_INTEGRATION === "1";
if (requested && !apiKey) throw new Error("QWEN_THIRD_PARTY_INTEGRATION requires QWEN_API_KEY or DASHSCOPE_API_KEY.");
const enabled = requested && models.length > 0;
const limits = { timeoutMs: 120_000, maxRetries: 0 };

describe.skipIf(!enabled)("QwenCloud third-party live contracts", () => {
  for (const id of models) describe(id, () => {
    const provider = () => createQwen({ apiKey,
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init);
        if (!response.ok) {
          const payload = await response.clone().json().catch(() => ({})) as { code?: string; message?: string; error?: { code?: string; message?: string } };
          const message = String(payload.error?.message ?? payload.message ?? "").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
          console.warn(JSON.stringify({ model: id, continuation: !!JSON.parse(String(init?.body ?? "{}")).previous_response_id, status: response.status, code: payload.error?.code ?? payload.code, message }));
        }
        return response;
      }, baseURL: process.env.QWEN_BASE_URL,
      workspaceId: process.env.QWEN_WORKSPACE_ID, region: process.env.QWEN_REGION as QwenRegion | undefined });
    const capabilities = createQwen({ apiKey: "capability-inspection" })(id).capabilities;
    const extended = process.env.QWEN_THIRD_PARTY_EXTENDED === "1";
    it.skipIf(!extended || !capabilities.structuredOutput)("extended: native JSON object", async () => {
      const result = await generateObject({ model: provider()(id), prompt: "Return an object with ok set to true.",
        schema: z.object({ ok: z.boolean() }), mode: "native",
        ...(id === "glm-5.2" ? { reasoning: { effort: "none" as const } } : {}), ...limits });
      expect(result.object).toEqual({ ok: true });
    }, 150_000);
    for (const apiMode of ["chat", "responses"] as const) {
      it.skipIf(!extended || !capabilities.vision)(`extended: ${apiMode} image input`, async () => {
        const result = await generateText({ model: provider()(id), messages: [{ role: "user", parts: [
          { type: "image", image: "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241022/emyrja/dog_and_girl.jpeg" },
          { type: "text", text: "Name the animal in this picture in English." }
        ] }], reasoning: { effort: "low" }, providerOptions: { apiMode }, ...limits });
        expect(result.text.toLowerCase()).toContain("dog");
      }, 150_000);
    }
    for (const kind of ["web_search", "code_interpreter"] as const) {
      it.skipIf(!extended || !capabilities.agentCapabilities?.hostedWebSearch)(`extended: hosted ${kind}`, async () => {
        const result = await provider()(id).generate({ messages: [{ role: "user", parts: [{ type: "text", text: kind === "web_search" ?
          "Search the web for the official QwenCloud website and return its URL." : "Use Python to calculate 7919 * 7883 and return the result." }] }],
          tools: { builtin: kind === "web_search" ? qwenWebSearchTool() : qwenCodeInterpreterTool() },
          toolChoice: "required", providerOptions: { apiMode: "responses" }, ...limits });
        expect(result.messages.some(message => message.parts.some(part => part.type === "provider-data" &&
          typeof part.data === "object" && part.data !== null && "type" in part.data && part.data.type === `${kind}_call`))).toBe(true);
      }, 150_000);
    }
    for (const apiMode of id === "MiniMax-M2.5" || id === "ZHIPU/GLM-5.3" ? ["chat"] as const : ["chat", "responses"] as const) {
      it(`${apiMode}: text and usage`, async () => {
        const result = await generateText({ model: provider()(id), prompt: "Reply only OK.", providerOptions: { apiMode }, ...limits });
        expect(result.text.trim().length).toBeGreaterThan(0);
        expect(result.usage?.totalTokens).toBeGreaterThan(0);
      }, 150_000);
      it(`${apiMode}: streaming text`, async () => {
        const result = await streamText({ model: provider()(id), prompt: "Reply only OK.", providerOptions: { apiMode }, ...limits }).collect();
        expect(result.text.trim().length).toBeGreaterThan(0);
      }, 150_000);
      it.skipIf(id === "glm-5.2" && apiMode === "responses")(`${apiMode}: executes a callable tool and continues`, async () => {
        let executed = false;
        const result = await generateText({ model: provider()(id), prompt: "Call lookup to retrieve the secret code, then return it. Do not guess.",
          tools: { lookup: tool({ name: "lookup", description: "Retrieve the secret code", schema: z.object({}), execute: () => { executed = true; return { code: "73129" }; } }) },
          maxSteps: 3, providerOptions: { apiMode }, ...limits });
        expect(executed).toBe(true); expect(result.text).toContain("73129");
      }, 400_000);
    }
  });
});
