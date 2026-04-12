import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateObject, generateText, tool } from "@zhivex-ai/core";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createAnthropic } from "../src/index.js";

describe("anthropic adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "anthropic",
    modelId: "claude-3-5-sonnet",
    createModel: () => createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch })("claude-3-5-sonnet"),
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: false,
      jsonMode: false,
      toolChoice: true,
      parallelToolCalls: true,
      vision: true,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: true,
      webSearch: false
    }
  });

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
      model: provider("claude-3-5-sonnet"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from anthropic");
    expect(result.finishReason).toBe("stop");
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("claude-3-5-sonnet")).toMatchObject(provider.languageModel("claude-3-5-sonnet"));
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
      model: provider("claude-3-5-sonnet"),
      prompt: "double 2",
      maxSteps: 2,
      tools: {
        math: tool({
          name: "math",
          schema: z.object({ value: z.number() }),
          execute: ({ value }) => ({ result: value * 2 })
        })
      }
    });

    expect(result.text).toBe("result is 4");
    expect(result.toolResults[0]?.toolName).toBe("math");
    expect(provider.embeddingModel).toBeUndefined();
  });

  it("falls back to prompted structured output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: JSON.stringify({ title: "Soup" }) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("claude-3-5-sonnet"),
      prompt: "Return JSON",
      schema: z.object({
        title: z.string()
      })
    });

    expect(result.object.title).toBe("Soup");
    expect(result.objectMode).toBe("prompted");
  });

  it("passes provider-specific options through to the Anthropic API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      providerOptions: {
        top_p: 0.9,
        metadata: { source: "test" }
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { top_p: number; metadata: { source: string } };
    expect(body.top_p).toBe(0.9);
    expect(body.metadata.source).toBe("test");
  });

  it("maps common tool choice to Anthropic tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city })
        })
      },
      toolChoice: {
        type: "tool",
        toolName: "weather"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tool_choice: { type: string; name: string };
    };
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "weather"
    });
  });

  it("maps toolChoice none to Anthropic tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city })
        })
      },
      toolChoice: "none"
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      tool_choice: { type: string };
    };
    expect(body.tool_choice).toEqual({
      type: "none"
    });
  });

  it("maps reasoning budget tokens to Anthropic thinking", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        content: [{ type: "text", text: "hello from anthropic" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 }
      })
    );

    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("claude-3-5-sonnet"),
      prompt: "hello",
      reasoning: {
        budgetTokens: 1024
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      thinking: { type: string; budget_tokens: number };
    };
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024
    });
  });

  it("rejects unsupported reasoning effort for Anthropic", async () => {
    const provider = createAnthropic({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("claude-3-5-sonnet"),
        prompt: "hello",
        reasoning: {
          effort: "medium"
        }
      })
    ).rejects.toThrow('Provider "anthropic" does not support "reasoning.effort".');
  });
});
