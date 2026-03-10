import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { embedMany, generateObject, generateText } from "@zhivex-ai/core";
import { createGemini } from "../src/index.js";

describe("gemini adapter", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps generated text into the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "hello from gemini" }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider.languageModel("gemini-2.0-flash"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from gemini");
    expect(result.finishReason).toBe("stop");
  });

  it("supports structured output on top of provider text", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: JSON.stringify({ title: "Tea", servings: 1 }) }] }
          }
        ]
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider.languageModel("gemini-2.0-flash"),
      prompt: "Return JSON",
      schema: z.object({
        title: z.string(),
        servings: z.number()
      }),
      mode: "native"
    });

    expect(result.object.title).toBe("Tea");
    expect(result.objectMode).toBe("native");
  });

  it("embeds content in batches", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        embedding: { values: [0.5, 0.6] }
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        embedding: { values: [0.7, 0.8] }
      })
    );

    const provider = createGemini({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await embedMany({
      model: provider.embeddingModel("text-embedding-004"),
      value: ["hello", "world"]
    });

    expect(result.embeddings).toEqual([
      [0.5, 0.6],
      [0.7, 0.8]
    ]);
  });
});
