import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTextMessage, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createKimi } from "../src/index.js";

describe("kimi adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "kimi",
    modelId: "kimi-k2-0905-preview",
    createModel: () => createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch })("kimi-k2-0905-preview"),
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
      embeddings: false,
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
        choices: [{ finish_reason: "stop", message: { content: "hello from kimi" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("kimi-k2-0905-preview"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from kimi");
    expect(result.usage?.totalTokens).toBe(7);
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("kimi-k2-0905-preview")).toMatchObject(provider.languageModel("kimi-k2-0905-preview"));
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

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("kimi-k2-0905-preview"),
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

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("kimi-k2-0905-preview"),
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
  });

  it("passes provider-specific options through to the Kimi API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from kimi" } }]
      })
    );

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("kimi-k2-0905-preview"),
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

  it("maps common tool choice to Kimi tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from kimi" } }]
      })
    );

    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("kimi-k2-0905-preview"),
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

  it("rejects common reasoning config for Kimi until it is mapped", async () => {
    const provider = createKimi({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("kimi-k2-0905-preview"),
        prompt: "hello",
        reasoning: {
          effort: "medium"
        }
      })
    ).rejects.toThrow('Provider "kimi" does not support the common "reasoning" config yet.');
  });
});
