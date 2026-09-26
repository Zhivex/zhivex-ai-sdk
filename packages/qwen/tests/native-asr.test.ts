import { describe, it, expect, vi } from "vitest";
import { createQwenFileTranscriptionModel, createQwenNativeTranscriptionModel } from "../src/native-asr.js";
const options = { apiKey: "test", taskBaseURL: "https://maas.qwencloudapi.com/api/v1" };
const pending = { output: { task_id: "task-1", task_status: "PENDING" } };
describe("Qwen native ASR", () => {
  it("maps synchronous audio to native multimodal API", async () => {
    const fetch = vi.fn(async () => Response.json({ output: { choices: [{ message: { content: [{ text: "Hello" }] } }] } }));
    const result = await createQwenNativeTranscriptionModel("qwen-audio-3.0-asr-flash", { ...options, fetch }).transcribe({ audio: { data: "https://example.com/hello.wav", mediaType: "audio/wav" } });
    expect(result.text).toBe("Hello");
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toMatch(/multimodal-generation\/generation$/);
    expect(JSON.parse(init.body as string).input.messages[0].content[0]).toEqual({ type: "input_audio", input_audio: { data: "https://example.com/hello.wav" } });
    expect(init.redirect).toBe("error");
  });
  it("submits filetrans exactly once with asynchronous header and native parameters", async () => {
    const fetch = vi.fn(async () => Response.json(pending));
    const model = createQwenFileTranscriptionModel("qwen-audio-3.1-asr-flash-filetrans", { ...options, fetch });
    expect(await model.submit({ fileURL: "https://example.com/audio.wav", keepDialect: true, languageHints: ["zh"], diarization: true, speakerCount: 2 })).toEqual({ taskId: "task-1", status: "PENDING" });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toMatch(/audio\/asr\/transcription$/);
    expect(init.headers).toMatchObject({ "X-DashScope-Async": "enable" });
    expect(JSON.parse(init.body as string).parameters).toMatchObject({ keep_dialect: true, language_hints: ["zh"], diarization_enabled: true, speaker_count: 2 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves partial failures even when overall status succeeded", async () => {
    const fetch = vi.fn(async () => Response.json({ output: { task_id: "task-1", task_status: "SUCCEEDED", results: [
      { file_url: "https://example.com/1.wav", subtask_status: "SUCCEEDED", transcription_url: "https://example.com/1.json" },
      { file_url: "https://example.com/2.wav", subtask_status: "FAILED", code: "FILE_DOWNLOAD_FAILED" }
    ] }, usage: { duration: 3.8 } }));
    const result = await createQwenFileTranscriptionModel("qwen-audio-3.0-asr-flash-filetrans", { ...options, fetch }).get({ taskId: "task-1" });
    expect(result.results?.[1]).toMatchObject({ status: "FAILED", code: "FILE_DOWNLOAD_FAILED" });
    expect(result.durationSeconds).toBe(3.8);
    expect(fetch).toHaveBeenCalledTimes(1); // Does not automatically fetch returned URLs.
  });
  it("returns typed failed tasks without echoing potentially sensitive messages", async () => {
    const fetch = vi.fn(async () => Response.json({ output: { task_id: "task-1", task_status: "FAILED", code: "INVALID_AUDIO", message: "private url" } }));
    const result = await createQwenFileTranscriptionModel("qwen-audio-3.0-asr-flash-filetrans", { ...options, fetch }).get({ taskId: "task-1" });
    expect(result).toEqual({ taskId: "task-1", status: "FAILED", code: "INVALID_AUDIO" });
  });
  it.each([
    { fileURL: "http://127.0.0.1/a.wav" },
    { fileURL: "https://example.com/a.wav", keepDialect: true },
    { fileURL: "https://example.com/a.wav", channelIds: [-1] },
    { fileURL: "https://example.com/a.wav", vocabulary: { word: 6 } },
    { fileURL: "https://example.com/a.wav", speakerCount: 2 },
    { fileURL: "https://example.com/a.wav", diarization: true, channelIds: [0, 1] }
  ])("rejects invalid input before I/O", async input => {
    const fetch = vi.fn(async () => Response.json(pending));
    const model = createQwenFileTranscriptionModel("qwen-audio-3.0-asr-flash-filetrans", { ...options, fetch });
    await expect(model.submit(input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { output: { task_id: "wrong", task_status: "PENDING" } },
    { output: { task_id: "task-1", task_status: "SUCCEEDED" } },
    { output: { task_id: "task-1", task_status: "SUCCEEDED", results: [{ file_url: "https://example.com/a", subtask_status: "SUCCEEDED", transcription_url: "http://localhost/secrets" }] } }
  ])("rejects malformed task results", async response => {
    const model = createQwenFileTranscriptionModel("qwen-audio-3.0-asr-flash-filetrans", { ...options, fetch: async () => Response.json(response) });
    await expect(model.get({ taskId: "task-1" })).rejects.toThrow();
  });
  it("rejects path injection and server failures", async () => {
    const fetch = vi.fn(async () => new Response("secret", { status: 500 }));
    const model = createQwenFileTranscriptionModel("qwen-audio-3.0-asr-flash-filetrans", { ...options, fetch });
    await expect(model.get({ taskId: "../keys" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(model.get({ taskId: "task-1" })).rejects.toThrow("500");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
