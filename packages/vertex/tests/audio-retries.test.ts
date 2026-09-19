import { describe, expect, it, vi } from "vitest";
import { generateSpeech, streamSpeech, transcribeAudio, type RetryOptions } from "@zhivex-ai/core";
import { createVertex } from "../src/index.js";

describe("Vertex audio request retries", () => {
  it.each(["transcribe", "speech", "stream"] as const)("retries %s setup and bounds backoff", async operation => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const vertex = createVertex({ projectId: "p", accessToken: "test", fetch });
    const run = async (options: RetryOptions) => {
      if (operation === "transcribe") return (await transcribeAudio({ model: vertex.transcriptionModel!("gemini-2.0-flash"), audio: { data: "AQI=", mediaType: "audio/wav" }, ...options })).text;
      if (operation === "speech") return Array.from((await generateSpeech({ model: vertex.speechModel!("gemini-3.1-flash-tts-preview"), input: "hello", ...options })).audio);
      const bytes: number[] = [];
      for await (const chunk of await streamSpeech({ model: vertex.speechModel!("gemini-3.1-flash-tts-preview"), input: "hello", ...options })) bytes.push(...chunk.audio);
      return bytes;
    };
    const body = { candidates: [{ content: { parts: [{ text: "hello", inlineData: { mimeType: "audio/pcm", data: "AQI=" } }] } }] };
    fetch.mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(operation === "stream" ? new Response(`data: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(body));
    expect(await run({ maxRetries: 1, retryBackoffMs: 1 })).toEqual(operation === "transcribe" ? "hello" : [1, 2]);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockReset().mockImplementation(async () => new Response("busy", { status: 503 }));
    await expect(run({ maxRetries: 2, retryBackoffMs: 1000, timeoutMs: 10 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not replay a speech stream after audio was delivered", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"audio/pcm","data":"AQI="}}]}}]}\n\ndata: malformed\n\n', { headers: { "content-type": "text/event-stream" } }));
    const vertex = createVertex({ projectId: "p", accessToken: "test", fetch });
    const stream = await streamSpeech({ model: vertex.speechModel!("gemini-3.1-flash-tts-preview"), input: "hello", maxRetries: 2 });
    const iterator = stream[Symbol.asyncIterator]();
    expect(Array.from((await iterator.next()).value!.audio)).toEqual([1, 2]);
    await expect(iterator.next()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
