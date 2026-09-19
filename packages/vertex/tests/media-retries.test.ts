import { describe, expect, it, vi } from "vitest";
import { createVertex } from "../src/index.js";

describe("Vertex generated media retries", () => {
  it.each(["imagen", "image", "lyria", "music", "video"] as const)("retries %s HTTP failures within its deadline", async kind => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const vertex = createVertex({ projectId: "p", location: "us-central1", accessToken: "test", fetch });
    const run = (timeoutMs = 1000, retryBackoffMs = 1) => {
      const input = { prompt: "synthetic", maxRetries: 1, retryBackoffMs, timeoutMs };
      if (kind === "imagen" || kind === "image") return vertex.imageGenerationModel!(kind === "imagen" ? "imagen-4.0-generate-001" : "gemini-3.1-flash-image").generateImage(input);
      if (kind === "lyria" || kind === "music") return vertex.musicGenerationModel!(kind === "lyria" ? "lyria-002" : "music-test").generateMusic(input);
      return vertex.videoGenerationModel!("veo-3.1-generate-001").generateVideo(input);
    };
    fetch.mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(Response.json({ done: true, predictions: [{ bytesBase64Encoded: "AQI=", audioContent: "AQI=" }], candidates: [{ content: { parts: [{ inlineData: { data: "AQI=", mimeType: "image/png" } }] } }] }));
    await run();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
    fetch.mockReset().mockImplementation(async () => new Response("busy", { status: 503 }));
    await expect(run(10, 1000)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries video polling without resubmitting generation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ name: "operations/one", done: false }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ name: "operations/one", done: true }));
    const vertex = createVertex({ projectId: "p", location: "us-central1", accessToken: "test", fetch });
    await vertex.videoGenerationModel!("veo-3.1-generate-001").generateVideo({ prompt: "synthetic", pollIntervalMs: 1, maxRetries: 1, retryBackoffMs: 1 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith(":predictLongRunning"))).toHaveLength(1);
    for (const [, request] of fetch.mock.calls.slice(1)) expect(JSON.parse(String(request?.body))).toEqual({ operationName: "operations/one" });
  });
});
