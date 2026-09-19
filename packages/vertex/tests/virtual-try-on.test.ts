import { describe, it, expect, vi } from "vitest";
import { createVertex } from "../src/index.js";
const personImage = { data: new Uint8Array([1,2]), mediaType: "image/png" };
const productImage = { uri: "gs://test/garment.jpg", mediaType: "image/jpeg" };
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ predictions: [{ bytesBase64Encoded: "AQI=", mimeType: "image/png" }] }));
  const provider = createVertex({ projectId: "p", location: "us-central1", accessToken: "token", fetch });
  return { fetch, provider, generate: provider.virtualTryOn.generate };
};

describe("Vertex Virtual Try-On", () => {
  it("maps named images, mask, configuration and output options on the native Google route", async () => {
    const { fetch, generate } = setup();
    const result = await generate({ personImage, productImage, productMask: personImage,
      productImageConfig: { dilation: 0.2 }, count: 1, outputMimeType: "image/png", outputStorageUri: "gs://test/output/",
      providerOptions: { baseSteps: 32, outputOptions: { compressionQuality: 80 } } });
    expect(String(fetch.mock.lastCall![0])).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/virtual-try-on-001:predict");
    expect(new Headers(fetch.mock.lastCall![1]!.headers).get("authorization")).toBe("Bearer token");
    const body = JSON.parse(fetch.mock.lastCall![1]!.body as string);
    expect(body.instances).toEqual([{ personImage: { image: { mimeType: "image/png", bytesBase64Encoded: "AQI=" } }, productImages: [{ image: { mimeType: "image/jpeg", gcsUri: "gs://test/garment.jpg" }, maskImage: { mimeType: "image/png", bytesBase64Encoded: "AQI=" }, productImageConfig: { dilation: 0.2 } }] }]);
    expect(body.parameters).toEqual({ sampleCount: 1, storageUri: "gs://test/output/", baseSteps: 32, outputOptions: { compressionQuality: 80, mimeType: "image/png" } });
    expect([...result.images[0].data!]).toEqual([1,2]);
    expect(result.filtered).toEqual([]);
    expect(JSON.stringify(result.rawResponse)).not.toContain("AQI=");
  });
  it("preserves filtering reasons and handles the nested result schema", async () => {
    const { fetch, generate } = setup();
    fetch.mockResolvedValueOnce(Response.json({ predictions: [{ images: [{ mimeType: "image/jpeg", gcsUri: "gs://test/out.jpg" }, { raiFilteredReason: "filtered" }] }] }));
    expect(await generate({ personImage, productImage, count: 2 })).toMatchObject({ images: [{ mediaType: "image/jpeg", uri: "gs://test/out.jpg" }], filtered: [{ reason: "filtered" }] });
  });
  it("rejects ambiguous inputs, invalid media and parameter collisions before fetching", async () => {
    const { fetch, generate } = setup();
    for (const extra of [{ count: 0 }, { count: 5 }, { personImage: { ...personImage, uri: "gs://test/p" } }, { productImage: { ...productImage, uri: "https://example.com/image" } }, { personImage: { ...personImage, mediaType: "image/gif" } }, { providerOptions: { sampleCount: 2 } }, { providerOptions: { seed: 1 } }, { providerOptions: { action: "rawPredict" } }]) {
      await expect(generate({ personImage, productImage, ...extra })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed output instead of returning empty or fabricated images", async () => {
    const { fetch, generate } = setup();
    for (const response of [{}, {predictions:[]}, {predictions:[{}]}, {predictions:[{mimeType:"image/png",bytesBase64Encoded:"invalid!"}]}, {predictions:[{mimeType:"image/png",gcsUri:"https://example.com/image"}]}]) {
      fetch.mockResolvedValueOnce(Response.json(response));
      await expect(generate({ personImage, productImage })).rejects.toThrow();
    }
  });
  it("retries transient failures with the shared prediction transport", async () => {
    const { fetch, generate } = setup();
    fetch.mockResolvedValueOnce(new Response("busy", {status:503}));
    expect((await generate({ personImage, productImage, maxRetries: 1, retryBackoffMs: 1 })).images).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("requires bearer credentials and rejects incorrect high-level factories", async () => {
    await expect(createVertex({ apiKey:"key" }).virtualTryOn.generate({personImage,productImage})).rejects.toThrow("bearer");
    const { provider, fetch } = setup();
    expect(() => provider("virtual-try-on-001")).toThrow("virtualTryOn.generate");
    expect(() => provider.imageGenerationModel!("virtual-try-on-001")).toThrow("virtualTryOn.generate");
    expect(fetch).not.toHaveBeenCalled();
  });
});
