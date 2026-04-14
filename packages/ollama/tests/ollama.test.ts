import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTextMessage, embed, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createOllama } from "../src/index.ts";

describe("ollama adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "ollama",
    modelId: "llama3.2",
    createModel: () => createOllama({ fetch: fetchMock as typeof fetch })("llama3.2"),
    createEmbeddingModel: () => createOllama({ fetch: fetchMock as typeof fetch }).embeddingModel("embeddinggemma"),
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: false,
      parallelToolCalls: true,
      vision: true,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: true,
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

  it("streams incremental text through the common streaming contract", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ message: { content: "hello" }, done: false })}\n` +
              `${JSON.stringify({
                message: { content: " world" },
                done: true,
                done_reason: "stop",
                prompt_eval_count: 5,
                eval_count: 4
              })}\n`
          )
        );
        controller.close();
      }
    });

    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" }
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("llama3.2"),
      prompt: "hello"
    });

    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    const final = await result.collect();
    expect(chunks.join("")).toBe("hello world");
    expect(final.text).toBe("hello world");
    expect(final.usage?.totalTokens).toBe(9);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(String(requestInit.body)) as { stream: boolean };
    expect(requestBody.stream).toBe(true);
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

  it("embeds values through the Ollama embed endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        embeddings: [[0.1, 0.2, 0.3]],
        prompt_eval_count: 8
      })
    );

    const provider = createOllama({ fetch: fetchMock as typeof fetch });
    const result = await embed({
      model: provider.embeddingModel("embeddinggemma"),
      value: "hello"
    });

    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.usage?.totalTokens).toBe(8);

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { model: string; input: string[] };
    expect(body.model).toBe("embeddinggemma");
    expect(body.input).toEqual(["hello"]);
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
