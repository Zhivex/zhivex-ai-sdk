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
});
