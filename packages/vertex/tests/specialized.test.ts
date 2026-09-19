import { it, describe, expect, vi } from "vitest";
import { createVertex } from "../src/index.js";
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, provider: createVertex({ projectId: "p", location: "us-central1", accessToken: "test", fetch }) };
};
describe("Vertex Mistral specialized APIs", () => {
  it("extracts a single image through the DeepSeek OpenMaaS chat contract", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ choices: [{ message: { content: "Invoice 42" }, finish_reason: "stop" }] }));
    const result = await provider.ocr.process({ modelId: "deepseek-ai/deepseek-ocr-maas", document: { data: new Uint8Array([1, 2]), mediaType: "image/png" }, prompt: "Read the invoice" });
    expect(result.pages).toEqual([{ index: 0, markdown: "Invoice 42" }]);
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "Read the invoice" }, { type: "image_url", image_url: { url: "data:image/png;base64,AQI=" } }]);
    expect(String(fetch.mock.calls[0][0])).toContain("endpoints/openapi/chat/completions");
    expect(body.model).toBe("deepseek-ai/deepseek-ocr-maas");
  });
  it("does not present incomplete DeepSeek extraction as a complete document", async () => {
    const { provider, fetch } = setup();
    const input = { modelId: "deepseek-ai/deepseek-ocr-maas", document: { uri: "https://example.com/a.png", mediaType: "image/png" } };
    await expect(provider.ocr.process({ ...input, pages: [0] })).rejects.toThrow("page selection");
    await expect(provider.ocr.process({ ...input, document: { ...input.document, mediaType: "application/pdf" } })).rejects.toThrow("one image");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(Response.json({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }));
    await expect(provider.ocr.process(input)).rejects.toThrow("did not complete extraction");
  });
  it("rejects incompatible wire overrides before fetching", async () => {
    const { provider, fetch } = setup();
    expect(() => provider.fim.generate({ modelId: "codestral-2", prompt: "code", providerOptions: { messages: [] } })).toThrow("dedicated input contract");
    expect(() => provider.fim.generate({ modelId: "codestral-2", prompt: "code", providerOptions: { suffix: "hidden" } })).toThrow("dedicated input contract");
    expect(() => provider.fim.generate({ modelId: "codestral-2", prompt: "code", temperature: NaN })).toThrow("finite");
    expect(() => provider.fim.generate({ modelId: "codestral-2", prompt: "code", topP: 2 })).toThrow("at most one");
    await expect(provider.ocr.process({ modelId: "mistral-ocr-2505", document: { uri: "https://example.com/a.pdf", mediaType: "application/pdf" }, providerOptions: { pages: [-1] } })).rejects.toThrow("dedicated input contract");
    await expect(provider.ocr.process({ modelId: "mistral-ocr-2505", document: { uri: "", mediaType: "application/pdf" } })).rejects.toThrow("HTTP(S)");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([[null], [{ index: 0, markdown: "a" }, { index: 0, markdown: "b" }]])("rejects malformed OCR pages: %j", async (...pages) => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ pages }));
    await expect(provider.ocr.process({ modelId: "mistral-ocr-2505", document: { uri: "https://example.com/a.pdf", mediaType: "application/pdf" } })).rejects.toThrow("invalid or duplicate page");
  });
  it("extracts PDF pages and keeps layout metadata", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ pages: [{ index: 0, markdown: "# Title", images: [], dimensions: { width: 600 } }], usage_info: { pages_processed: 1 } }));
    const result = await provider.ocr.process({ modelId: "mistralai/mistral-ocr-2505", document: { data: new Uint8Array([1, 2]), mediaType: "application/pdf" }, pages: [0], includeImages: false });
    expect(result.text).toBe("# Title");
    expect(result.pages[0].providerMetadata?.dimensions).toEqual({ width: 600 });
    expect(String(fetch.mock.calls[0][0])).toContain("publishers/mistralai/models/mistral-ocr-2505:rawPredict");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ model: "mistral-ocr-2505", document: { type: "document_url", document_url: "data:application/pdf;base64,AQI=" }, pages: [0], include_image_base64: false });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer test");
  });
  it("rejects invalid documents and page indices before fetching", async () => {
    const { provider, fetch } = setup();
    await expect(provider.ocr.process({ modelId: "mistral-ocr-2505", document: { uri: "https://example.com/a.pdf", mediaType: "application/pdf" }, pages: [-1] })).rejects.toThrow("nonnegative");
    await expect(provider.ocr.process({ modelId: "mistral-ocr-2505", document: { uri: "gs://bucket/a.pdf", mediaType: "application/pdf" } })).rejects.toThrow("HTTP(S)");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("completes a prefix and suffix without sending chat messages", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ choices: [{ message: { content: "return 1" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2 } }));
    const result = await provider.fim.generate({ modelId: "codestral-2", prompt: "def f():", suffix: "\n", maxTokens: 10, temperature: 0 });
    expect(result.text).toBe("return 1");
    expect(result.usage?.outputTokens).toBe(2);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ model: "codestral-2", prompt: "def f():", suffix: "\n", max_tokens: 10, temperature: 0, stream: false });
  });
  it("streams FIM and uses streamRawPredict", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(new Response('data: {"choices":[{"index":0,"delta":{"content":"code"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }));
    const events = [];
    for await (const event of await provider.fim.stream({ modelId: "codestral-2", prompt: "code" })) events.push(event);
    expect(events[0]).toEqual({ type: "text-delta", textDelta: "code" });
    expect(String(fetch.mock.calls[0][0])).toContain(":streamRawPredict");
  });
  it("rejects API keys on partner APIs", async () => {
    const provider = createVertex({ apiKey: "test" });
    await expect(provider.ocr.process({ modelId: "mistral-ocr-2505", document: { uri: "https://example.com/a.pdf", mediaType: "application/pdf" } })).rejects.toThrow("bearer");
    expect(() => provider.fim.generate({ modelId: "codestral-2", prompt: "code" })).toThrow("bearer");
  });
});
