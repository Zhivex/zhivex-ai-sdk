import { describe, expect, it } from "vitest";
import { createQwen } from "../src/index.js";
const enabled = process.env.QWEN_CLOUD_TEXT_INTEGRATION === "1";
const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
if (enabled && !apiKey) throw new Error("Qwen Cloud text smoke requires an API key.");
describe.skipIf(!enabled)("Qwen Cloud inexpensive live requests", () => {
  const qwen = () => createQwen({ apiKey, baseURL: process.env.QWEN_BASE_URL });
  it("embeds two tiny strings at 256 dimensions", async () => {
    const result = await qwen().textEmbeddingModel("qwen3.7-text-embedding").embed({ values: ["hello", "hola"], providerOptions: { dimensions: 256 }, timeoutMs: 30000, maxRetries: 0 });
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toHaveLength(256);
  }, 35000);
  it("translates a greeting with MT Lite", async () => {
    const result = await qwen()("qwen-mt-lite").generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Hola" }] }],
      providerOptions: { translation_options: { source_lang: "Spanish", target_lang: "English" } }, timeoutMs: 30000, maxRetries: 0 });
    expect(result.text?.toLowerCase()).toMatch(/hello|hi/);
  }, 35000);
  it("generates short text with the 27B model", async () => {
    const result = await qwen()("qwen3.8-27b").generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Reply OK." }] }],
      maxTokens: 16, reasoning: { effort: "none" }, timeoutMs: 30000, maxRetries: 0 });
    expect(result.text).toBeTruthy();
  }, 35000);
  it("verifies native hybrid embeddings", async () => {
    const result = await qwen().textEmbeddingModel("qwen3.7-text-embedding").embedNative({ values: ["refund policy"], providerOptions: { dimensions: 256, text_type: "query", instruct: "Retrieve relevant documents", output_type: "dense&sparse" }, timeoutMs: 15000, maxRetries: 0 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.embedding).toHaveLength(256);
    expect(result.entries[0]?.sparseEmbedding?.length).toBeGreaterThan(0);
  }, 20000);
  it("verifies short-lived key metadata", async () => {
    const key = await qwen().temporaryKeys.create({ expiresInSeconds: 60, timeoutMs: 15000 });
    // Test only booleans/metadata so assertion diagnostics cannot reveal tokens.
    expect(key.token.startsWith("st-")).toBe(true);
    expect(key.expiresAt > Date.now() / 1000).toBe(true);
    expect(key.expiresAt < Date.now() / 1000 + 120).toBe(true);
  }, 35000);

});
