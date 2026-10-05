import { expect, it, vi } from "vitest";
import type { StreamEvent } from "@zhivex-ai/core";
import { createKimi } from "../src/index.js";
it("retains Kimi cached-token accounting in a final usage-only chunk", async () => {
  const chunks = [{ choices: [{ delta: { reasoning_content: "reason", content: "OK" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 10, cached_tokens: 4, completion_tokens: 5, total_tokens: 15 } }];
  const fetcher = vi.fn().mockImplementation(async () => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"));
  const model = createKimi({ apiKey: "test", fetch: fetcher })("moonshot-v1-8k");
  const events: StreamEvent[] = [];
  for await (const event of await model.stream!({ messages: [{ role: "user", parts: [{ type: "text", text: "test" }] }] })) events.push(event);
  expect(events).toContainEqual({ type: "provider-data", provider: "kimi", data: { type: "reasoning_content", reasoningContent: "reason" } });
  expect(events.at(-1)).toEqual({ type: "finish", finishReason: "stop", providerFinishReason: "stop", usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5, totalTokens: 15 } });
  expect(events.filter(event => event.type === "finish")).toHaveLength(1);
});
