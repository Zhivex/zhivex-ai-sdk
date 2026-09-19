import { expect, it, vi } from "vitest";
import { generateText, streamText } from "@zhivex-ai/core";
import { createQwen } from "../src/index.js";

it.each([
  { type: "response.failed", response: { status: "failed", error: { message: "private-provider-detail" } } },
  { type: "error", error: { message: "private-provider-detail" } },
  { type: "response.completed", response: { status: "failed" } }
])("rejects a failed Responses stream instead of resolving collect: $type", async event => {
  const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  const model = createQwen({ apiKey: "fixture", fetch: fetch as typeof globalThis.fetch })("qwen3.8-flash");
  const result = streamText({ model, prompt: "fixture", providerOptions: { apiMode: "responses" } });
  const events = [];
  for await (const item of result.eventStream) events.push(item);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(events.map(item => item.type)).toEqual(["error"]);
  await expect(result.collect()).rejects.toMatchObject({ name: "QwenResponseError", diagnosticCode: "QWEN_RESPONSE_FAILED", message: "Qwen Responses generation failed." });
});

it("rejects non-streaming failed Responses with a bounded diagnostic", async () => {
  const model = createQwen({ apiKey: "fixture", fetch: async () => Response.json({ status: "failed", error: { message: "private-provider-detail" }, output: [] }) })("qwen3.8-flash");
  await expect(generateText({ model, prompt: "fixture", providerOptions: { apiMode: "responses" } })).rejects.toMatchObject({ name: "QwenResponseError", diagnosticCode: "QWEN_RESPONSE_FAILED", message: "Qwen Responses generation failed." });
});
