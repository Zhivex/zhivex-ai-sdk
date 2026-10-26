import { describe, expect, it, vi } from "vitest";
import { createQwen, QWEN_CLOUD_BASE_URL, QWEN_DECISION_PREVIEW_BASE_URL } from "../src/index.js";

function setup(response: unknown = { output: { task_id: "task-1", task_status: "PENDING" } }) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response));
  const qwen = createQwen({ apiKey: "test-key", baseURL: QWEN_CLOUD_BASE_URL, fetch });
  const call = () => {
    const [url, init] = fetch.mock.calls[0]!;
    return { url: String(url), init: init!, body: JSON.parse(String(init!.body)) };
  };
  return { qwen, fetch, call };
}
describe("Qwen Cloud public factory wiring", () => {
  it("rejects asynchronous success envelopes without a task identity", async () => {
    const { qwen } = setup({ output: {} });
    await expect(qwen.imageGenerationModel!("vidu/vidu-image_reference2image").generateImage({ prompt: "A cat" })).rejects.toThrow("task ID");
    await expect(qwen.videoGenerationModel!("wan3.0-video").generateVideo({ prompt: "A cat", durationSeconds: 2 })).rejects.toThrow("task ID");
  });
  it("preserves default regional base while explicit Cloud base derives native API", async () => {
    const { qwen, call } = setup();
    await qwen.fileTranscriptionModel("qwen-audio-3.0-asr-flash-filetrans").submit({ fileURL: "https://example.com/audio.wav" });
    expect(call().url).toBe("https://maas.qwencloudapi.com/api/v1/services/audio/asr/transcription");
    expect(call().body).toEqual({ model: "qwen-audio-3.0-asr-flash-filetrans", input: { file_urls: ["https://example.com/audio.wav"] }, parameters: {} });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [{ index: 0, embedding: [1] }] }));
    await createQwen({ apiKey: "test", fetch }).embeddingModel!("text-embedding-v4").embed({ values: ["hello"] });
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings");
  });
  it("uses only the explicitly configured Decision endpoint", async () => {
    const response = { model: "decision-model-preview", request_id: "r1", answers: { urgent: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 8 }, latency_ms: 2 };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response));
    const qwen = createQwen({ apiKey: "test-key", baseURL: QWEN_CLOUD_BASE_URL, decisionBaseURL: QWEN_DECISION_PREVIEW_BASE_URL, fetch });
    await qwen.decisionModel().decide({ state: "Hello", questions: { urgent: { type: "noul", instructions: "Urgent?" } } });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${QWEN_DECISION_PREVIEW_BASE_URL}/systemone`);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(() => qwen("decision-model-preview")).toThrow("decisionModel");
    expect(() => qwen.transcriptionModel!("qwen-audio-3.1-asr-flash-filetrans")).toThrow("fileTranscriptionModel");
  });
  it("Vidu image uses its asynchronous endpoint and returns operation ID", async () => {
    const { qwen, call } = setup();
    const result = await qwen.imageGenerationModel!("vidu/vidu-image_reference2image").generateImage({ prompt: "A cat", images: [{ uri: "https://example.com/cat.png", mediaType: "image/png" }], size: "1024*1024" });
    expect(call().url).toBe("https://maas.qwencloudapi.com/api/v1/services/aigc/image-generation/generation");
    expect(call().init.headers).toMatchObject({ "X-DashScope-Async": "enable" });
    expect(call().body).toEqual({ model: "vidu/vidu-image_reference2image", input: { messages: [{ role: "user", content: [{ image: "https://example.com/cat.png" }, { text: "A cat" }] }] }, parameters: { size: "1024*1024", n: 1 } });
    expect(result.operationName).toBe("task-1");
    expect(result.images).toEqual([]);
  });
  it.each([
    ["1:1", "1024*1024"], ["16:9", "1920*1088"], ["9:16", "1088*1920"],
    ["4:3", "1024*768"], ["3:4", "768*1024"]
  ])("Vidu image maps %s to its supported 1K preset with one output", async (aspectRatio, size) => {
    const { qwen, call } = setup();
    await qwen.imageGenerationModel!("vidu/vidu-image_reference2image").generateImage({ prompt: "A cat", aspectRatio });
    expect(call().body.parameters).toEqual({ size, n: 1 });
  });
  it("HappyHorse editing appends the convenience reference without replacing the source video", async () => {
    const { qwen, call } = setup();
    await qwen.videoGenerationModel!("happyhorse-1.1-video-edit").generateVideo({
      prompt: "Replace the background with the reference image",
      image: { uri: "https://example.com/background.png", mediaType: "image/png" },
      providerOptions: {
        input: { media: [{ type: "video", url: "https://example.com/source.mp4" }] },
        parameters: { resolution: "720P", audio_setting: "origin" }
      }
    });
    expect(call().body.input).toEqual({ prompt: "Replace the background with the reference image", media: [
      { type: "video", url: "https://example.com/source.mp4" },
      { type: "reference_image", url: "https://example.com/background.png" }
    ] });
    expect(call().body.parameters).toEqual({ resolution: "720P", audio_setting: "origin" });
  });
  it("Vidu reference video transforms ratio/resolution and keeps reference media", async () => {
    const { qwen, call } = setup();
    await qwen.videoGenerationModel!("vidu/viduq3-mix_reference2video").generateVideo({ prompt: "Animate", aspectRatio: "16:9", durationSeconds: 3, count: 1, providerOptions: { input: { media: [{ type: "image", url: "https://example.com/ref.png" }] }, parameters: { resolution: "720P" } } });
    expect(call().url).toBe("https://maas.qwencloudapi.com/api/v1/services/aigc/video-generation/video-synthesis");
    expect(call().body.input).toEqual({ prompt: "Animate", media: [{ type: "image", url: "https://example.com/ref.png" }] });
    expect(call().body.parameters).toEqual({ duration: 3, resolution: "720P", size: "1280*720" });
  });
  it.each(["wan3.0-video", "happyhorse-1.0-i2v"])("%s maps first frame to media instead of legacy img_url", async id => {
    const { qwen, call } = setup();
    await qwen.videoGenerationModel!(id).generateVideo({ prompt: "Animate", image: { uri: "https://example.com/frame.png", mediaType: "image/png" }, durationSeconds: 3 });
    expect(call().body.input).toEqual({ prompt: "Animate", media: [{ type: "first_frame", url: "https://example.com/frame.png" }] });
    expect(call().body.parameters.duration).toBe(3);
    expect(call().init.headers).toMatchObject({ "X-DashScope-Async": "enable" });
  });
  it("sends the published PixVerse V6 body for each model", async () => {
    const image = { uri: "https://example.com/frame.png", mediaType: "image/png" };
    const singapore = "https://ap-southeast-1.maas.qwencloudapi.com";
    const cases = [
      {
        id: "pixverse/pixverse-v6-t2v",
        input: { prompt: "A raccoon", durationSeconds: 5, providerOptions: { parameters: { size: "1280*720", audio: true, shot_type: "single", watermark: true, seed: 7 } } },
        bodyInput: { prompt: "A raccoon" },
        parameters: { duration: 5, size: "1280*720", audio: true, shot_type: "single", watermark: true, seed: 7 }
      },
      {
        id: "pixverse/pixverse-v6-it2v",
        input: { prompt: "She smiles", image, durationSeconds: 1, providerOptions: { resolution: "720P", shot_type: "multi" } },
        bodyInput: { prompt: "She smiles", media: [{ type: "image_url", url: "https://example.com/frame.png" }] },
        parameters: { duration: 1, resolution: "720P", shot_type: "multi" }
      },
      {
        id: "pixverse/pixverse-v6-kf2v",
        input: { prompt: "The flower blooms", durationSeconds: 15, providerOptions: { input: { media: [{ type: "first_frame", url: "https://example.com/first.jpg" }, { type: "last_frame", url: "https://example.com/last.webp" }] }, parameters: { resolution: "1080P" } } },
        bodyInput: { prompt: "The flower blooms", media: [{ type: "first_frame", url: "https://example.com/first.jpg" }, { type: "last_frame", url: "https://example.com/last.webp" }] },
        parameters: { duration: 15, resolution: "1080P" }
      },
      {
        id: "pixverse/pixverse-v6-r2v",
        input: { prompt: "@man plays @guitar", durationSeconds: 5, providerOptions: { input: { media: [{ type: "image_url", url: "https://example.com/man.png", ref_name: "man" }, { type: "image_url", url: "https://example.com/guitar.png", ref_name: "guitar" }] }, parameters: { size: "720*1280", audio: false } } },
        bodyInput: { prompt: "@man plays @guitar", media: [{ type: "image_url", url: "https://example.com/man.png", ref_name: "man" }, { type: "image_url", url: "https://example.com/guitar.png", ref_name: "guitar" }] },
        parameters: { duration: 5, size: "720*1280", audio: false }
      }
    ] as const;
    for (const item of cases) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ output: { task_id: "task-1", task_status: "PENDING" } }));
      const qwen = createQwen({ apiKey: "test-key", baseURL: `${singapore}/compatible-mode/v1`, taskBaseURL: `${singapore}/api/v1`, fetch });
      const result = await qwen.videoGenerationModel!(item.id).generateVideo(item.input);
      const [url, init] = fetch.mock.calls[0]!;
      expect(String(url)).toBe(`${singapore}/api/v1/services/aigc/video-generation/video-synthesis`);
      expect(init?.headers).toMatchObject({ "X-DashScope-Async": "enable" });
      expect(JSON.parse(String(init?.body))).toEqual({ model: item.id, input: item.bodyInput, parameters: item.parameters });
      expect(result.operationName).toBe("task-1");
    }
  });
  it("rejects PixVerse duration, resolution, reference count, and the wrong region before I/O", async () => {
    const { qwen, fetch } = setup();
    const image = { uri: "https://example.com/frame.png", mediaType: "image/png" };
    await expect(qwen.videoGenerationModel!("pixverse/pixverse-v6-t2v").generateVideo({ prompt: "A raccoon", durationSeconds: 16, providerOptions: { size: "1280*720" } })).rejects.toThrow("duration");
    await expect(qwen.videoGenerationModel!("pixverse/pixverse-v6-it2v").generateVideo({ prompt: "Smile", image, durationSeconds: 5, providerOptions: { resolution: "4k" } })).rejects.toThrow("resolution");
    await expect(qwen.videoGenerationModel!("pixverse/pixverse-v6-r2v").generateVideo({ prompt: "Refs", durationSeconds: 5, providerOptions: { input: { media: Array.from({ length: 8 }, () => ({ type: "image_url", url: "https://example.com/a.png" })) }, size: "1280*720" } })).rejects.toThrow("1 to 7");
    await expect(qwen.videoGenerationModel!("pixverse/pixverse-v6-it2v").generateVideo({ prompt: "Smile", image, durationSeconds: 5, providerOptions: { input: { media: [{ type: "image_url", url: "https://example.com/other.png" }] }, resolution: "720P" } })).rejects.toThrow("not both");
    const beijing = createQwen({ apiKey: "test-key", baseURL: "https://cn-beijing.maas.aliyuncs.com/compatible-mode/v1", taskBaseURL: "https://cn-beijing.maas.aliyuncs.com/api/v1", fetch });
    await expect(beijing.videoGenerationModel!("pixverse/pixverse-v6-t2v").generateVideo({ prompt: "A raccoon", durationSeconds: 5, providerOptions: { size: "1280*720" } })).rejects.toThrow("Singapore");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves lower-level media parameters when convenience fields are absent", async () => {
    const { qwen, call } = setup();
    await qwen.videoGenerationModel!("wan3.0-video").generateVideo({ prompt: "Animate", providerOptions: { input: { media: [{ type: "reference_audio", url: "https://example.com/music.wav" }], negative_prompt: "blur" }, parameters: { duration: 4, ratio: "16:9", audio: true } } });
    expect(call().body.input.negative_prompt).toBe("blur");
    expect(call().body.parameters).toEqual({ duration: 4, ratio: "16:9", audio: true });
  });
  it("retains provider JSON rawResponse for legacy embedding consumers", async () => {
    const response = { data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2, total_tokens: 2 } };
    const { qwen } = setup(response);
    const result = await qwen.embeddingModel!("text-embedding-v4").embed({ values: ["hello"] });
    expect(result.rawResponse).toEqual(response);
  });
  it("rejects replacement cumulative translation frames instead of appending corrupt text", async () => {
    const fetch = vi.fn(async () => new Response(["Hello", "Goodbye"].map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("")));
    const qwen = createQwen({ apiKey: "test", baseURL: QWEN_CLOUD_BASE_URL, fetch });
    const consume = async () => { for await (const _event of await qwen("qwen-mt-plus").stream({ messages: [{ role: "user", parts: [{ type: "text", text: "Hola" }] }] })) { /* consume */ } };
    await expect(consume()).rejects.toThrow("replaced already streamed text");
  });
});
