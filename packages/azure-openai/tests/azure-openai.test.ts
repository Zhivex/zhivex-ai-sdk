import { beforeEach, describe, expect, it, vi } from "vitest";

import { embed, generateText, streamText } from "@zhivex-ai/core";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createAzureOpenAI } from "../src/index.js";

describe("azure openai adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "azure-openai",
    modelId: "gpt-4o-mini",
    createModel: () =>
      createAzureOpenAI({
        apiKey: "test",
        endpoint: "https://example.openai.azure.com",
        fetch: fetchMock as typeof fetch
      })("gpt-4o-mini"),
    createEmbeddingModel: () =>
      createAzureOpenAI({
        apiKey: "test",
        endpoint: "https://example.openai.azure.com",
        fetch: fetchMock as typeof fetch
      }).embeddingModel("text-embedding-3-small"),
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: true,
      parallelToolCalls: true,
      vision: true,
      files: false,
      audioInput: false,
      audioOutput: false,
      embeddings: true,
      reasoning: true,
      webSearch: false
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps chat completions to the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from azure" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateText({
      model: provider("gpt-4o-mini"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from azure");
    expect(result.usage?.totalTokens).toBe(7);
  });

  it("streams incremental text", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" azure\"},\"finish_reason\":\"stop\"}]}\n\n" +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });

    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = streamText({
      model: provider("gpt-4o-mini"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello azure");
  });

  it("embeds values", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }]
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await embed({
      model: provider.embeddingModel("text-embedding-3-small"),
      value: "hello"
    });

    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("maps common reasoning config to Azure OpenAI request fields", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "reasoned" } }]
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("gpt-5"),
      prompt: "hello",
      maxTokens: 256,
      reasoning: {
        effort: "high"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      reasoning_effort: string;
      max_completion_tokens: number;
      max_tokens?: number;
    };
    expect(body.reasoning_effort).toBe("high");
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
  });

  it("rejects unsupported reasoning budget tokens for Azure OpenAI", async () => {
    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });

    await expect(
      generateText({
        model: provider("gpt-5"),
        prompt: "hello",
        reasoning: {
          budgetTokens: 256
        }
      })
    ).rejects.toThrow('Provider "azure-openai" does not support "reasoning.budgetTokens".');
  });
});
