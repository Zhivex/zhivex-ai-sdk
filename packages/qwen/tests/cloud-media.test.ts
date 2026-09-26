import { describe, expect, it, vi } from "vitest";
import { createQwenImageTranslationModel, validateWan30, validateQwenImage30 } from "../src/cloud-media.js";
import { createQwenWorldsClient } from "../src/worlds.js";
const base = "https://maas.qwencloudapi.com/api/v1";
const mock = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
describe("Qwen Cloud media", () => {
  it("maps synchronous image translation with terminology and no async header", async () => {
    const fetcher = mock({ output: { image_url: "https://images.test/translated.jpg" }, request_id: "r" });
    const result = await createQwenImageTranslationModel("qwen-mt-image-2.0", "test", base, fetcher).translate({ imageUrl: "https://images.test/source.png", sourceLanguage: "auto", targetLanguage: "es", imageSegment: true, terminologies: [{ src: "AI", tgt: "IA" }] });
    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(url).toBe(`${base}/services/aigc/image2image/image-synthesis`);
    expect(init?.headers).not.toHaveProperty("X-DashScope-Async");
    expect(JSON.parse(init?.body as string).input).toMatchObject({ source_lang: "auto", target_lang: "es", ext: { config: { imageSegment: true } } });
    expect(result.imageUrl).toBe("https://images.test/translated.jpg");
  });
  it("submits legacy translation as an asynchronous operation", async () => {
    const fetcher = mock({ output: { task_id: "task-1" } });
    const model = createQwenImageTranslationModel("qwen-mt-image", "test", base, fetcher);
    expect((await model.translate({ imageUrl: "https://images.test/a.png", sourceLanguage: "en", targetLanguage: "es" })).operationName).toBe("task-1");
    expect(vi.mocked(fetcher).mock.calls[0]![1]?.headers).toHaveProperty("X-DashScope-Async", "enable");
    await expect(model.translate({ imageUrl: "https://images.test/a.png", sourceLanguage: "en", targetLanguage: "es", async: false })).rejects.toThrow("asynchronous");
  });
  it("does not retry billable mutations or expose provider echoes", async () => {
    const fetcher = mock({ code: "Denied", message: "secret source URL" }, 403);
    const model = createQwenImageTranslationModel("qwen-mt-image-2.0", "test", base, fetcher);
    await expect(model.translate({ imageUrl: "https://images.test/a.png", sourceLanguage: "en", targetLanguage: "es" })).rejects.not.toThrow("secret source");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects missing output and unsafe input URLs", async () => {
    const fetcher = mock({ output: {} });
    const model = createQwenImageTranslationModel("qwen-mt-image-2.0", "test", base, fetcher);
    await expect(model.translate({ imageUrl: "https://images.test/a.png", sourceLanguage: "en", targetLanguage: "es" })).rejects.toThrow("response image URL");
    await expect(model.translate({ imageUrl: "file:///etc/passwd", sourceLanguage: "en", targetLanguage: "es" })).rejects.toThrow("HTTP(S)");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("validates Wan3 material combinations and low-cost dimensions", () => {
    expect(() => validateWan30([{ type: "first_frame", url: "https://images.test/a.png" }], { resolution: "480P", duration: 2 })).not.toThrow();
    expect(() => validateWan30([{ type: "last_frame", url: "https://images.test/a.png" }], {})).toThrow("first_frame");
    expect(() => validateWan30([{ type: "first_frame", url: "https://images.test/a.png" }, { type: "reference_audio", url: "https://images.test/a.wav" }], {})).toThrow("mixed");
    expect(() => validateWan30(undefined, { duration: 31 })).toThrow("duration");
    expect(() => validateWan30(undefined, { duration: -1, ratio: "adaptive" })).not.toThrow();
  });
  it("validates Image3 size/count before submission", () => {
    expect(() => validateQwenImage30({ prompt: "blue square", size: "512*512", count: 1 }, {})).not.toThrow();
    expect(() => validateQwenImage30({ prompt: "blue square", size: "256*256" }, {})).toThrow("pixels");
    expect(() => validateQwenImage30({ prompt: "blue square" }, { n: 7 })).toThrow("count");
  });
});
describe("HappyOyster lifecycle", () => {
  it("routes model-specific creation and strips request controls", async () => {
    const fetcher = mock({ code: 0, data: { encryptedWorldId: "world-1", status: "generating" } });
    const model = createQwenWorldsClient("happyoyster-1.0-acting", "test", base, fetcher);
    await model.create({ prompt: "A friendly robot", firstFrameImage: { url: "https://images.test/portrait.png" }, aspectRatio: "9:16", timeoutMs: 1000 });
    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(url).toBe("https://maas.qwencloudapi.com/api/v2/apps/happyoyster-1.0-acting/openapi/v1/worlds");
    expect(JSON.parse(init?.body as string)).toMatchObject({ async: true, creationModel: "simple", aspectRatio: "9:16" });
    expect(JSON.parse(init?.body as string)).not.toHaveProperty("timeoutMs");
  });
  it("enforces model-specific fields and image exclusivity before network", async () => {
    const fetcher = mock({});
    const model = createQwenWorldsClient("happyoyster-1.0-adventure", "test", base, fetcher);
    await expect(model.create({ prompt: "A forest" })).rejects.toThrow("firstFrameImage");
    await expect(model.create({ prompt: "A forest", firstFrameImage: { url: "https://images.test/a.png" } })).rejects.toThrow("perspective");
    await expect(model.enterTravel({ ticket: "ticket", maxExperienceTimeSec: 30 as 60 })).rejects.toThrow("duration");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("encodes opaque IDs and rejects application errors with HTTP 200", async () => {
    const fetcher = mock({ code: 403003, data: null, message: "echo secret" });
    const model = createQwenWorldsClient("happyoyster-1.0-adventure", "test", base, fetcher);
    await expect(model.buildStatus("world&a=1")).rejects.toThrow("request failed");
    expect(vi.mocked(fetcher).mock.calls[0]![0]).toContain("encryptedWorldId=world%26a%3D1");
  });
  it("validates credential ownership and deletion confirmation", async () => {
    const fetcher = mock({ code: 0, data: { encryptedWorldId: "other", ticket: "ticket", expiresIn: 1800, deleted: true } });
    const model = createQwenWorldsClient("happyoyster-1.0-directing", "test", base, fetcher);
    await expect(model.getTravelCredential("world")).rejects.toThrow("credential");
    await expect(model.delete("world")).rejects.toThrow("deletion");
  });
});

describe("Cloud protocol edge cases", () => {
  it("rejects null JSON as a typed configuration failure", async () => {
    const fetcher = mock(null);
    await expect(createQwenImageTranslationModel("qwen-mt-image-2.0", "test", base, fetcher).translate({ imageUrl: "https://images.test/a.png", sourceLanguage: "en", targetLanguage: "es" })).rejects.toThrow("envelope");
  });
  it("creates directing ScriptList and validates update turns", async () => {
    const fetcher = mock({ code: 0, data: { encryptedWorldId: "world", status: "generating" } });
    const worlds = createQwenWorldsClient("happyoyster-1.0-directing", "test", base, fetcher);
    await worlds.create({ creationModel: "scriptlist", resolution: "480p", scriptList: { synopsis: "A robot waves.", acts: [{ turn: 1, content: "The robot waves." }] } });
    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0]![1]?.body as string).creationModel).toBe("scriptlist");
    await expect(worlds.updateScript("travel", [{ turn: 1, content: "wave" }])).rejects.toThrow("exactly 45");
    await expect(worlds.updateScript("travel", Array.from({ length: 45 }, () => ({ turn: 1, content: "wave" })))).rejects.toThrow("unique");
  });
  it("rejects controls unsupported by each world mode", async () => {
    const fetcher = mock({});
    const adventure = createQwenWorldsClient("happyoyster-1.0-adventure", "test", base, fetcher);
    await expect(adventure.pauseTravel("t")).rejects.toThrow("pause");
    await expect(adventure.instructTravel("t", { content: "wave" })).rejects.toThrow("sendCommand");
    const acting = createQwenWorldsClient("happyoyster-1.0-acting", "test", base, fetcher);
    await expect(acting.rewindTravel("t", 4)).rejects.toThrow("Directing");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

import { prepareViduVideo, validateViduImage, validateHappyHorse } from "../src/cloud-media.js";
describe("hosted Vidu and HappyHorse profiles", () => {
  it("maps Vidu reference ratio to size with the chosen resolution", () => {
    expect(prepareViduVideo("vidu/viduq3-mix_reference2video", [{ type: "image", url: "https://images.test/a.png" }], { duration: 1, resolution: "720P", ratio: "9:16", n: 1 })).toEqual({ duration: 1, resolution: "720P", size: "720*1280" });
    expect(() => prepareViduVideo("vidu/viduq3-ad_reference2video", [{ type: "image", url: "https://images.test/a.png" }], { duration: 1 })).toThrow("duration");
    expect(() => prepareViduVideo("vidu/viduq3-drama_reference2video", [{ type: "image", url: "https://images.test/a.png" }], { ratio: "1:1" })).toThrow("ratio");
    expect(() => prepareViduVideo("vidu/viduq2-pro-fast_img2video", [{ type: "first_frame", url: "https://images.test/a.png" }], {})).toThrow("type=image");
  });
  it("enforces Vidu image output constraints", () => {
    expect(() => validateViduImage({ prompt: "Blue circle", count: 1, size: "1024*1024" }, {})).not.toThrow();
    expect(() => validateViduImage({ prompt: "Blue circle", size: "512*512" }, {})).toThrow("size");
    expect(() => validateViduImage({ prompt: "Blue circle", count: 2 }, {})).toThrow("one image");
  });
  it("enforces HappyHorse media dialect and model-specific input", () => {
    expect(() => validateHappyHorse("happyhorse-1.1-i2v", [{ type: "first_frame", url: "https://images.test/a.png" }], { duration: 3, resolution: "480P" })).not.toThrow();
    expect(() => validateHappyHorse("happyhorse-1.1-i2v", [{ type: "image", url: "https://images.test/a.png" }], {})).toThrow("first_frame");
    expect(() => validateHappyHorse("happyhorse-1.1-r2v", [], {})).toThrow("count");
    expect(() => validateHappyHorse("happyhorse-1.1-t2v", undefined, { duration: 2 })).toThrow("duration");
  });
});

it("unwraps the public gateway HappyOyster output envelope observed live", async () => {
  const fetcher = mock({ request_id: "r", output: { code: 0, data: { encryptedWorldId: "w", status: "generating" } } });
  const worlds = createQwenWorldsClient("happyoyster-1.0-directing", "test", base, fetcher);
  expect((await worlds.buildStatus("w")).status).toBe("generating");
});
it("rejects wrapped HappyOyster business errors", async () => {
  const fetcher = mock({ output: { code: 403003, message: "provider echo", data: null } });
  await expect(createQwenWorldsClient("happyoyster-1.0-acting", "test", base, fetcher).list()).rejects.toThrow("request failed");
});
it("validates HappyHorse video editing media and preserved dimensions", () => {
  const media = [{ type: "video", url: "https://media.test/v.mp4" }, { type: "reference_image", url: "https://media.test/i.png" }];
  expect(() => validateHappyHorse("happyhorse-1.0-video-edit", media, { resolution: "720P", audio_setting: "origin" })).not.toThrow();
  expect(() => validateHappyHorse("happyhorse-1.0-video-edit", media, { duration: 3 })).toThrow("preserves");
  expect(() => validateHappyHorse("happyhorse-1.0-video-edit", media, { resolution: "480P" })).toThrow("720P");
  expect(() => validateHappyHorse("happyhorse-1.0-video-edit", [{ type: "reference_image", url: "https://media.test/i.png" }], {})).toThrow("one video");
});
it("accepts Wan3 base64 media and requires prompt enhancement for documents", () => {
  expect(() => validateWan30([{ type: "first_frame", url: "data:image/png;base64,YQ==" }], {})).not.toThrow();
  expect(() => validateWan30([{ type: "file", url: "https://media.test/doc.pdf" }], { prompt_extend: false })).toThrow("prompt_extend");
});
it("rejects Image3 agent prompt enhancement with editing references", () => {
  expect(() => validateQwenImage30({ prompt: "Edit", images: [{}] }, { prompt_extend_mode: "agent" })).toThrow("text-to-image only");
});
