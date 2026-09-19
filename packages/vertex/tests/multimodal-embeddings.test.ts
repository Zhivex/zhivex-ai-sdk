import { describe, it, expect, vi } from "vitest";
import { createVertex } from "../src/index.js";
const vector = (n = 1408) => Array(n).fill(0.5);
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, provider: createVertex({ projectId: "p", location: "us-central1", accessToken: "test", fetch }) };
};
describe("Vertex legacy multimodal embeddings", () => {
  it("maps combined modalities while retaining all video segments", async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json({ predictions: [{ textEmbedding: vector(), imageEmbedding: vector(), videoEmbeddings: [
      { startOffsetSec: 0, endOffsetSec: 4, embedding: vector() }, { startOffsetSec: 4, endOffsetSec: 8, embedding: vector() }
    ] }] }));
    const result = await provider.multimodalEmbeddings.embed({ text: "road", image: { data: new Uint8Array([1, 2]), mediaType: "image/png" },
      video: { uri: "gs://sample/road.mp4", mediaType: "video/mp4" }, videoSegmentConfig: { startOffsetSec: 0, endOffsetSec: 8, intervalSec: 4 } });
    expect(String(fetch.mock.calls[0][0])).toContain("/locations/us-central1/publishers/google/models/multimodalembedding@001:predict");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ instances: [{ text: "road", image: { bytesBase64Encoded: "AQI=", mimeType: "image/png" },
      video: { gcsUri: "gs://sample/road.mp4", videoSegmentConfig: { startOffsetSec: 0, endOffsetSec: 8, intervalSec: 4 } } }] });
    expect(result.imageEmbedding).toHaveLength(1408);
    expect(result.textEmbedding).toHaveLength(1408);
    expect(result.videoEmbeddings?.map(v => [v.startOffsetSec, v.endOffsetSec, v.embedding.length])).toEqual([[0, 4, 1408], [4, 8, 1408]]);
  });
  it("normalizes text and image values in order with one instance per request", async () => {
    const { provider, fetch } = setup();
    fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.instances).toHaveLength(1);
      return Response.json({ predictions: [{ [body.instances[0].text ? "textEmbedding" : "imageEmbedding"]: vector(256) }] });
    });
    const model = provider.embeddingModel("publishers/google/models/multimodalembedding@001");
    expect(model.capabilities.vision).toBe(true);
    const result = await model.embed({ values: ["hello", { uri: "gs://sample/image.png", mediaType: "image/png" }], providerOptions: { outputDimensionality: 256 } });
    expect(result.embeddings.map(v => v.length)).toEqual([256, 256]);
    expect(result.usage).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid configuration and normalized video before any request", async () => {
    const { provider, fetch } = setup();
    await expect(provider.multimodalEmbeddings.embed({})).rejects.toThrow("require text");
    await expect(provider.multimodalEmbeddings.embed({ text: "x", outputDimensionality: 129 as 128 })).rejects.toThrow("dimensions");
    await expect(provider.multimodalEmbeddings.embed({ video: { uri: "gs://s/v.mp4", mediaType: "video/mp4" }, videoSegmentConfig: { intervalSec: 3 } })).rejects.toThrow("at least 4");
    await expect(provider.multimodalEmbeddings.embed({ image: { uri: "https://s/i.png", mediaType: "image/png" } })).rejects.toThrow("gs://");
    await expect(provider.embeddingModel("multimodalembedding@001").embed({ values: ["valid", { uri: "gs://s/v.mp4", mediaType: "video/mp4" }] })).rejects.toThrow("retain all video segments");
    await expect(provider.multimodalEmbeddings.embed({ text: "road", video: { uri: "gs://s/v.mp4", mediaType: "video/mp4" }, outputDimensionality: 128 })).rejects.toThrow("Requests containing video");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    {}, { predictions: [] }, { predictions: [{ textEmbedding: [1] }] },
    { predictions: [{ textEmbedding: vector(128).map((v, i) => i ? v : "bad") }] }
  ])("rejects missing and malformed vectors", async body => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(Response.json(body));
    await expect(provider.multimodalEmbeddings.embed({ text: "x", outputDimensionality: 128 })).rejects.toThrow();
  });
  it("rejects malformed segment timestamps and preserves provider HTTP errors", async () => {
    const { provider, fetch } = setup();
    const input = { video: { uri: "gs://s/v.mp4", mediaType: "video/mp4" } };
    fetch.mockResolvedValueOnce(Response.json({ predictions: [{ videoEmbeddings: [{ startOffsetSec: 4, endOffsetSec: 1, embedding: vector() }] }] }));
    await expect(provider.multimodalEmbeddings.embed(input)).rejects.toThrow("offsets");
    fetch.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(provider.multimodalEmbeddings.embed({ ...input, maxRetries: 0 })).rejects.toMatchObject({ status: 403 });
  });
});
