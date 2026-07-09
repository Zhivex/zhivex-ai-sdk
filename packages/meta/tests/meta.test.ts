import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createMeta, metaFilePart, metaWebSearchTool } from "../src/index.js";

describe("meta adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "meta",
    modelId: "muse-spark-1.1",
    createModel: () => createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch })("muse-spark-1.1"),
    expectedAgentTier: "tier-b",
    expectedCapabilities: {
      streaming: true,
      tools: true,
      structuredOutput: true,
      jsonMode: true,
      toolChoice: true,
      parallelToolCalls: true,
      vision: true,
      files: true,
      audioInput: false,
      audioOutput: false,
      embeddings: false,
      reasoning: true,
      webSearch: true
    }
  });

  runAgentProviderContractSuite({
    providerName: "meta",
    modelId: "muse-spark-1.1",
    expectedAgentTier: "tier-b",
    createModel: () => createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch })("muse-spark-1.1"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "hello from meta agent" } }]
        })
      );
    },
    mockToolRun: () => {
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
          choices: [{ finish_reason: "stop", message: { content: "Madrid is sunny" } }]
        })
      );
    },
    mockStreamRun: () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\" meta\"},\"finish_reason\":\"stop\"}]}\n\n" +
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
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("maps chat completions to the common contract", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "hello from meta" } }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("muse-spark-1.1"),
      prompt: "hello"
    });

    expect(result.text).toBe("hello from meta");
    expect(result.usage?.totalTokens).toBe(7);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.meta.ai/v1/chat/completions");

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.headers).toMatchObject({ authorization: "Bearer test" });
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("muse-spark-1.1")).toMatchObject(provider.languageModel("muse-spark-1.1"));
  });

  it("streams incremental chat text", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n" +
              "data: {\"choices\":[{\"delta\":{\"content\":\" spark\"},\"finish_reason\":\"stop\"}]}\n\n" +
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

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("muse-spark-1.1"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello spark");
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

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: provider("muse-spark-1.1"),
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

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      response_format: { type: string; json_schema: { strict: boolean } };
    };
    expect(firstBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true }
    });
  });

  it("routes hosted tools through Responses API and maps reasoning correctly", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            results: [{ type: "text_result", title: "Source", url: "https://example.com", snippet: "Example" }]
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "grounded" }]
          }
        ],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 }
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("muse-spark-1.1"),
      prompt: "Search this",
      reasoning: { effort: "medium" },
      tools: {
        webSearch: metaWebSearchTool({ search_context_size: "low" })
      }
    });

    expect(result.text).toBe("grounded");
    expect(result.messages.at(-1)?.parts.some((part) => part.type === "provider-data" && part.provider === "meta")).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.meta.ai/v1/responses");

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      reasoning: { effort: string };
      tools: Array<{ type: string; search_context_size?: string }>;
      reasoning_effort?: string;
    };
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.tools[0]).toMatchObject({ type: "web_search", search_context_size: "low" });
  });

  it("continues Responses conversations with previous_response_id", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "first" }] }]
      })
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_2",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "second" }] }]
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const first = await generateText({
      model: provider("muse-spark-1.1"),
      prompt: "first",
      providerOptions: { apiMode: "responses" }
    });

    await generateText({
      model: provider("muse-spark-1.1"),
      messages: [
        { role: "user", parts: [{ type: "text", text: "first" }] },
        ...first.messages,
        { role: "user", parts: [{ type: "text", text: "second" }] }
      ],
      providerOptions: { apiMode: "responses" }
    });

    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      previous_response_id?: string;
      input: Array<{ role?: string }>;
    };
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toHaveLength(1);
    expect(secondBody.input[0]?.role).toBe("user");
  });

  it("routes file parts through Responses API", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "read file" }] }]
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await generateText({
      model: provider("muse-spark-1.1"),
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "Read this" }, metaFilePart("file-abc123", "application/pdf", "doc.pdf")]
        }
      ]
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.meta.ai/v1/responses");
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      input: Array<{ content: Array<{ type: string; file_id?: string }> }>;
    };
    expect(body.input[0]?.content[1]).toEqual({ type: "input_file", file_id: "file-abc123" });
  });

  it("supports the Files API", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: "file-abc123", filename: "doc.pdf", bytes: 12, mime_type: "application/pdf" }));
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: "file-abc123", filename: "doc.pdf" }], next: "next-page" }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "file-abc123", filename: "doc.pdf" }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "file-abc123", deleted: true }));

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const uploaded = await provider.files!.upload({
      data: Buffer.from("pdf").toString("base64"),
      mediaType: "application/pdf",
      filename: "doc.pdf"
    });
    const listed = await provider.files!.list({ pageSize: 20, pageToken: "cursor" });
    const fetched = await provider.files!.get({ name: "file-abc123" });
    const deleted = await provider.files!.delete({ name: "file-abc123" });

    expect(uploaded).toMatchObject({ name: "file-abc123", mimeType: "application/pdf" });
    expect(listed.nextPageToken).toBe("next-page");
    expect(fetched.name).toBe("file-abc123");
    expect(deleted.name).toBe("file-abc123");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.meta.ai/v1/files?limit=20&after=cursor");

    const uploadBody = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as FormData;
    expect(uploadBody.get("purpose")).toBe("user_data");
  });

  it("rejects unsupported reasoning fields before sending", async () => {
    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("muse-spark-1.1"),
        prompt: "hello",
        reasoning: { effort: "none" }
      })
    ).rejects.toThrow('Provider "meta" does not support "reasoning.effort=none".');

    await expect(
      generateText({
        model: provider("muse-spark-1.1"),
        prompt: "hello",
        reasoning: { budgetTokens: 128 }
      })
    ).rejects.toThrow('Provider "meta" does not support "reasoning.budgetTokens".');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
