import { describe, expect, it, vi } from "vitest";
import { createQwen } from "../src/index.js";

describe("QwenCloud embedding contracts", () => {
  it("passes dimensions and restores input order", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [
      { index: 1, embedding: Array(256).fill(0.2) }, { index: 0, embedding: Array(256).fill(0.1) }
    ] }));
    const result = await createQwen({ apiKey: "test", fetch }).embeddingModel!("qwen3.7-text-embedding")
      .embed({ values: ["first", "second"], providerOptions: { dimensions: 256 } });
    expect(result.embeddings.map(v => v[0])).toEqual([0.1, 0.2]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ dimensions: 256 });
  });
  it("maps native sparse retrieval and instructions", async () => {
    let body: any;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ output: { embeddings: [{ text_index: 0, sparse_embedding: [{ index: 3, value: 0.8 }] }] }, usage: { total_tokens: 2 } });
    };
    const model = createQwen({ apiKey: "test", fetch }).textEmbeddingModel("qwen3.7-text-embedding");
    const result = await model.embedNative({ values: ["query"], providerOptions: { text_type: "query", instruct: "Retrieve similar documents", output_type: "sparse" } });
    expect(body).toMatchObject({ input: { texts: ["query"] }, parameters: { output_type: "sparse", text_type: "query" } });
    expect(result.entries[0]?.sparseEmbedding).toEqual([{ index: 3, value: 0.8 }]);
    await expect(model.embed({ values: ["query"], providerOptions: { output_type: "sparse" } })).rejects.toThrow("embedNative");
  });
  it("rejects invalid dimensions, batch sizes and duplicate response indexes", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }));
    const model = createQwen({ apiKey: "test", fetch }).textEmbeddingModel("qwen3.7-text-embedding");
    await expect(model.embed({ values: ["x"], providerOptions: { dimensions: 64 } })).rejects.toThrow("dimensions");
    await expect(model.embed({ values: Array(21).fill("x") })).rejects.toThrow("20");
    expect(fetch).not.toHaveBeenCalled();
    await expect(model.embed({ values: ["a", "b"] })).rejects.toThrow("index");
  });
  it("retries 429 without leaking credentials through redirects", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [1] }] }));
    await createQwen({ apiKey: "test", fetch }).textEmbeddingModel("text-embedding-v4")
      .embed({ values: ["x"], maxRetries: 1, retryBackoffMs: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});

it.each([
  null,
  { data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1] }] },
  { data: [{ index: 0, embedding: [1] }], usage: { total_tokens: "1" } }
])("rejects malformed envelopes, inconsistent vectors and invalid usage", async response => {
  const fetch = vi.fn(async () => Response.json(response));
  const model = createQwen({ apiKey: "test", fetch }).textEmbeddingModel("qwen3.7-text-embedding");
  const values = response?.data?.length === 2 ? ["one", "two"] : ["one"];
  await expect(model.embed({ values })).rejects.toThrow(/Qwen/);
});
it("rejects duplicate sparse dimensions instead of silently double-counting", async () => {
  const fetch = vi.fn(async () => Response.json({ output: { embeddings: [{ text_index: 0, sparse_embedding: [{ index: 1, value: 0.2 }, { index: 1, value: 0.3 }] }] } }));
  await expect(createQwen({ apiKey: "test", fetch }).textEmbeddingModel("qwen3.7-text-embedding").embedNative({ values: ["one"], providerOptions: { output_type: "sparse" } })).rejects.toThrow("sparse");
});
