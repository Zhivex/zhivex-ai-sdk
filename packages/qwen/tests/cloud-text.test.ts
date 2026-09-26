import { expect, it, vi } from "vitest";
import { createQwen } from "../src/index.js";
const message = { role: "user" as const, parts: [{ type: "text" as const, text: "Hola" }] };
it("requires dedicated factories for specialized Cloud models", () => {
  const qwen = createQwen({ apiKey: "test" });
  for (const id of ["decision-model-preview", "qwen-image-3.0", "qwen-audio-3.0-tts-flash", "wan3.0-video", "happyoyster-1.0-acting"]) {
    expect(() => qwen(id)).toThrow(/factory|factories|decisionModel/);
  }
});
it("routes translation through chat with native translation options", async () => {
  let target = "", body: any;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    target = String(url); body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
  };
  const model = createQwen({ apiKey: "test", fetch })("qwen-mt-flash");
  expect(model.capabilities.tools).toBe(false);
  await model.generate({ messages: [message], providerOptions: { translation_options: { source_lang: "auto", target_lang: "English" } } });
  expect(target.endsWith("/chat/completions")).toBe(true);
  expect(body.translation_options.target_lang).toBe("English");
});
it("normalizes cumulative translation streams without duplicated output", async () => {
  const fetch = vi.fn(async () => new Response(["Hello", "Hello world"].map(content =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  const events = [];
  for await (const event of await createQwen({ apiKey: "test", fetch })("qwen-mt-plus").stream({ messages: [message] })) events.push(event);
  expect(events.filter(e => e.type === "text-delta").map(e => e.textDelta).join("")).toBe("Hello world");
});
it("rejects invalid translation conversations and unsupported character controls before fetch", async () => {
  const fetch = vi.fn();
  const qwen = createQwen({ apiKey: "test", fetch });
  await expect(qwen("qwen-mt-lite").generate({ messages: [message, message] })).rejects.toThrow("single user");
  await expect(qwen("qwen-flash-character").generate({ messages: [message], reasoning: { effort: "high" } })).rejects.toThrow("reasoning");
  expect(fetch).not.toHaveBeenCalled();
});
it("supports dated Max aliases and native open model vision", () => {
  const qwen = createQwen({ apiKey: "test" });
  expect(qwen("qwen3.8-max-2026-09-02").capabilities).toEqual(qwen("qwen3.8-max").capabilities);
  expect(qwen("qwen3.8-27b").capabilities.vision).toBe(true);
  expect(qwen("qwen3.7-flash").capabilities.vision).toBe(true);
});

it("routes 27B image/video inputs through chat and rejects audio, documents ", async () => {
  let target = "", body: any;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    target = String(url); body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: "A scene." }, finish_reason: "stop" }] });
  };
  const model = createQwen({ apiKey: "test", fetch })("qwen3.8-27b");
  await model.generate({ messages: [{ role: "user", parts: [
    { type: "image", image: "https://example.com/image.png" },
    { type: "file", data: "https://example.com/video.mp4", mediaType: "video/mp4" }
  ] }] });
  expect(target).toMatch(/chat\/completions$/);
  expect(body.messages[0].content.map((p: any) => p.type)).toEqual(["image_url", "video_url"]);
  for (const part of [
    { type: "audio", data: "AAAA", mediaType: "audio/wav" },
    { type: "file", data: "https://example.com/doc.pdf", mediaType: "application/pdf" }
  ]) await expect(model.generate({ messages: [{ role: "user", parts: [part as any] }] })).rejects.toThrow("audio or document");
});
it("permits character web search but rejects its unsupported agent strategy", async () => {
  const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] }));
  const qwen = createQwen({ apiKey: "test", fetch });
  await qwen("qwen-flash-character").generate({ messages: [message], providerOptions: { enable_search: true, search_options: { search_strategy: "turbo" } } });
  for (const id of ["qwen-flash-character", "qwen3.8-27b", "qwen3.8-2.4t-a95b"]) {
    await expect(qwen(id).generate({ messages: [message], providerOptions: { enable_search: true, search_options: { search_strategy: "agent" } } })).rejects.toThrow("search_strategy agent");
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toMatch(/chat\/completions$/);
});
