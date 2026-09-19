import { describe, expect, it, vi } from "vitest";
import { imageInputToDataUrl } from "../src/image-input.js";
import { createQwen } from "../../qwen/src/index.js";
import { createOpenAI } from "../../openai/src/index.js";
import { createAzureOpenAI } from "../../azure-openai/src/index.js";
import { createMeta } from "../../meta/src/index.js";
import { createOpenRouter } from "../../openrouter/src/index.js";
import { createXAI } from "../../xai/src/index.js";
import { createAnthropic } from "../../anthropic/src/index.js";
import { createGemini } from "../../gemini/src/index.js";
import type { ImagePart, LanguageModel, ModelMessage } from "../src/types.js";

const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const dataUrl = `data:image/png;base64,${base64}`;
const cases: Array<[string, (fetch: typeof globalThis.fetch) => LanguageModel, string]> = [];
for (const mode of ["chat", "responses"]) {
  cases.push(
    [`qwen/${mode}`, fetch => createQwen({ apiKey: "test", fetch })("qwen3.8-flash"), mode],
    [`openai/${mode}`, fetch => createOpenAI({ apiKey: "test", fetch })("gpt-4o"), mode],
    [`azure/${mode}`, fetch => createAzureOpenAI({ apiKey: "test", endpoint: "https://example.openai.azure.com", fetch })("gpt-4o"), mode],
    [`meta/${mode}`, fetch => createMeta({ apiKey: "test", fetch })("muse-spark-1.2"), mode],
    [`xai/${mode}`, fetch => createXAI({ apiKey: "test", fetch })("grok-4.6"), mode]
  );
}
cases.push(["openrouter/chat", fetch => createOpenRouter({ apiKey: "test", fetch })("openai/gpt-4o"), "chat"]);

// Inspect the actual serialized request, then stop with a non-retryable HTTP
// response. Both generate and stream must use the same image contract.
describe.each(cases)("image wire contract: %s", (_name, createModel, apiMode) => {
  it.each(["generate", "stream"] as const)("normalizes %s and preserves history/inputs", async method => {
    const fetch = vi.fn(async () => Response.json({ error: { message: "fixture" } }, { status: 400 }));
    const model = createModel(fetch as typeof globalThis.fetch);
    const images = [base64, dataUrl, "https://example.com/image.png", "http://example.com/image.png"];
    const messages: ModelMessage[] = [
      { role: "user", parts: images.map(image => ({ type: "image", image, mediaType: "image/png" })) },
      { role: "assistant", parts: [{ type: "text", text: "Previous answer" }] },
      { role: "user", parts: [{ type: "text", text: "Describe the earlier images" }] }
    ];
    const before = structuredClone(messages);
    const input = { messages, providerOptions: { apiMode }, maxRetries: 0 };
    const invoke = async () => {
      if (method === "generate") await model.generate(input);
      else for await (const _event of await model.stream!(input)) { /* consume */ }
    };
    await expect(invoke()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    const content = apiMode === "responses" ? body.input[0].content : body.messages[0].content;
    expect(content.map((part: any) => typeof part.image_url === "string" ? part.image_url : part.image_url.url))
      .toEqual([dataUrl, dataUrl, images[2], images[3]]);
    expect(messages).toEqual(before);
  });
});

it("uses Anthropic base64 sources and preserves Gemini inlineData", async () => {
  for (const provider of ["anthropic", "gemini"]) {
    const fetch = vi.fn(async () => Response.json({ error: { message: "fixture" } }, { status: 400 }));
    const model = provider === "anthropic"
      ? createAnthropic({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })("claude-3-5-sonnet")
      : createGemini({ apiKey: "test", fetch: fetch as typeof globalThis.fetch })("gemini-2.5-flash");
    await expect(model.generate({ messages: [{ role: "user", parts: [{ type: "image", image: base64, mediaType: "image/png" }] }], maxRetries: 0 })).rejects.toThrow();
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    if (provider === "anthropic") expect(body.messages[0].content[0].source).toEqual({ type: "base64", media_type: "image/png", data: base64 });
    else expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: "image/png", data: base64 });
  }
});

it.each([
  { image: base64 },
  { image: base64, mediaType: "text/plain" },
  { image: base64, mediaType: "image/png;bad" },
  { image: "", mediaType: "image/png" },
  { image: 42, mediaType: "image/png" },
  { image: "data:text/plain;base64,AQI=" },
  { image: "not base64!", mediaType: "image/png" }
])("rejects invalid image input without echoing its payload: %j", input => {
  expect(() => imageInputToDataUrl({ type: "image", ...input } as ImagePart)).toThrow();
});
