import { describe, expect, it } from "vitest";
import { createQwen } from "../src/index.js";
const mediaEnabled = process.env.QWEN_CLOUD_MEDIA_INTEGRATION === "1";
const worldsEnabled = process.env.QWEN_CLOUD_WORLDS_INTEGRATION === "1";
const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
if ((mediaEnabled || worldsEnabled) && !apiKey) throw new Error("Qwen Cloud media smoke requires an API key.");
const provider = () => createQwen({ apiKey, baseURL: process.env.QWEN_BASE_URL ?? "https://maas.qwencloudapi.com/compatible-mode/v1", taskBaseURL: process.env.QWEN_TASK_BASE_URL ?? "https://maas.qwencloudapi.com/api/v1" });
// Explicit opt-in: this test creates two images and one 2-second video. No automatic retries.
describe.skipIf(!mediaEnabled)("Qwen Cloud bounded media integration", () => {
  it("generates and edits one 512px Image3 output", async () => {
    const model = provider().imageGenerationModel("qwen-image-3.0");
    const options = { size: "512*512", count: 1, timeoutMs: 120000, maxRetries: 0, providerOptions: { prompt_extend: false, enable_thinking: false } };
    const generated = await model.generateImage({ ...options, prompt: "A blue circle on a white background." });
    expect(generated.images.length).toBe(1);
    expect(!!generated.images[0]?.uri).toBe(true);
    const edited = await model.generateImage({ ...options, prompt: "Change the blue circle to green. Keep the white background.", images: [{ uri: generated.images[0]!.uri!, mediaType: "image/png" }] });
    expect(edited.images.length).toBe(1);
    expect(!!edited.images[0]?.uri).toBe(true);
  }, 250000);
  it("generates one silent two-second 480P Wan3 video", async () => {
    const qwen = provider();
    const operation = await qwen.videoGenerationModel("wan3.0-video").generateVideo({ prompt: "A blue circle gently moving on white.", durationSeconds: 2, aspectRatio: "1:1", count: 1, timeoutMs: 30000, maxRetries: 0, providerOptions: { resolution: "480P", audio: false, prompt_extend: false } });
    expect(!!operation.operationName).toBe(true);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const task = await qwen.tasks.get({ name: operation.operationName!, timeoutMs: 20000, maxRetries: 0 });
      if (task.done) {
        expect(!!task.error).toBe(false);
        expect(!!(task.response as { video_url?: string } | undefined)?.video_url).toBe(true);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error("Wan3 task did not finish before the bounded polling deadline. The submitted task was not resubmitted.");
  }, 220000);
});
// Separate opt-in: world creation is a separate service and does not start an RTC travel.
describe.skipIf(!worldsEnabled)("Qwen Cloud worlds lifecycle integration", () => {
  it("creates and deletes a 480p Directing world without starting travel", async () => {
    const worlds = provider().worlds("happyoyster-1.0-directing");
    await worlds.list({ pageSize: 1, timeoutMs: 20000 });
    const world = await worlds.create({ prompt: "A calm blue landscape with rolling hills.", resolution: "480p", async: true, timeoutMs: 30000 });
    try {
      const status = await worlds.buildStatus(world.encryptedWorldId, { timeoutMs: 20000 });
      expect(["generating", "ready", "failed"].includes(status.status)).toBe(true);
    } finally {
      const result = await worlds.delete(world.encryptedWorldId, { timeoutMs: 20000 });
      expect(result.deleted).toBe(true);
    }
  }, 100000);
});

const extendedEnabled = process.env.QWEN_CLOUD_EXTENDED_MEDIA_INTEGRATION === "1";
if (extendedEnabled && !apiKey) throw new Error("Qwen Cloud extended media smoke requires an API key.");
const awaitTask = async (qwen: ReturnType<typeof provider>, name: string) => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const task = await qwen.tasks.get({ name, timeoutMs: 20000, maxRetries: 0 });
    if (task.done) { expect(!!task.error).toBe(false); return task; }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error("Media task polling deadline expired; task was not resubmitted.");
};
describe.skipIf(!extendedEnabled)("Qwen Cloud extended media routes", () => {
  it("translates an official image with text", async () => {
    const result = await provider().imageTranslationModel("qwen-mt-image-2.0").translate({ imageUrl: "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250916/ordhsk/1.webp", sourceLanguage: "zh", targetLanguage: "en", timeoutMs: 90000 });
    expect(!!result.imageUrl).toBe(true);
  }, 95000);
  it("creates one Vidu 1K image", async () => {
    const qwen = provider();
    const result = await qwen.imageGenerationModel("vidu/vidu-image_reference2image").generateImage({ prompt: "A blue circle on white.", size: "1024*1024", count: 1, timeoutMs: 30000, maxRetries: 0 });
    expect(!!result.operationName).toBe(true);
    const task = await awaitTask(qwen, result.operationName!);
    const response = task.response as { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> };
    expect(!!response.choices?.some(choice => choice.message?.content?.some(content => content.image))).toBe(true);
  }, 220000);
  it("creates one HappyHorse 3-second 480P first-frame video", async () => {
    const qwen = provider();
    const result = await qwen.videoGenerationModel("happyhorse-1.1-i2v").generateVideo({ prompt: "A cat gently moving on grass.", image: { uri: "https://cdn.translate.alibaba.com/r/wanx-demo-1.png", mediaType: "image/png" }, durationSeconds: 3, timeoutMs: 30000, maxRetries: 0, providerOptions: { resolution: "480P" } });
    expect(!!result.operationName).toBe(true);
    const task = await awaitTask(qwen, result.operationName!);
    expect(!!(task.response as { video_url?: string }).video_url).toBe(true);
  }, 220000);
});
