import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { audioPart, generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import { createMeta, metaFilePart, metaToolSearchTool, metaWebSearchTool } from "../src/index.js";

describe("meta adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "meta",
    modelId: "muse-spark-1.2",
    createModel: () => createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch })("muse-spark-1.2"),
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
      audioInput: true,
      audioOutput: false,
      embeddings: false,
      reasoning: true,
      webSearch: true
    }
  });

  runAgentProviderContractSuite({
    providerName: "meta",
    modelId: "muse-spark-1.2",
    expectedAgentTier: "tier-b",
    createModel: () => createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch })("muse-spark-1.2"),
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
      model: provider("muse-spark-1.2"),
      prompt: "hello",
      providerOptions: {
        prompt_cache_key: "stable-chat-prefix",
        prompt_cache_retention: "24h"
      }
    });

    expect(result.text).toBe("hello from meta");
    expect(result.usage?.totalTokens).toBe(7);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.meta.ai/v1/chat/completions");

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(requestInit.headers).toMatchObject({ authorization: "Bearer test" });
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: "muse-spark-1.2",
      prompt_cache_key: "stable-chat-prefix",
      prompt_cache_retention: "24h"
    });
  });

  it("creates equivalent language models from the callable provider", () => {
    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });

    expect(provider("muse-spark-1.2")).toMatchObject(provider.languageModel("muse-spark-1.2"));
  });

  it("maps MP3 and WAV AudioPart input to Chat Completions", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "transcribed" } }]
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("muse-spark-1.2"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Transcribe this." },
            audioPart({ data: new Uint8Array([1, 2, 3]), mediaType: "audio/wav" }),
            audioPart({ data: "data:audio/mpeg;base64,BAUG", mediaType: "audio/mpeg" })
          ]
        }
      ]
    });

    expect(result.text).toBe("transcribed");
    expect(provider("muse-spark-1.2").capabilities.audioInput).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "Transcribe this." },
      { type: "input_audio", input_audio: { data: "AQID", format: "wav" } },
      { type: "input_audio", input_audio: { data: "BAUG", format: "mp3" } }
    ]);
  });

  it("maps inline, data-URL, and uploaded-file AudioPart input to Responses", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_audio",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "heard" }] }]
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("muse-spark-1.2"),
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Compare these recordings." },
            audioPart({ data: new Uint8Array([1, 2, 3]), mediaType: "audio/wav" }),
            audioPart({ data: "data:audio/mpeg;base64,BAUG", mediaType: "audio/mpeg" }),
            audioPart({ data: "file-audio123", mediaType: "audio/wav" })
          ]
        }
      ],
      providerOptions: { apiMode: "responses" }
    });

    expect(result.text).toBe("heard");
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.input[0]?.content).toEqual([
      { type: "input_text", text: "Compare these recordings." },
      { type: "input_audio", input_audio: { data: "AQID", format: "wav" } },
      { type: "input_audio", audio_url: "data:audio/mpeg;base64,BAUG" },
      { type: "input_audio", file_id: "file-audio123" }
    ]);
  });

  it("rejects unsupported AudioPart formats before sending", async () => {
    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("muse-spark-1.2"),
        messages: [
          {
            role: "user",
            parts: [audioPart({ data: new Uint8Array([1, 2, 3]), mediaType: "audio/ogg" })]
          }
        ]
      })
    ).rejects.toThrow('supports AudioPart input only as MP3 or WAV, received "audio/ogg"');

    expect(fetchMock).not.toHaveBeenCalled();
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
      model: provider("muse-spark-1.2"),
      prompt: "hello"
    });

    expect((await result.collect()).text).toBe("hello spark");
  });

  it("retries retryable HTTP responses before parsing JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "recovered" } }]
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: provider("muse-spark-1.2"),
      prompt: "hello",
      maxRetries: 1,
      retryBackoffMs: 0
    });

    expect(result.text).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries retryable Responses HTTP statuses before consuming an SSE stream", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"recovered\"}\n\n" +
              "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_retry\",\"status\":\"completed\"}}\n\n" +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    fetchMock.mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }));
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("muse-spark-1.2"),
      prompt: "hello",
      providerOptions: { apiMode: "responses" },
      maxRetries: 1,
      retryBackoffMs: 0
    });

    expect((await result.collect()).text).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("streams Responses tool calls and continues with previous_response_id", async () => {
    const firstBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"item_1\",\"call_id\":\"call_1\",\"name\":\"weather\",\"arguments\":\"\"}}\n\n" +
              "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item_1\",\"delta\":\"{\\\"city\\\":\\\"Mad\"}\n\n" +
              "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"item_1\",\"delta\":\"rid\\\"}\"}\n\n" +
              "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"item_1\",\"arguments\":\"{\\\"city\\\":\\\"Madrid\\\"}\"}\n\n" +
              "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2,\"total_tokens\":6}}}\n\n" +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });
    const secondBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Madrid \"}\n\n" +
              "data: {\"type\":\"response.output_text.delta\",\"delta\":\"is sunny.\"}\n\n" +
              "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\",\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n" +
              "data: [DONE]\n\n"
          )
        );
        controller.close();
      }
    });

    fetchMock.mockResolvedValueOnce(
      new Response(firstBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(secondBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: provider("muse-spark-1.2"),
      prompt: "Use web search if needed, then weather.",
      maxSteps: 2,
      tools: {
        web: metaWebSearchTool(),
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      }
    });

    expect((await result.collect()).text).toBe("Madrid is sunny.");

    const firstRequest = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { stream: boolean };
    expect(firstRequest.stream).toBe(true);

    const secondRequest = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      previous_response_id?: string;
      input: Array<Record<string, unknown>>;
    };
    expect(secondRequest.previous_response_id).toBe("resp_1");
    expect(secondRequest.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify({ city: "Madrid", forecast: "sunny" })
      }
    ]);
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
      model: provider("muse-spark-1.2"),
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

  it("accepts only Meta's auto tool choice", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "no tool needed" } }]
      })
    );

    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const sum = tool({
      name: "sum",
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => a + b
    });

    await generateText({
      model: provider("muse-spark-1.2"),
      prompt: "Use a tool if needed.",
      tools: { sum },
      toolChoice: "auto"
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      tool_choice?: string;
    };
    expect(body.tool_choice).toBe("auto");
    expect(provider("muse-spark-1.2").capabilities.agentCapabilities?.toolChoiceNone).toBe(false);

    await expect(
      generateText({
        model: provider("muse-spark-1.2"),
        prompt: "Do not use tools.",
        tools: { sum },
        toolChoice: "none"
      })
    ).rejects.toThrow('supports only toolChoice "auto"');
    await expect(
      generateText({
        model: provider("muse-spark-1.2"),
        prompt: "Require a tool.",
        tools: { sum },
        toolChoice: "required"
      })
    ).rejects.toThrow('supports only toolChoice "auto"');
    await expect(
      generateText({
        model: provider("muse-spark-1.2"),
        prompt: "Call sum.",
        tools: { sum },
        toolChoice: { type: "tool", toolName: "sum" }
      })
    ).rejects.toThrow('supports only toolChoice "auto"');

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      model: provider("muse-spark-1.2"),
      prompt: "Search this",
      reasoning: { effort: "medium" },
      tools: {
        webSearch: metaWebSearchTool({ search_context_size: "low" }),
        toolSearch: metaToolSearchTool({
          execution: "client",
          description: "Find a tool by name.",
          parameters: { type: "object", properties: { query: { type: "string" } } }
        })
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
    expect(body.tools).toEqual([
      { type: "web_search", search_context_size: "low" },
      {
        type: "tool_search",
        execution: "client",
        description: "Find a tool by name.",
        parameters: { type: "object", properties: { query: { type: "string" } } }
      }
    ]);
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
      model: provider("muse-spark-1.2"),
      prompt: "first",
      providerOptions: { apiMode: "responses" }
    });

    await generateText({
      model: provider("muse-spark-1.2"),
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
      model: provider("muse-spark-1.2"),
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
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("rejects path-like Meta file IDs before sending credentials", async () => {
    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(provider.files!.get({ name: "../secret" })).rejects.toThrow(
      "must be a non-empty opaque identifier"
    );
    await expect(provider.files!.delete({ name: "files/secret" })).rejects.toThrow(
      "must be a non-empty opaque identifier"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported reasoning fields before sending", async () => {
    const provider = createMeta({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({
        model: provider("muse-spark-1.2"),
        prompt: "hello",
        reasoning: { effort: "none" }
      })
    ).rejects.toThrow('Provider "meta" does not support "reasoning.effort=none".');

    await expect(
      generateText({
        model: provider("muse-spark-1.2"),
        prompt: "hello",
        reasoning: { budgetTokens: 128 }
      })
    ).rejects.toThrow('Provider "meta" does not support "reasoning.budgetTokens".');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
