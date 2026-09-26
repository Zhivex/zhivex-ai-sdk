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
