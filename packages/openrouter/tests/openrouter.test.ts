import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createOpenRouter } from "../src/index.js";

describe("openrouter adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "openrouter",
    modelId: "openai/gpt-4o-mini",
    createModel: () => createOpenRouter({ apiKey: "test", fetch: fetchMock as typeof fetch })("openai/gpt-4o-mini"),
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
        choices: [{ finish_reason: "stop", message: { content: "hello from openrouter" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createOpenRouter({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("openai/gpt-4o-mini"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from openrouter");
    expect(result.usage?.totalTokens).toBe(7);
  });

  it("streams incremental text", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" router\"},\"finish_reason\":\"stop\"}]}\n\n" +
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

    const provider = createOpenRouter({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("openai/gpt-4o-mini"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello router");
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

    const provider = createOpenRouter({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("openai/gpt-4o-mini"),
      prompt: "Use weather tool and return JSON.",
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
    expect(result.toolResults[0]?.toolName).toBe("weather");
  });

  it("maps common reasoning config to OpenRouter reasoning fields", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "reasoned" } }]
      })
    );

    const provider = createOpenRouter({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("openai/gpt-4o-mini"),
      prompt: "hello",
      reasoning: {
        effort: "medium",
        budgetTokens: 512
      }
    });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      reasoning: { effort: string; max_tokens: number };
    };
    expect(body.reasoning).toEqual({
      effort: "medium",
      max_tokens: 512
    });
  });

  it("maps common tool choice to OpenRouter tool_choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from openrouter" } }]
      })
    );

    const provider = createOpenRouter({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("openai/gpt-4o-mini"),
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
});
