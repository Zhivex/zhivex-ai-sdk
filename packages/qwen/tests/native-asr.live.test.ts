import { expect, it } from "vitest";
import { createQwenNativeTranscriptionModel, createQwenFileTranscriptionModel } from "../src/native-asr.js";
const audio = "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello_world_male2.wav";
it.skipIf(process.env.QWEN_NATIVE_ASR_LIVE !== "1")("Qwen native ASR short official sample", async () => {
  const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("A Qwen API key is required.");
  const options = { apiKey, taskBaseURL: "https://maas.qwencloudapi.com/api/v1" };
  const result = await createQwenNativeTranscriptionModel("qwen-audio-3.0-asr-flash", options).transcribe({ audio: { data: audio, mediaType: "audio/wav" }, timeoutMs: 15000, providerOptions: { sample_rate: "16000" } });
  expect(result.text.length).toBeGreaterThan(0);
}, 20000);
it.skipIf(process.env.QWEN_FILETRANS_LIVE !== "1")("Qwen filetrans short official sample", async () => {
  const apiKey = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("A Qwen API key is required.");
  const model = createQwenFileTranscriptionModel("qwen-audio-3.0-asr-flash-filetrans", { apiKey, taskBaseURL: "https://maas.qwencloudapi.com/api/v1" });
  let task = await model.submit({ fileURL: audio, timeoutMs: 15000 });
  for (let i = 0; i < 6 && ["PENDING", "RUNNING"].includes(task.status); i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    task = await model.get({ taskId: task.taskId, timeoutMs: 10000 });
  }
  expect(task.status).toBe("SUCCEEDED");
  expect(task.results?.[0]?.status).toBe("SUCCEEDED");
}, 80000);
