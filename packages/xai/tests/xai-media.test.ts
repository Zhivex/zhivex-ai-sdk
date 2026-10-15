import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateImage, generateSpeech, generateVideo, transcribeAudio } from "@zhivex-ai/core";
import {
  XAI_DEPRECATED_MODELS,
  XAI_SPEECH_TO_SPEECH_MODEL,
  XAI_SPEECH_TO_TEXT_MODEL,
  XAI_TEXT_TO_SPEECH_MODEL,
  createXAI
} from "../src/index.js";

describe("xAI image, video, and voice", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  const provider = () => createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });

  it("generates images and edits with one or many references", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ url: "https://cdn.example.test/otter.jpg", mime_type: "image/jpeg" }] })
    );
    const image = await generateImage({
      model: provider().imageGenerationModel("grok-imagine-image-2.0"),
      prompt: "An otter",
      count: 2,
      aspectRatio: "1:1",
      providerOptions: { resolution: "1k", quality: "low", response_format: "url" }
    });
    expect(image.images[0]).toEqual(
      expect.objectContaining({ uri: "https://cdn.example.test/otter.jpg", mediaType: "image/jpeg" })
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.x.ai/v1/images/generations");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "An otter",
      n: 2,
      aspect_ratio: "1:1",
      resolution: "1k",
      quality: "low",
      response_format: "url"
    });

    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ b64_json: Buffer.from([1, 2, 3]).toString("base64") }] })
    );
    const edited = await generateImage({
      model: provider().imageGenerationModel("grok-imagine-image"),
      prompt: "Make it blue",
      images: [{ uri: "https://cdn.example.test/source.png", mediaType: "image/png" }]
    });
    expect(edited.images[0]?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.x.ai/v1/images/edits");
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)).image).toEqual({
      url: "https://cdn.example.test/source.png",
      type: "image_url"
    });

    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ url: "https://cdn.example.test/multi.jpg" }] }));
    await generateImage({
      model: provider().imageGenerationModel("grok-imagine-image-quality"),
      prompt: "Combine",
      images: [
        { providerMetadata: { file_id: "file-1" }, mediaType: "image/png" },
        { uri: "https://cdn.example.test/b.png", mediaType: "image/png" }
      ]
    });
    const multi = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)) as { images: unknown[] };
    expect(multi.images).toEqual([
      { file_id: "file-1" },
      { url: "https://cdn.example.test/b.png", type: "image_url" }
    ]);
  });

  it("polls a deferred image request and surfaces failures", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ request_id: "img_1" }))
      .mockResolvedValueOnce(
        Response.json({
          request_id: "img_1",
          status: "done",
          data: [{ url: "https://cdn.example.test/later.jpg" }]
        })
      );
    const result = await generateImage({
      model: provider().imageGenerationModel("grok-imagine-image"),
      prompt: "Later",
      providerOptions: { pollIntervalMs: 0 }
    });
    expect(result.images[0]?.uri).toBe("https://cdn.example.test/later.jpg");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.x.ai/v1/images/img_1");

    fetchMock.mockResolvedValueOnce(Response.json({ request_id: "img_fail" })).mockResolvedValueOnce(
      Response.json({ request_id: "img_fail", status: "failed", error: { message: "blocked" } })
    );
    await expect(
      generateImage({
        model: provider().imageGenerationModel("grok-imagine-image"),
        prompt: "Nope",
        providerOptions: { pollIntervalMs: 0 }
      })
    ).rejects.toThrow("xAI image generation failed: blocked");
  });

  it("rejects unsupported image options before fetching", async () => {
    const model = provider().imageGenerationModel("grok-imagine-image");
    await expect(generateImage({ model, prompt: "x", negativePrompt: "blur" })).rejects.toThrow(
      "does not support negativePrompt"
    );
    await expect(
      generateImage({ model: provider().imageGenerationModel("grok-imagine-image"), prompt: "x", providerOptions: { quality: "low" } })
    ).rejects.toThrow('image quality is supported only for "grok-imagine-image-2.0"');
    await expect(
      generateImage({
        model: provider().imageGenerationModel("grok-imagine-image-2.0"),
        prompt: "x",
        providerOptions: { quality: "high" }
      })
    ).rejects.toThrow('image quality must be "low", "medium", or "auto"');
    expect(() => provider().imageGenerationModel("dall-e-3")).toThrow("is not supported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls video generation and returns the temporary URL", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ request_id: "vid_1" }))
      .mockResolvedValueOnce(Response.json({ request_id: "vid_1", status: "pending" }))
      .mockResolvedValueOnce(
        Response.json({
          request_id: "vid_1",
          status: "done",
          video: { url: "https://cdn.example.test/boat.mp4" }
        })
      );
    const result = await generateVideo({
      model: provider().videoGenerationModel("grok-imagine-video-1.5"),
      prompt: "A paper boat",
      durationSeconds: 4,
      aspectRatio: "16:9",
      pollIntervalMs: 0,
      image: { uri: "https://cdn.example.test/frame.png", mediaType: "image/png" },
      providerOptions: { resolution: "480p" }
    });
    expect(result.videos[0]).toEqual(
      expect.objectContaining({ uri: "https://cdn.example.test/boat.mp4", mediaType: "video/mp4" })
    );
    expect(result.operationName).toBe("vid_1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.x.ai/v1/videos/generations");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "grok-imagine-video-1.5",
      prompt: "A paper boat",
      duration: 4,
      aspect_ratio: "16:9",
      resolution: "480p",
      image: { url: "https://cdn.example.test/frame.png", type: "image_url" }
    });
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("https://api.x.ai/v1/videos/vid_1");

    fetchMock.mockResolvedValueOnce(Response.json({ request_id: "vid_fail", status: "failed", error: { message: "quota" } }));
    await expect(
      generateVideo({
        model: provider().videoGenerationModel("grok-imagine-video-1.5-lite"),
        prompt: "Fail",
        pollIntervalMs: 0
      })
    ).rejects.toThrow("xAI video generation failed: quota");
  });

  it("rejects 1080p on grok-imagine-video and other unsupported video options", async () => {
    await expect(
      generateVideo({
        model: provider().videoGenerationModel("grok-imagine-video"),
        prompt: "Sharp",
        providerOptions: { resolution: "1080p" }
      })
    ).rejects.toThrow('supports video resolutions up to 720p');
    await expect(
      generateVideo({
        model: provider().videoGenerationModel("grok-imagine-video-1.5"),
        prompt: "Many",
        count: 2
      })
    ).rejects.toThrow("accepts one video per request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("synthesizes speech as bytes and as timestamped JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response(Uint8Array.from([9, 8, 7]), { headers: { "content-type": "audio/mpeg" } }));
    const speech = await generateSpeech({
      model: provider().speechModel(XAI_TEXT_TO_SPEECH_MODEL),
      input: "Hello",
      voice: "eve",
      providerOptions: { language: "en", speed: 1 }
    });
    expect(speech.audio).toEqual(new Uint8Array([9, 8, 7]));
    expect(speech.mediaType).toBe("audio/mpeg");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.x.ai/v1/tts");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      text: "Hello",
      voice_id: "eve",
      language: "en",
      speed: 1
    });

    fetchMock.mockResolvedValueOnce(
      Response.json({ audio: Buffer.from([4, 5]).toString("base64"), words: [{ word: "Hi", start: 0 }] })
    );
    const timed = await generateSpeech({
      model: provider().speechModel("grok-tts"),
      input: "Hi",
      providerOptions: { with_timestamps: true, language: "auto" }
    });
    expect(timed.audio).toEqual(new Uint8Array([4, 5]));
    expect(timed.rawResponse).toEqual({ words: [{ word: "Hi", start: 0 }] });
  });

  it("transcribes multipart audio and remote URLs", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ text: "hello there", language: "en", duration: 1.2 }));
    const transcript = await transcribeAudio({
      model: provider().transcriptionModel(XAI_SPEECH_TO_TEXT_MODEL),
      audio: { data: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg", filename: "hello.mp3" },
      language: "en",
      providerOptions: { keyterm: ["Grok", "xAI"], diarize: true }
    });
    expect(transcript.text).toBe("hello there");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.x.ai/v1/stt");
    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit).body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("model")).toBe("grok-voice-transcribe-2.0");
    expect(form.get("language")).toBe("en");
    expect(form.getAll("keyterm")).toEqual(["Grok", "xAI"]);
    expect(form.get("diarize")).toBe("true");
    expect(form.get("file")).toBeInstanceOf(File);

    fetchMock.mockResolvedValueOnce(Response.json({ text: "from url" }));
    await transcribeAudio({
      model: provider().transcriptionModel("grok-voice-transcribe-2.0"),
      audio: { data: new Uint8Array([1]), mediaType: "audio/mpeg" },
      providerOptions: { url: "https://cdn.example.test/clip.mp3" }
    });
    const remote = (fetchMock.mock.calls[1]?.[1] as RequestInit).body as FormData;
    expect(remote.get("url")).toBe("https://cdn.example.test/clip.mp3");
    expect(remote.get("file")).toBeNull();
  });

  it("marks grok-imagine-image-quality deprecated and still sends the slug", async () => {
    expect(XAI_DEPRECATED_MODELS["grok-imagine-image-quality"]).toContain("grok-imagine-image-2.0");
    expect(XAI_DEPRECATED_MODELS["grok-imagine-image-quality"]).toContain("2026-11-02");
    expect(XAI_DEPRECATED_MODELS["grok-imagine-image-quality"]).toContain('quality "low"');

    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ url: "https://cdn.example.test/quality.jpg" }] }));
    const image = await generateImage({
      model: provider().imageGenerationModel("grok-imagine-image-quality"),
      prompt: "Keep the current slug"
    });
    expect(image.images[0]?.uri).toBe("https://cdn.example.test/quality.jpg");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      model: "grok-imagine-image-quality",
      prompt: "Keep the current slug"
    });
  });

  it("accepts quality auto on grok-imagine-image-2.0", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ url: "https://cdn.example.test/auto.jpg" }] }));
    await generateImage({
      model: provider().imageGenerationModel("grok-imagine-image-2.0"),
      prompt: "Auto quality",
      providerOptions: { quality: "auto" }
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      model: "grok-imagine-image-2.0",
      prompt: "Auto quality",
      quality: "auto"
    });
  });

  it("marks grok-voice-2.0 deprecated and refuses grok-voice-3.0 as REST speech", () => {
    expect(XAI_DEPRECATED_MODELS["grok-voice-2.0"]).toContain("grok-voice-3.0");
    const xai = provider();
    expect(() => xai.speechModel("grok-voice-2.0")).toThrow("is deprecated");
    expect(() => xai.speechModel(XAI_SPEECH_TO_SPEECH_MODEL)).toThrow("speech-to-speech model, not text-to-speech");
    expect(() => xai.transcriptionModel("grok-voice-3.0")).toThrow("speech-to-speech model, not speech-to-text");
    expect(() => xai.transcriptionModel("grok-tts")).toThrow('speech-to-text model is "grok-voice-transcribe-2.0"');
  });

  it("surfaces empty and failed media responses", async () => {
    const xai = provider();
    fetchMock.mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(generateImage({ model: xai.imageGenerationModel("grok-imagine-image"), prompt: "empty" })).rejects.toThrow(
      "returned no images"
    );

    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 400 }));
    await expect(generateSpeech({ model: xai.speechModel("grok-tts"), input: "Hello" })).rejects.toThrow(
      "xAI request failed with status 400"
    );

    fetchMock.mockResolvedValueOnce(Response.json({ request_id: "vid_bad", status: "done" }));
    await expect(
      generateVideo({ model: xai.videoGenerationModel("grok-imagine-video-1.5"), prompt: "missing", pollIntervalMs: 0 })
    ).rejects.toThrow("xAI video generation failed");

    fetchMock.mockResolvedValueOnce(Response.json({ status: "pending" }));
    await expect(
      generateVideo({ model: xai.videoGenerationModel("grok-imagine-video-1.5-lite"), prompt: "noid", pollIntervalMs: 0 })
    ).rejects.toThrow("returned no request id");

    fetchMock.mockResolvedValueOnce(Response.json({ text: "from bytes" }));
    const transcript = await transcribeAudio({
      model: xai.transcriptionModel("grok-voice-transcribe-2.0"),
      audio: { data: Buffer.from([1, 2]).toString("base64"), mediaType: "audio/wav" }
    });
    expect(transcript.text).toBe("from bytes");
  });

  it("rejects invalid image, video, and voice requests before fetching", async () => {
    const xai = provider();
    const image = xai.imageGenerationModel("grok-imagine-image");
    const video = xai.videoGenerationModel("grok-imagine-video-1.5");
    const speech = xai.speechModel("grok-tts");
    const transcription = xai.transcriptionModel("grok-voice-transcribe-2.0");

    await expect(generateImage({ model: image, prompt: "x", count: 11 })).rejects.toThrow("count must be an integer from 1 to 10");
    await expect(generateImage({ model: image, prompt: "x", aspectRatio: "7:1" })).rejects.toThrow("does not support image aspect ratio");
    await expect(generateImage({ model: image, prompt: "x", size: "1024x1024" })).rejects.toThrow('image size must be "1k" or "2k"');
    await expect(generateImage({ model: image, prompt: "x", providerOptions: { resolution: "4k" } })).rejects.toThrow('image resolution must be "1k" or "2k"');
    await expect(
      generateVideo({ model: video, prompt: "x", negativePrompt: "blur" })
    ).rejects.toThrow("does not support negativePrompt");
    await expect(generateVideo({ model: video, prompt: "x", outputStorageUri: "gs://bucket" })).rejects.toThrow(
      "does not support outputStorageUri"
    );
    await expect(generateVideo({ model: video, prompt: "x", durationSeconds: 16 })).rejects.toThrow(
      "durationSeconds must be an integer from 1 to 15"
    );
    await expect(generateVideo({ model: video, prompt: "x", aspectRatio: "19.5:9" })).rejects.toThrow(
      "does not support video aspect ratio"
    );
    await expect(generateVideo({ model: video, prompt: "x", providerOptions: { resolution: "4k" } })).rejects.toThrow(
      'video resolution must be "480p", "720p", or "1080p"'
    );
    await expect(generateSpeech({ model: speech, input: "   " })).rejects.toThrow("requires text");
    await expect(generateSpeech({ model: speech, input: "a".repeat(60_001) })).rejects.toThrow("at most 60000 characters");
    await expect(
      transcribeAudio({
        model: transcription,
        audio: { data: new Uint8Array([1]), mediaType: "audio/mpeg" },
        prompt: "hint"
      })
    ).rejects.toThrow("does not support prompt");
    expect(() => xai.videoGenerationModel("not-a-video")).toThrow("video model");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses media models on the US regional host", () => {
    const us = createXAI({ apiKey: "test", region: "us", fetch: fetchMock as typeof fetch });
    expect(() => us.imageGenerationModel("grok-imagine-image")).toThrow("US regional endpoint");
    expect(() => us.videoGenerationModel("grok-imagine-video")).toThrow("US regional endpoint");
    expect(() => us.speechModel("grok-tts")).toThrow("US regional endpoint");
    expect(() => us.transcriptionModel("grok-voice-transcribe-2.0")).toThrow("US regional endpoint");

    const explicit = createXAI({
      apiKey: "test",
      baseURL: "https://us.api.x.ai/v1",
      fetch: fetchMock as typeof fetch
    });
    expect(() => explicit.imageGenerationModel("grok-imagine-image-quality")).toThrow("US regional endpoint");
  });
});
