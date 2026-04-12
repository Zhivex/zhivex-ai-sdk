import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTextMessage, generateObject, generateText, tool } from "@zhivex-ai/core";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createOllama } from "../src/index.ts";

describe("ollama adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "ollama",
    modelId: "llama3.2",
    createModel: () => createOllama({ fetch: fetchMock as typeof fetch })("llama3.2"),
    expectedCapabilities: {
      streaming: false,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: false,
      parallelToolCalls: true,
      vision: true,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: false,
      webSearch: false
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps generated text into the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { content: "hello from ollama" },
        prompt_eval_count: 5,
        eval_count: 4,
        done_reason: "stop"
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("llama3.2"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from ollama");
    expect(result.usage?.totalTokens).toBe(9);
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createOllama({ fetch: fetchMock as typeof fetch });

    expect(provider("llama3.2")).toMatchObject(provider.languageModel("llama3.2"));
  });

  it("sends last user images as base64 payloads", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "ok" } }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("llava"),
      messages: [
        createTextMessage("assistant", "context"),
        {
          role: "user",
          parts: [
            { type: "text", text: "describe" },
            { type: "image", image: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }
          ]
        }
      ]
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { messages: Array<{ images?: string[] }> };
    expect(body.messages.at(-1)?.images).toEqual(["aGVsbG8="]);
  });

  it("surfaces invalid model errors as validation errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error("model not found"));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("missing"),
        messages: [createTextMessage("user", "hello")]
      })
    ).rejects.toThrow("model not found");
  });

  it("passes provider-specific options through to Ollama", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: { content: "hello from ollama" } }));

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("llama3.2"),
      prompt: "hello",
      providerOptions: {
        keep_alive: "5m",
        raw: true
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { keep_alive: string; raw: boolean };
    expect(body.keep_alive).toBe("5m");
    expect(body.raw).toBe(true);
  });

  it("supports tool calls through the common multi-step loop", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: {
          content: "",
          tool_calls: [
            {
              function: {
                name: "weather",
                arguments: JSON.stringify({ city: "Madrid" })
              }
            }
          ]
        },
        done_reason: "tool_calls"
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { content: "Sunny in Madrid" },
        done_reason: "stop"
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen3"),
      prompt: "weather",
      maxSteps: 2,
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, temperatureC: 26 })
        })
      }
    });

    expect(result.text).toBe("Sunny in Madrid");
    expect(result.toolResults[0]?.toolName).toBe("weather");

    const followupRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const followupBody = JSON.parse(String(followupRequest.body)) as {
      messages: Array<{ role: string; tool_name?: string }>;
    };
    expect(followupBody.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_name: "weather"
    });
  });

  it("supports native structured output through Ollama format", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        message: { content: JSON.stringify({ title: "Soup" }) },
        done_reason: "stop"
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("llama3.2"),
      prompt: "Return JSON",
      schema: z.object({
        title: z.string()
      }),
      mode: "native"
    });

    expect(result.object).toEqual({ title: "Soup" });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { format: Record<string, unknown> };
    expect(body.format).toMatchObject({
      type: "object"
    });
  });

  it("rejects common reasoning config for Ollama", async () => {
    const provider = createOllama({ fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("llama3.2"),
        prompt: "hello",
        reasoning: {
          effort: "low"
        }
      })
    ).rejects.toThrow('Model "ollama/llama3.2" does not support reasoning.');
  });
});
