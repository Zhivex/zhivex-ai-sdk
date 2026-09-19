import { describe, it, expect, vi } from "vitest";
import { embedMany } from "@zhivex-ai/sdk";
import { createVertex } from "../src/index.js";
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, provider: createVertex({ projectId: "p", location: "us-central1", accessToken: "test", fetch }) };
};
describe("Vertex embedding configuration", () => {
  it.each(["gemini-embedding-2", "text-embedding-005"])("rejects a response that ignores requested dimensions for %s", async (modelId) => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json(modelId === "gemini-embedding-2"
      ? { embedding: { values: [1, 2, 3] } }
      : { predictions: [{ embeddings: { values: [1, 2, 3] } }] }));
    await expect(provider.embeddingModel(modelId).embed({ values: ["a"], providerOptions: { outputDimensionality: 2 } })).rejects.toThrow(/dimensions/);
  });
  it.each(["gemini-embedding-2", "gemini-embedding-001"])("rejects dimensions that change across split requests for %s", async (modelId) => {
    const { provider, fetch } = setup();
    const response = (values: number[]) => Response.json(modelId === "gemini-embedding-2"
      ? { embedding: { values } } : { predictions: [{ embeddings: { values } }] });
    fetch.mockResolvedValueOnce(response([1, 2])).mockResolvedValueOnce(response([1, 2, 3]));
    await expect(provider.embeddingModel(modelId).embed({ values: ["a", "b"] })).rejects.toThrow(/dimensions/);
  });
  it("rejects inconsistent E5 dimensions even when response indices are reordered", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ data: [{ index: 1, embedding: [1, 2] }, { index: 0, embedding: [1, 2, 3] }] }));
    await expect(provider.embeddingModel("intfloat/multilingual-e5-small-maas").embed({ values: ["a", "b"] })).rejects.toThrow(/dimensions/);
  });
  it("rejects inconsistent dimensions within a Google prediction batch", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ predictions: [{ embeddings: { values: [1, 2] } }, { embeddings: { values: [1] } }] }));
    await expect(provider.embeddingModel("text-embedding-005").embed({ values: ["a", "b"] })).rejects.toThrow(/dimensions/);
  });
  it("advertises media input only for multimodal embedding models", () => {
    const { provider } = setup();
    expect(provider.embeddingModel("gemini-embedding-2").capabilities).toMatchObject({ embeddings: true, vision: true, files: true, audioInput: true, audioOutput: false });
    for (const id of ["gemini-embedding-001", "text-embedding-005", "intfloat/multilingual-e5-small-maas"]) expect(provider.embeddingModel(id).capabilities).toMatchObject({ embeddings: true, vision: false, files: false, audioInput: false });
  });
  it("routes E5 to OpenMaaS and restores indexed input order", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 7 } }));
    const result = await embedMany({ model: provider.embeddingModel("publishers/intfloat/models/multilingual-e5-small-maas"), value: ["query: a", "passage: b"] });
    expect(String(fetch.mock.calls[0][0])).toContain("/projects/p/locations/us-central1/endpoints/openapi/embeddings");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ model: "intfloat/multilingual-e5-small-maas", input: ["query: a", "passage: b"], encoding_format: "float" });
    expect(result.embeddings).toEqual([[1, 2], [3, 4]]);
    expect(result.usage?.inputTokens).toBe(7);
  });
  it("rejects E5 credentials, unsupported input and duplicate response indices", async () => {
    const { provider, fetch } = setup();
    expect(() => createVertex({ apiKey: "test" }).embeddingModel("intfloat/multilingual-e5-small-maas")).toThrow("bearer");
    const model = provider.embeddingModel("intfloat/multilingual-e5-large-instruct-maas");
    await expect(model.embed({ values: ["a"], providerOptions: { taskType: "RETRIEVAL_QUERY" } })).rejects.toThrow("Google embedding controls");
    await expect(model.embed({ values: [{ uri: "gs://b/image", mediaType: "image/png" }] })).rejects.toThrow("text values");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(Response.json({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }));
    await expect(model.embed({ values: ["a", "b"] })).rejects.toThrow("duplicate embedding indices");
  });
  it("maps text task options and splits embedding-001 requests", async () => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(async () => Response.json({ predictions: [{ embeddings: { values: [1, 2], statistics: { token_count: 2 } } }] }));
    const result = await embedMany({ model: provider.embeddingModel("gemini-embedding-001"), value: ["a", "b"], providerOptions: { taskType: "RETRIEVAL_DOCUMENT", title: "title", autoTruncate: false, outputDimensionality: 2 } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ instances: [{ content: "a", task_type: "RETRIEVAL_DOCUMENT", title: "title" }], parameters: { autoTruncate: false, outputDimensionality: 2 } });
    expect(result.usage?.inputTokens).toBe(4);
  });
  it("maps multimodal configuration and inline bytes", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ embedding: { values: [1, 2] }, usageMetadata: { promptTokenCount: 3 } }));
    const result = await embedMany({ model: provider.embeddingModel("gemini-embedding-2"), value: { data: new Uint8Array([1, 2]), mediaType: "application/pdf" }, providerOptions: { outputDimensionality: 2, documentOcr: true } });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ content: { parts: [{ inlineData: { data: "AQI=", mimeType: "application/pdf" } }] }, embedContentConfig: { outputDimensionality: 2, documentOcr: true } });
    expect(result.usage?.inputTokens).toBe(3);
  });
  it("preserves video sampling metadata and audio extraction options", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ embedding: { values: [1] }, usageMetadata: { promptTokenCount: 0 } }));
    const videoMetadata = { startOffset: "0s", endOffset: "1s", fps: 1 };
    const result = await provider.embeddingModel("gemini-embedding-2").embed({
      values: [{ uri: "gs://sample/clip.mp4", mediaType: "video/mp4", providerMetadata: { videoMetadata } }],
      providerOptions: { audioTrackExtraction: false }
    });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
      content: { parts: [{ fileData: { fileUri: "gs://sample/clip.mp4", mimeType: "video/mp4" }, videoMetadata }] },
      embedContentConfig: { audioTrackExtraction: false }
    });
    expect(result.usage).toEqual({ inputTokens: 0 });
  });
  it("rejects incompatible options before fetching", async () => {
    const { provider, fetch } = setup();
    await expect(embedMany({ model: provider.embeddingModel("gemini-embedding-2"), value: "hello", providerOptions: { taskType: "RETRIEVAL_QUERY" } })).rejects.toThrow("text-only");
    await expect(embedMany({ model: provider.embeddingModel("text-embedding-005"), value: "hello", providerOptions: { outputDimensionality: -1 } })).rejects.toThrow("positive integer");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects incomplete responses instead of returning missing vectors", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ predictions: [] }));
    await expect(embedMany({ model: provider.embeddingModel("text-embedding-005"), value: "hello" })).rejects.toThrow("number of embedding vectors");
  });
  it.each(["gemini-embedding-2", "gemini-embedding-001", "intfloat/multilingual-e5-small-maas"])("rejects malformed usage for %s", async (modelId) => {
    const { provider, fetch } = setup();
    for (const tokens of ["3", -1, 1.5, null, Number.MAX_SAFE_INTEGER + 1]) {
      fetch.mockResolvedValue(Response.json(modelId.startsWith("intfloat/")
        ? { data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: tokens } }
        : modelId === "gemini-embedding-2"
          ? { embedding: { values: [1] }, usageMetadata: { promptTokenCount: tokens } }
          : { predictions: [{ embeddings: { values: [1], statistics: { token_count: tokens } } }] }));
      await expect(provider.embeddingModel(modelId).embed({ values: ["hello"] })).rejects.toThrow(/token usage/);
    }
  });
  it("rejects token totals that overflow across split requests", async () => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(async () => Response.json({ predictions: [{ embeddings: { values: [1], statistics: { token_count: Number.MAX_SAFE_INTEGER } } }] }));
    await expect(provider.embeddingModel("gemini-embedding-001").embed({ values: ["a", "b"] })).rejects.toThrow("invalid embedding token usage");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

});
