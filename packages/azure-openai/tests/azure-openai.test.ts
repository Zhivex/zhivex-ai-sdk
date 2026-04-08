import { beforeEach, describe, expect, it, vi } from "vitest";

import { embed, generateGroundedText, generateSpeech, generateText, streamText, tool, transcribeAudio } from "@zhivex-ai/core";
import { z } from "zod";
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

  it("maps common tool choice to Azure OpenAI tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from azure" } }]
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    await generateText({
      model: provider("gpt-4o-mini"),
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
      tool_choice: { type: string; function: { name: string } };
    };
    expect(body.tool_choice).toEqual({
      type: "function",
      function: {
        name: "weather"
      }
    });
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

  it("transcribes audio through the shared contract", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ text: "hello from azure audio" }));

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await transcribeAudio({
      model: provider.transcriptionModel!("gpt-4o-mini-transcribe"),
      audio: {
        data: "aGVsbG8=",
        mediaType: "audio/wav"
      }
    });

    expect(result.text).toBe("hello from azure audio");
  });

  it("generates speech through the shared contract", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" }
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateSpeech({
      model: provider.speechModel!("gpt-4o-mini-tts"),
      input: "hello azure"
    });

    expect(Array.from(result.audio)).toEqual([4, 5, 6]);
  });

  it("generates grounded text with sources", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: "completed",
        output_text: "fresh azure answer",
        output: [{ content: [{ annotations: [{ title: "Azure Source", url: "https://example.com/azure" }] }] }]
      })
    );

    const provider = createAzureOpenAI({
      apiKey: "test",
      endpoint: "https://example.openai.azure.com",
      fetch: fetchMock as typeof fetch
    });
    const result = await generateGroundedText({
      model: provider.groundedLanguageModel!("gpt-4o-search-preview"),
      prompt: "What happened today?"
    });

    expect(result.text).toBe("fresh azure answer");
    expect(result.sources[0]?.url).toBe("https://example.com/azure");
  });
});
