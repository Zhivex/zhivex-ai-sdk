import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderHTTPError, ProviderResponseTooLargeError, generateImage } from "@zhivex-ai/core";
import {
  createOpenAIImageGenerationModel,
  createOpenAI,
  normalizeOpenAIImageGenerationCall,
  normalizeOpenAIImageGenerationPartialImage,
  openAIImageGenerationTool
} from "../src/index.js";

describe("OpenAI image generation", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps the Image API to the shared image generation contract without duplicating base64", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const base64 = Buffer.from(bytes).toString("base64");
    fetchMock.mockResolvedValueOnce(
      Response.json({
        created: 123,
        data: [{ b64_json: base64, revised_prompt: "A revised prompt" }],
        usage: { total_tokens: 42 }
      })
    );

    const model = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2",
      apiKey: "secret-test-key",
      baseURL: "https://example.test/v1/",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateImage({
      model,
      prompt: "Draw an otter",
      count: 1,
      aspectRatio: "16:9",
      outputMimeType: "image/webp",
      providerOptions: {
        quality: "high",
        output_compression: 80,
        headers: {
          "x-client-request-id": "req-1",
          Authorization: "must-not-win",
          "Content-Type": "text/plain"
        }
      }
    });

    expect(result.images).toEqual([
      expect.objectContaining({
        data: bytes,
        mediaType: "image/webp",
        text: "A revised prompt",
        providerMetadata: { revised_prompt: "A revised prompt" }
      })
    ]);
    expect(result.text).toBe("A revised prompt");
    expect(result.rawResponse).toEqual({
      created: 123,
      data: [{ revised_prompt: "A revised prompt" }],
      usage: { total_tokens: 42 }
    });
    expect(JSON.stringify(result.rawResponse)).not.toContain(base64);
    expect(JSON.stringify(result.rawResponse)).not.toContain("secret-test-key");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/v1/images/generations");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toEqual({
      authorization: "Bearer secret-test-key",
      "content-type": "application/json",
      "x-client-request-id": "req-1"
    });
    expect(JSON.parse(String(request.body))).toEqual({
      model: "gpt-image-2",
      prompt: "Draw an otter",
      n: 1,
      size: "1536x864",
      output_format: "webp",
      quality: "high",
      output_compression: 80
    });
  });

  it("supports URL responses and typed Responses hosted-tool options", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ url: "https://cdn.example.test/image.png", revised_prompt: "revised" }] })
    );
    const model = createOpenAIImageGenerationModel({
      modelId: "dall-e-3",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateImage({
      model,
      prompt: "Draw a lighthouse",
      providerOptions: { response_format: "url", style: "natural" }
    });

    expect(result.images[0]).toEqual(expect.objectContaining({
      uri: "https://cdn.example.test/image.png",
      mediaType: "image/png"
    }));
    expect(openAIImageGenerationTool({
      action: "edit",
      quality: "high",
      size: "1024x1536",
      output_format: "webp",
      output_compression: 75,
      partial_images: 2
    })).toEqual({
      kind: "hosted",
      name: "image_generation",
      provider: "openai",
      type: "image_generation",
      toolClass: "custom",
      config: {
        action: "edit",
        quality: "high",
        size: "1024x1536",
        output_format: "webp",
        output_compression: 75,
        partial_images: 2
      }
    });
  });

  it("exposes image generation through the public provider factory", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ b64_json: Buffer.from([10, 11]).toString("base64") }] })
    );
    const provider = createOpenAI({ apiKey: "test", fetch: fetchMock as typeof fetch });

    const result = await generateImage({
      model: provider.imageGenerationModel!("gpt-image-2"),
      prompt: "Draw a harbor"
    });

    expect(result.images[0]?.data).toEqual(new Uint8Array([10, 11]));
    expect(provider.imageGenerationModel!("gpt-image-2").capabilities.imageGeneration).toBe(true);
  });

  it("normalizes final and partial image tool outputs without retaining base64 in metadata", () => {
    const finalBase64 = Buffer.from([5, 6, 7]).toString("base64");
    const partialBase64 = Buffer.from([8, 9]).toString("base64");

    const final = normalizeOpenAIImageGenerationCall({
      id: "ig_1",
      type: "image_generation_call",
      status: "completed",
      revised_prompt: "revised",
      result: finalBase64
    });
    const partial = normalizeOpenAIImageGenerationPartialImage({
      type: "response.image_generation_call.partial_image",
      item_id: "ig_1",
      output_index: 1,
      sequence_number: 4,
      partial_image_index: 0,
      partial_image_b64: partialBase64
    });

    expect(final).toEqual(expect.objectContaining({
      id: "ig_1",
      status: "completed",
      revisedPrompt: "revised",
      image: expect.objectContaining({ data: new Uint8Array([5, 6, 7]), mediaType: "image/png" })
    }));
    expect(final?.providerMetadata).not.toHaveProperty("result");
    expect(final?.image?.providerMetadata).not.toHaveProperty("result");
    expect(partial).toEqual(expect.objectContaining({
      source: "responses",
      callId: "ig_1",
      partialImageIndex: 0,
      outputIndex: 1,
      sequenceNumber: 4,
      image: expect.objectContaining({ data: new Uint8Array([8, 9]), mediaType: "image/png" })
    }));
    expect(partial?.providerMetadata).not.toHaveProperty("partial_image_b64");
  });

  it("rejects unsupported edits and invalid streaming/tool combinations before fetching", async () => {
    const model = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });

    await expect(generateImage({
      model,
      prompt: "edit",
      images: [{ data: new Uint8Array([1]), mediaType: "image/png" }]
    })).rejects.toThrow("do not accept input images");
    await expect(model.generateImage({
      prompt: "draw",
      providerOptions: { stream: true } as never
    })).rejects.toThrow("streaming is not supported");
    expect(() => openAIImageGenerationTool({ output_format: "jpeg", background: "transparent" }))
      .toThrow("transparent background");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries transient HTTP failures and enforces the configured response limit", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: Buffer.from([1]).toString("base64") }] }));
    const retryingModel = createOpenAIImageGenerationModel({
      modelId: "gpt-image-1.5",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });

    const retried = await retryingModel.generateImage({ prompt: "draw", maxRetries: 1, retryBackoffMs: 0 });
    expect(retried.images[0]?.data).toEqual(new Uint8Array([1]));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ b64_json: "a".repeat(256) }] }));
    const limitedModel = createOpenAIImageGenerationModel({
      modelId: "gpt-image-1.5",
      apiKey: "test",
      fetch: fetchMock as typeof fetch,
      responseMaxBytes: 32
    });

    await expect(limitedModel.generateImage({ prompt: "draw" })).rejects.toBeInstanceOf(
      ProviderResponseTooLargeError
    );
  });

  it("maps 16:9 and 9:16 for GPT Image 2.5 Flare and Sunburst", async () => {
    const cases = [
      ["gpt-image-2.5-flare", "16:9", "1536x864"],
      ["gpt-image-2.5-sunburst", "9:16", "864x1536"],
      ["gpt-image-2.5-sunburst-2026-09-08", "16:9", "1536x864"]
    ] as const;
    for (const [modelId, aspectRatio, size] of cases) {
      fetchMock.mockResolvedValueOnce(
        Response.json({ data: [{ b64_json: Buffer.from([1]).toString("base64") }] })
      );
      const model = createOpenAIImageGenerationModel({
        modelId,
        apiKey: "test",
        fetch: fetchMock as typeof fetch
      });
      await model.generateImage({ prompt: "draw", aspectRatio });
      expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({
        model: modelId,
        size
      });
    }

    const older = createOpenAIImageGenerationModel({
      modelId: "gpt-image-1.5",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    await expect(older.generateImage({ prompt: "draw", aspectRatio: "16:9" }))
      .rejects.toThrow('aspect ratio "16:9"');
    expect(fetchMock).toHaveBeenCalledTimes(cases.length);
  });

  it("accepts xhigh and max quality only for GPT Image 2.5 Flare and Sunburst", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ b64_json: Buffer.from([1]).toString("base64") }] })
    );
    const flare = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2.5-flare",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    await flare.generateImage({ prompt: "draw", providerOptions: { quality: "max" } });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "gpt-image-2.5-flare",
      quality: "max"
    });

    const dated = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2.5-sunburst-2026-09-08",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ b64_json: Buffer.from([2]).toString("base64") }] })
    );
    await dated.generateImage({ prompt: "draw", providerOptions: { quality: "xhigh" } });

    const older = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    await expect(older.generateImage({ prompt: "draw", providerOptions: { quality: "xhigh" } }))
      .rejects.toThrow('image quality "xhigh"');
    expect(() => openAIImageGenerationTool({ quality: "max" })).toThrow('image quality "max"');
    expect(openAIImageGenerationTool({
      model: "gpt-image-2.5-flare-2026-09-08",
      quality: "xhigh"
    }).config).toMatchObject({ model: "gpt-image-2.5-flare-2026-09-08", quality: "xhigh" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces non-retryable provider errors with a bounded response body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "moderation_blocked" } }), { status: 400 })
    );
    const model = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });

    await expect(model.generateImage({ prompt: "draw" })).rejects.toMatchObject<Partial<ProviderHTTPError>>({
      status: 400
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a credentialed image request that is redirected", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: "http://127.0.0.1/collect" } }));
    const model = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2",
      apiKey: "secret-test-key",
      baseURL: "https://example.test/v1",
      fetch: fetchMock as typeof fetch
    });

    await expect(model.generateImage({ prompt: "draw" })).rejects.toMatchObject({ status: 308 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  const imageResponse = () => Response.json({ data: [{ b64_json: Buffer.from([1]).toString("base64") }] });
  const requestBody = () => JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;

  it("maps GPT Image 2.6 sizes and extended quality on the Image API", async () => {
    for (const [modelId, aspectRatio, size] of [
      ["gpt-image-2.6-flare", "16:9", "1536x864"],
      ["gpt-image-2.6-sunburst", "9:16", "864x1536"]
    ] as const) {
      fetchMock.mockResolvedValueOnce(imageResponse());
      const model = createOpenAIImageGenerationModel({ modelId, apiKey: "test", fetch: fetchMock as typeof fetch });
      expect(model.capabilities).toMatchObject({ imageGeneration: true, vision: true, reasoning: false });
      await model.generateImage({ prompt: "draw", aspectRatio, providerOptions: { quality: "max", complexity: "high" } });
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("https://api.openai.com/v1/images/generations");
      expect(requestBody()).toMatchObject({ model: modelId, size, quality: "max", complexity: "high" });
    }
    const dated = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2.6-flare-2026-11-04",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    await expect(dated.generateImage({ prompt: "draw", providerOptions: { quality: "xhigh" } })).rejects.toThrow('image quality "xhigh"');
    expect(() => openAIImageGenerationTool({ model: "gpt-image-2.6-sunburst", quality: "high" })).toThrow("Image API");
  });

  it("sends GPT Image 2.6 SVG and GIF generation contracts", async () => {
    fetchMock.mockResolvedValueOnce(imageResponse());
    const model = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2.6-flare",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    const svg = await model.generateImage({
      prompt: "logo",
      outputMimeType: "image/svg+xml",
      providerOptions: { background: "transparent" }
    });
    expect(svg.images[0]?.mediaType).toBe("image/svg+xml");
    expect(requestBody()).toMatchObject({ output_format: "svg", background: "transparent" });
    expect(requestBody()).not.toHaveProperty("complexity");

    await expect(model.generateImage({ prompt: "logo", outputMimeType: "image/svg+xml", count: 2 })).rejects.toThrow("count 1");
    await expect(model.generateImage({
      prompt: "logo",
      outputMimeType: "image/gif",
      providerOptions: { frame_count: 1 }
    })).rejects.toThrow("frame_count");
    await expect(model.generateImage({
      prompt: "logo",
      providerOptions: { frame_count: 4 }
    })).rejects.toThrow("GIF output");

    fetchMock.mockResolvedValueOnce(imageResponse());
    const gif = await model.generateImage({
      prompt: "loop",
      size: "512x512",
      outputMimeType: "image/gif",
      providerOptions: { frame_count: 9, frame_duration_ms: 200, quality: "high" }
    });
    expect(gif.images[0]?.mediaType).toBe("image/gif");
    expect(requestBody()).toMatchObject({
      output_format: "gif",
      size: "512x512",
      frame_count: 9,
      frame_duration_ms: 200
    });
    await expect(model.generateImage({
      prompt: "loop",
      outputMimeType: "image/gif",
      providerOptions: { output_compression: 20 }
    })).rejects.toThrow("output_compression");
    const older = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2.5-flare",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    await expect(older.generateImage({ prompt: "draw", providerOptions: { complexity: "low" } })).rejects.toThrow("complexity");
    await expect(older.generateImage({ prompt: "draw", outputMimeType: "image/svg+xml" })).rejects.toThrow("SVG");
  });

  it("sends markup-guided edits for GPT Image 2.5 and 2.6 and keeps older models on generations", async () => {
    fetchMock.mockResolvedValueOnce(imageResponse());
    const flare = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2.6-flare",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    const png = Buffer.from([1, 2, 3]).toString("base64");
    await flare.generateImage({
      prompt: "recolor the vase",
      images: [{ data: new Uint8Array([9, 8]), mediaType: "image/webp" }],
      outputMimeType: "image/gif",
      providerOptions: {
        quality: "medium",
        complexity: "low",
        frame_count: 2,
        markup: { image_url: `data:image/png;base64,${png}` }
      }
    });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe("https://api.openai.com/v1/images/edits");
    expect(requestBody()).toMatchObject({
      model: "gpt-image-2.6-flare",
      output_format: "gif",
      complexity: "low",
      frame_count: 2,
      images: [{ image_url: "data:image/webp;base64,CQg=" }],
      markup: { image_url: `data:image/png;base64,${png}` }
    });

    fetchMock.mockResolvedValueOnce(imageResponse());
    const sunburst25 = createOpenAIImageGenerationModel({
      modelId: "gpt-image-2.5-sunburst",
      apiKey: "test",
      fetch: fetchMock as typeof fetch
    });
    await sunburst25.generateImage({
      prompt: "edit",
      images: [{ providerMetadata: { file_id: "file_kitchen" }, mediaType: "image/webp" }],
      providerOptions: { markup: { file_id: "file_overlay" } }
    });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/images/edits");
    expect(requestBody()).toMatchObject({
      images: [{ file_id: "file_kitchen" }],
      markup: { file_id: "file_overlay" }
    });

    await expect(flare.generateImage({
      prompt: "edit",
      images: [{ data: new Uint8Array([1]), mediaType: "image/png" }],
      providerOptions: { markup: { file_id: "file_overlay" }, mask: { file_id: "file_mask" } }
    })).rejects.toThrow("cannot combine markup");
    await expect(flare.generateImage({
      prompt: "edit",
      images: [{ data: new Uint8Array([1]), mediaType: "image/svg+xml" }]
    })).rejects.toThrow("SVG input");
    await expect(flare.generateImage({
      prompt: "draw",
      providerOptions: { input_fidelity: "high" }
    })).rejects.toThrow("input_fidelity");
    await expect(flare.generateImage({
      prompt: "draw",
      outputMimeType: "image/svg+xml",
      images: [{ data: new Uint8Array([1]), mediaType: "image/png" }]
    })).rejects.toThrow("generations only");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
