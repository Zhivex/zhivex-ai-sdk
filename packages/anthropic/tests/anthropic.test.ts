import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { embed, generateText, UnsupportedFeatureError } from "@zhivex-ai/core";
import { createAnthropic } from "../src/index.js";

describe("anthropic adapter", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps message responses into common text output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider.languageModel("claude-3-5-sonnet"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from anthropic");
  });

  it("supports tool calls", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "tool_use", id: "tool-1", name: "math", input: { value: 2 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "result is 4" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider.languageModel("claude-3-5-sonnet"),
      prompt: "double 2",
      maxSteps: 2,
      tools: {
        math: {
          name: "math",
          schema: z.object({ value: z.number() }),
          execute: ({ value }) => ({ result: value * 2 })
        }
      }
    });

    expect(result.text).toBe("result is 4");
    expect(result.toolResults[0]?.toolName).toBe("math");
  });

  it("reports unsupported embeddings", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      embed({
        model: provider.embeddingModel("unsupported"),
        value: "hello"
      })
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});
