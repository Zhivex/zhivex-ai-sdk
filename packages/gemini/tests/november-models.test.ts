import { describe, expect, it, vi } from "vitest";
import { createGemini } from "../src/index.js";

const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];

describe("Gemini November models", () => {
  it("rejects explicit Carbon cache creation and Interactions references", async () => {
    const fetcher = vi.fn();
    const provider = createGemini({ apiKey: "test", fetch: fetcher });
    await expect(provider.caches.create({ modelId: "gemini-4-carbon", contents: messages })).rejects.toThrow("implicit caching");
    await expect(provider.caches.create({ modelId: "models/gemini-4-carbon", contents: messages })).rejects.toThrow("implicit caching");
    await expect(provider.interactions.create({ modelId: "gemini-4-carbon", input: "hello", providerOptions: { cached_content: "cachedContents/test" } })).rejects.toThrow("implicit caching");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("maps Carbon thinking and rejects unsupported controls before generate and stream", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }));
    const model = createGemini({ apiKey: "test", fetch: fetcher as typeof fetch })("gemini-4-carbon");
    expect(model.capabilities.reasoningEfforts).toEqual(["low", "medium", "high"]);
    for (const options of [
      { reasoning: { effort: "minimal" as const } },
      { reasoning: { budgetTokens: 512 } },
      { temperature: 0.5 },
      { providerOptions: { cachedContent: "cachedContents/example" } },
      { providerOptions: { generation_config: { top_p: 0.9 } } }
    ]) {
      await expect(model.generate({ messages, ...options })).rejects.toThrow();
      await expect(model.stream({ messages, ...options })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
    await model.generate({ messages, reasoning: { effort: "high" } });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: "high" } } });
  });

  it("sends Omni 1.2 video requests through Interactions and preserves returned media", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ id: "video-1", status: "completed", steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: "AAAA" }] }] }));
    const provider = createGemini({ apiKey: "test", fetch: fetcher as typeof fetch });
    const result = await provider.interactions.create({ modelId: "gemini-omni-1.2-flash", input: "A bird flying", responseFormat: { type: "video", duration: "15s" } });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: "gemini-omni-1.2-flash", response_format: { type: "video", duration: "15s" } });
    expect(result.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ type: "video" })]));
    for (const duration of ["16s", "2s", "3.5s", 15]) {
      await expect(provider.interactions.create({ modelId: "gemini-omni-1.2-flash", input: "video", responseFormat: { type: "video", duration } })).rejects.toThrow("duration");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
