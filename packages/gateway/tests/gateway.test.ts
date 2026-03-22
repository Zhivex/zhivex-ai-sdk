import { describe, expect, it, vi } from "vitest";

import type { ProviderAdapter } from "@zhivex-ai/core";
import { createGateway } from "../src/index.js";

const createAdapter = (generateImpl: () => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }>): ProviderAdapter => ({
  name: "test",
  languageModel(modelId) {
    return {
      provider: "test",
      modelId,
      capabilities: {
        streaming: false,
        tools: false,
        structuredOutput: false,
        vision: true,
        files: false,
        embeddings: false
      },
      async generate() {
        const result = await generateImpl();
        return {
          messages: [
            {
              role: "assistant",
              parts: [{ type: "text", text: result.text }]
            }
          ],
          text: result.text,
          usage: result.usage
        };
      }
    };
  }
});

describe("gateway", () => {
  it("orders targets and falls back after retryable failures", async () => {
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 rate limited"))
      .mockRejectedValueOnce(new Error("429 rate limited"))
      .mockRejectedValueOnce(new Error("429 rate limited"));
    const success = vi.fn().mockResolvedValue({ text: "hello from fallback" });

    const gateway = createGateway({
      adapters: {
        gemini: createAdapter(failing),
        bedrock: createAdapter(success)
      },
      maxRetries: 2,
      retryBackoffMs: 1
    });

    const result = await gateway.generate({
      primary: { provider: "gemini", modelId: "gemini-2.0-pro" },
      fallbacks: [{ provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet" }],
      messages: [{ role: "user", content: "hello" }],
      routingMode: "quality",
      taskIntent: "reasoning"
    });

    expect(result.text).toBe("hello from fallback");
    expect(result.attempts).toHaveLength(4);
    expect(result.providerUsed).toBe("bedrock");
  });

  it("strips images for unsupported models", async () => {
    const inspect = vi.fn().mockImplementation(async () => ({ text: "ok" }));

    const gateway = createGateway({
      adapters: {
        bedrock: {
          name: "bedrock",
          languageModel(modelId) {
            return {
              provider: "bedrock",
              modelId,
              capabilities: {
                streaming: false,
                tools: false,
                structuredOutput: false,
                vision: true,
                files: false,
                embeddings: false
              },
              async generate(input) {
                inspect(input.messages);
                return {
                  messages: [{ role: "assistant", parts: [{ type: "text", text: "ok" }] }],
                  text: "ok"
                };
              }
            };
          }
        }
      }
    });

    await gateway.generate({
      primary: { provider: "bedrock", modelId: "anthropic.claude-v2" },
      messages: [
        {
          role: "user",
          content: "describe",
          images: [{ dataUrl: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" }]
        }
      ]
    });

    const firstCall = inspect.mock.calls[0]?.[0] as Array<{ parts: Array<{ type: string }> }>;
    expect(firstCall[0]?.parts).toEqual([{ type: "text", text: "describe" }]);
  });

  it("estimates usage when a provider omits token counts", async () => {
    const gateway = createGateway({
      adapters: {
        ollama: createAdapter(async () => ({ text: "hello world" }))
      }
    });

    const result = await gateway.generate({
      primary: { provider: "ollama", modelId: "llama3.2" },
      messages: [{ role: "user", content: "hello" }]
    });

    expect(result.usage.estimated).toBe(true);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });
});
