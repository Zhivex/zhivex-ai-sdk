import { describe, expect, it } from "vitest";
import { createTextMessage, streamText } from "@zhivex-ai/core";
import { createQwen } from "../src/index.js";

describe("Qwen Chat terminal usage", () => {
  it.each(["qwen3.8-max", "qwen3.8-flash"])("preserves usage-only chunks after finish for %s", async (modelId) => {
    const provider = createQwen({ apiKey: "test", fetch: async () => new Response([
      { choices: [{ delta: { content: "18 C" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
      { choices: [], usage: { prompt_tokens: 86, completion_tokens: 12, total_tokens: 98, prompt_tokens_details: { cached_tokens: 4 } } }
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) });
    const result = await streamText({ model: provider(modelId), messages: [createTextMessage("user", "temperature")], providerOptions: { apiMode: "chat" }, reasoning: { effort: "none" } }).collect();
    expect(result.text).toBe("18 C");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({ inputTokens: 86, outputTokens: 12, totalTokens: 98, cachedInputTokens: 4 });
  });

  it("emits one terminal finish and preserves same-chunk usage at EOF without DONE", async () => {
    const provider = createQwen({ apiKey: "test", fetch: async () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n', { headers: { "content-type": "text/event-stream" } }) });
    const events = [];
    for await (const event of await provider("qwen3.8-max").stream({ messages: [createTextMessage("user", "hi")], providerOptions: { apiMode: "chat" } })) events.push(event);
    const finishes = events.filter(event => event.type === "finish");
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({ finishReason: "stop", usage: { totalTokens: 3 } });
    expect(events.at(-1)?.type).toBe("finish");
  });
});
