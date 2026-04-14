import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTextMessage, embed, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createQwen } from "../src/index.js";

describe("qwen adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "qwen",
    modelId: "qwen-plus",
    createModel: () => createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch })("qwen-plus"),
    createEmbeddingModel: () =>
      createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch }).embeddingModel("text-embedding-v4"),
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
      reasoning: false,
      webSearch: false
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps chat completions to the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from qwen" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("qwen-plus"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from qwen");
    expect(result.usage?.totalTokens).toBe(7);
    expect(result.messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: "hello from qwen" });
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("qwen-plus")).toMatchObject(provider.languageModel("qwen-plus"));
  });

  it("streams incremental text", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}\n\n" +
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

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("qwen-plus"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello world");
  });

  it("supports tool calls and native structured output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "tool-1",
                  function: {
                    name: "weather",
                    arguments: JSON.stringify({ city: "Madrid" })
                  }
                }
              ]
            }
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ city: "Madrid", forecast: "sunny" }) }
          }
        ]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("qwen-plus"),
      messages: [createTextMessage("user", "Use weather tool and return JSON.")],
      maxSteps: 2,
      schema: z.object({
        city: z.string(),
        forecast: z.string()
      }),
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      },
      mode: "native"
    });

    expect(result.object.forecast).toBe("sunny");
    expect(result.objectMode).toBe("native");
    expect(result.toolResults[0]?.toolName).toBe("weather");
  });

  it("embeds values", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await embed({
      model: provider.embeddingModel("text-embedding-v4"),
      value: "hello"
    });

    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("passes provider-specific options through to the Qwen API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from qwen" } }]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("qwen-plus"),
      prompt: "hello",
      providerOptions: {
        top_p: 0.8,
        user: "test-user"
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { top_p: number; user: string };
    expect(body.top_p).toBe(0.8);
    expect(body.user).toBe("test-user");
  });

  it("maps common tool choice to Qwen tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from qwen" } }]
      })
    );

    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("qwen-plus"),
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

  it("rejects common reasoning config for Qwen through the shared capabilities contract", async () => {
    const provider = createQwen({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("qwen-plus"),
        prompt: "hello",
        reasoning: {
          effort: "medium"
        }
      })
    ).rejects.toThrow('Model "qwen/qwen-plus" does not support reasoning.');
  });
});
