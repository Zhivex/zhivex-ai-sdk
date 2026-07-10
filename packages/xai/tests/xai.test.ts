import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateObject, generateText, streamText, tool } from "@zhivex-ai/core";
import { runAgentProviderContractSuite } from "../../core/tests/agent-provider-contract.js";
import { runLanguageModelContractSuite } from "../../core/tests/provider-contract.js";
import {
  createXAI,
  xAICodeExecutionTool,
  xAIFilePart,
  xAIFileSearchTool,
  xAIWebSearchTool,
  xAIXSearchTool
} from "../src/index.js";

const responseMessage = (id: string, text: string, usage?: Record<string, unknown>) =>
  Response.json({
    id,
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage
  });

const responseStream = (...events: Record<string, unknown>[]) => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
      );
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

describe("xai adapter", () => {
  const fetchMock = vi.fn();

  runLanguageModelContractSuite({
    providerName: "xai",
    modelId: "grok-4.5",
    createModel: () => createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("grok-4.5"),
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
      fileSearch: true,
      contextCaching: true,
      reasoning: true,
      webSearch: true
    }
  });

  runAgentProviderContractSuite({
    providerName: "xai",
    modelId: "grok-4.5",
    expectedAgentTier: "tier-b",
    createModel: () => createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch })("grok-4.5"),
    mockSimpleRun: () => {
      fetchMock.mockResolvedValueOnce(responseMessage("resp_agent", "hello from grok agent"));
    },
    mockToolRun: () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: "resp_tool",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "tool-1",
              name: "weather",
              arguments: JSON.stringify({ city: "Madrid" })
            }
          ]
        })
      );
      fetchMock.mockResolvedValueOnce(responseMessage("resp_tool_done", "Madrid is sunny"));
    },
    mockStreamRun: () => {
      fetchMock.mockResolvedValueOnce(
        responseStream(
          { type: "response.output_text.delta", delta: "hello" },
          { type: "response.output_text.delta", delta: " grok" },
          { type: "response.completed", response: { id: "resp_stream", status: "completed" } }
        )
      );
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("uses Responses by default with Grok-specific tools, reasoning, and prompt caching", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "web_search_call",
            id: "web_1",
            status: "completed",
            results: [{ title: "xAI", url: "https://x.ai/news", snippet: "Latest release" }]
          },
          { type: "message", content: [{ type: "output_text", text: "grounded" }] }
        ],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 15
        }
      })
    );

    const xai = createXAI({
      apiKey: "test",
      headers: { "x-team": "sdk" },
      fetch: fetchMock as typeof fetch
    });
    const result = await generateText({
      model: xai("grok-4.5"),
      prompt: "Research this",
      reasoning: { effort: "medium" },
      providerOptions: { conversationId: "conv-1" },
      tools: {
        web: xAIWebSearchTool({ allowed_domains: ["x.ai"] }),
        x: xAIXSearchTool({ excluded_x_handles: ["example"] }),
        code: xAICodeExecutionTool(),
        files: xAIFileSearchTool({ vector_store_ids: ["collection-1"], max_num_results: 5 })
      }
    });

    expect(result.text).toBe("grounded");
    expect(result.usage).toMatchObject({ cachedInputTokens: 4, reasoningTokens: 2 });
    expect(result.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: "provider-data", provider: "xai" })
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.x.ai/v1/responses");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: "Bearer test", "x-team": "sdk" });
    const body = JSON.parse(String(init.body)) as {
      prompt_cache_key: string;
      reasoning: { effort: string };
      tools: Array<Record<string, unknown>>;
    };
    expect(body.prompt_cache_key).toBe("conv-1");
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "web_search", filters: { allowed_domains: ["x.ai"] } }),
        expect.objectContaining({ type: "x_search", excluded_x_handles: ["example"] }),
        expect.objectContaining({ type: "code_interpreter" }),
        expect.objectContaining({ type: "file_search", vector_store_ids: ["collection-1"] })
      ])
    );
  });

  it("supports Chat Completions compatibility and x-grok-conv-id", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "chat response" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
      })
    );

    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: xai("grok-4.5"),
      prompt: "hello",
      providerOptions: { apiMode: "chat", conversationId: "chat-1" }
    });

    expect(result.text).toBe("chat response");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.x.ai/v1/chat/completions");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      "x-grok-conv-id": "chat-1"
    });
  });

  it("supports local tool loops and native structured output", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_tool",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "tool-1",
            name: "weather",
            arguments: JSON.stringify({ city: "Madrid" })
          }
        ]
      })
    );
    fetchMock.mockResolvedValueOnce(
      responseMessage("resp_done", JSON.stringify({ city: "Madrid", forecast: "sunny" }))
    );

    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await generateObject({
      model: xai("grok-4.5"),
      prompt: "Use the weather tool and return JSON.",
      maxSteps: 2,
      schema: z.object({ city: z.string(), forecast: z.string() }),
      tools: {
        weather: tool({
          name: "weather",
          schema: z.object({ city: z.string() }),
          execute: ({ city }) => ({ city, forecast: "sunny" })
        })
      },
      mode: "native"
    });

    expect(result.object).toEqual({ city: "Madrid", forecast: "sunny" });
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      text: { format: { type: string; strict: boolean } };
    };
    expect(firstBody.text.format).toMatchObject({ type: "json_schema", strict: true });
  });

  it("preserves Responses conversation state with xAI provider data", async () => {
    fetchMock.mockResolvedValueOnce(responseMessage("resp_1", "first"));
    fetchMock.mockResolvedValueOnce(responseMessage("resp_2", "second"));

    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const first = await generateText({ model: xai("grok-4.5"), prompt: "first" });
    await generateText({
      model: xai("grok-4.5"),
      messages: [
        { role: "user", parts: [{ type: "text", text: "first" }] },
        ...first.messages,
        { role: "user", parts: [{ type: "text", text: "second" }] }
      ]
    });

    expect(first.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: "provider-data", provider: "xai", data: { responseId: "resp_1" } })
    );
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      previous_response_id?: string;
      input: unknown[];
    };
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toHaveLength(1);
  });

  it("preserves encrypted reasoning automatically for stateless Responses calls", async () => {
    fetchMock.mockResolvedValueOnce(responseMessage("resp_stateless", "answer"));
    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await generateText({
      model: xai("grok-4.5"),
      prompt: "reason",
      providerOptions: { store: false, include: ["web_search_call.results"] }
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      include: string[];
      store: boolean;
    };
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["web_search_call.results", "reasoning.encrypted_content"]);
  });

  it("streams text and remaps provider events", async () => {
    fetchMock.mockResolvedValueOnce(
      responseStream(
        { type: "response.output_text.delta", delta: "hello" },
        {
          type: "response.output_item.done",
          item: { type: "web_search_call", id: "web_1", status: "completed" }
        },
        { type: "response.completed", response: { id: "resp_stream", status: "completed" } }
      )
    );

    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = streamText({
      model: xai("grok-4.5"),
      prompt: "hello",
      tools: { web: xAIWebSearchTool() }
    });
    const collected = await result.collect();

    expect(collected.text).toBe("hello");
    expect(collected.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: "provider-data", provider: "xai" })
    );
  });

  it("routes uploaded file IDs through Responses and supports the Files API", async () => {
    fetchMock.mockResolvedValueOnce(responseMessage("resp_file", "read file"));
    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await generateText({
      model: xai("grok-4.5"),
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "Read this" }, xAIFilePart("file_abc123", "application/pdf", "doc.pdf")]
        }
      ]
    });
    const responseBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(responseBody.input[0]?.content[1]).toMatchObject({ type: "input_file", file_id: "file_abc123" });

    fetchMock.mockResolvedValueOnce(Response.json({ id: "file_abc123", filename: "doc.pdf", bytes: 12 }));
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ id: "file_abc123", filename: "doc.pdf" }], pagination_token: "next-page" })
    );
    fetchMock.mockResolvedValueOnce(Response.json({ id: "file_abc123", filename: "doc.pdf" }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "file_abc123", deleted: true }));

    const uploaded = await xai.files.upload({
      data: Buffer.from("pdf").toString("base64"),
      mediaType: "application/pdf",
      filename: "doc.pdf",
      providerOptions: { purpose: "assistants", expires_after: 3600 }
    });
    const listed = await xai.files.list({
      pageSize: 20,
      pageToken: "cursor",
      providerOptions: { order: "desc", sort_by: "created_at", filter: 'content_type = "pdf"' }
    });
    const fetched = await xai.files.get({ name: "file_abc123" });
    const deleted = await xai.files.delete({ name: "file_abc123" });

    expect(uploaded.name).toBe("file_abc123");
    expect(listed.nextPageToken).toBe("next-page");
    expect(fetched.name).toBe("file_abc123");
    expect(deleted.name).toBe("file_abc123");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "limit=20&pagination_token=cursor&order=desc&sort_by=created_at&filter=content_type+%3D+%22pdf%22"
    );

    const uploadBody = (fetchMock.mock.calls[1]?.[1] as RequestInit).body as FormData;
    expect([...uploadBody.keys()]).toEqual(["expires_after", "purpose", "file"]);
  });

  it("grounds text with Web Search and returns unique sources", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_grounded",
        status: "completed",
        output: [
          {
            type: "web_search_call",
            results: [
              { title: "Release", url: "https://x.ai/news/grok-4-5", snippet: "Grok 4.5" },
              { title: "Release", url: "https://x.ai/news/grok-4-5", snippet: "duplicate" }
            ]
          },
          { type: "message", content: [{ type: "output_text", text: "answer" }] }
        ]
      })
    );

    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    const result = await xai.groundedLanguageModel!("grok-4.5").generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "latest release" }] }]
    });

    expect(result.text).toBe("answer");
    expect(result.sources).toEqual([
      expect.objectContaining({ title: "Release", url: "https://x.ai/news/grok-4-5" })
    ]);
  });

  it("rejects unsupported Grok 4.5 reasoning controls before sending", async () => {
    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(
      generateText({ model: xai("grok-4.5"), prompt: "hello", reasoning: { effort: "none" } })
    ).rejects.toThrow('does not support reasoning effort "none"');
    await expect(
      generateText({ model: xai("grok-4.5"), prompt: "hello", reasoning: { budgetTokens: 128 } })
    ).rejects.toThrow('does not support "reasoning.budgetTokens"');
    await expect(
      generateText({
        model: xai("grok-4.5"),
        prompt: "hello",
        providerOptions: { stop: ["done"] }
      })
    ).rejects.toThrow("does not support presence_penalty, frequency_penalty, or stop");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid hosted-tool and file configurations before sending", async () => {
    expect(() =>
      xAIWebSearchTool({ allowed_domains: ["x.ai"], excluded_domains: ["example.com"] })
    ).toThrow("cannot combine allowed_domains with excluded_domains");

    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    await expect(
      generateText({
        model: xai("grok-4.5"),
        prompt: "search",
        providerOptions: { apiMode: "chat" },
        tools: { web: xAIWebSearchTool() }
      })
    ).rejects.toThrow("supports hosted tools through the Responses API only");
    await expect(
      xai.files.upload({
        data: "ZmlsZQ==",
        mediaType: "text/plain",
        providerOptions: { expires_after: 60 }
      })
    ).rejects.toThrow("between 3600 and 2592000 seconds");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns xAI-specific HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("invalid request", { status: 400 }));
    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });

    await expect(generateText({ model: xai("grok-4.5"), prompt: "hello" })).rejects.toThrow(
      "xAI request failed with status 400."
    );
  });

  it("creates equivalent language models from the callable provider", () => {
    const xai = createXAI({ apiKey: "test", fetch: fetchMock as typeof fetch });
    expect(xai("grok-4.5")).toMatchObject(xai.languageModel("grok-4.5"));
  });
});
