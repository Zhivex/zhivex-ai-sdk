import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { providerDataPart, tool, type ModelGenerateInput } from "@zhivex-ai/core";
import { createAnthropic } from "../src/index.js";

const headersOf = (fetcher: ReturnType<typeof vi.fn>) =>
  (fetcher.mock.calls.at(-1)?.[1] as RequestInit).headers as Record<string, string>;

const bodyOf = (fetcher: ReturnType<typeof vi.fn>) =>
  JSON.parse(String((fetcher.mock.calls.at(-1)?.[1] as RequestInit).body)) as Record<string, unknown>;

const messageResponse = () =>
  Response.json({
    content: [
      { type: "text", text: "ok" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { id: "a" } }
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 4,
      output_tokens: 6,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      output_tokens_details: { thinking_tokens: 5 }
    }
  });

describe("Anthropic SDK 1.x wire contract", () => {
  it("keeps Messages headers, cache TTL, vision, tools, thinking, and usage on the adapter", async () => {
    const fetcher = vi.fn(async () => messageResponse());
    const model = createAnthropic({ apiKey: "wire-key", fetch: fetcher as typeof fetch })("claude-3-5-sonnet");
    const input: ModelGenerateInput = {
      messages: [{
        role: "user",
        parts: [
          providerDataPart("anthropic", {
            type: "text",
            text: "cached",
            cache_control: { type: "ephemeral", ttl: "1h" }
          }),
          { type: "image", image: "https://example.com/diagram.png" },
          { type: "text", text: "What is in the diagram?" }
        ]
      }],
      tools: {
        lookup: tool({
          name: "lookup",
          description: "Look up an id",
          schema: z.object({ id: z.string() }),
          execute: async () => ({ ok: true })
        })
      },
      toolChoice: "auto",
      reasoning: { budgetTokens: 1024 },
      providerOptions: { betas: ["prompt-caching-2024-07-31"] },
      maxRetries: 0
    };

    const result = await model.generate(input);
    const headers = headersOf(fetcher);
    const body = bodyOf(fetcher);
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;

    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-api-key"]).toBe("wire-key");
    expect(headers.authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(messages[0]?.content[0]).toEqual({
      type: "text",
      text: "cached",
      cache_control: { type: "ephemeral", ttl: "1h" }
    });
    expect(messages[0]?.content[1]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/diagram.png" }
    });
    expect(body.tools).toEqual([
      expect.objectContaining({ name: "lookup", input_schema: expect.objectContaining({ type: "object" }) })
    ]);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(result.usage).toMatchObject({
      inputTokens: 9,
      outputTokens: 6,
      cachedInputTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 5
    });
    expect(result.finishReason).toBe("tool-calls");
  });

  it("retries a retryable Messages status and then returns the successful body", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(messageResponse());
    const model = createAnthropic({ apiKey: "wire-key", fetch: fetcher as typeof fetch })("claude-3-5-sonnet");

    const result = await model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "retry" }] }],
      maxRetries: 1
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(headersOf(fetcher)["x-api-key"]).toBe("wire-key");
    expect(headersOf(fetcher)["anthropic-version"]).toBe("2023-06-01");
    expect(result.text).toBe("ok");
  });
});
