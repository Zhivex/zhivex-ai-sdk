import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateText, hostedTool, ProviderHTTPError, streamText, tool, UnsupportedFeatureError, type StreamEvent } from "@zhivex-ai/core";
import { createBedrock } from "../src/index.js";

const modelFor = (fetcher: typeof fetch) =>
  createBedrock({
    runtime: "openai",
    apiKey: "test",
    baseURL: "https://bedrock-mantle.example.com/openai/v1",
    fetch: fetcher
  })("openai.gpt-oss-120b-1:0");

const sse = (chunks: Array<{ event?: string; data: unknown }>, done = true) =>
  chunks
    .map((chunk) => `${chunk.event ? `event: ${chunk.event}\n` : ""}data: ${typeof chunk.data === "string" ? chunk.data : JSON.stringify(chunk.data)}\n\n`)
    .join("") + (done ? "data: [DONE]\n\n" : "");

const requestBody = (fetcher: ReturnType<typeof vi.fn>) =>
  JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;

describe("Bedrock OpenAI-compatible Mantle runtime", () => {
  it("rejects HTTP 401 and 403 streams instead of completing them empty", async () => {
    for (const status of [401, 403, 500]) {
      const fetcher = vi.fn(async () => new Response("denied", {
        status,
        headers: { "content-type": "text/event-stream" }
      }));
      const model = modelFor(fetcher);
      const events: StreamEvent[] = [];
      await expect((async () => {
        for await (const event of await model.stream!({
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
          maxRetries: 0
        })) events.push(event);
      })()).rejects.toMatchObject({ name: "ProviderHTTPError", status });
      expect(events).toEqual([]);
      expect(fetcher).toHaveBeenCalledOnce();

      const streamed = streamText({ model, prompt: "hi", maxRetries: 0 });
      const chunks: string[] = [];
      for await (const chunk of streamed.textStream) chunks.push(chunk);
      await expect(streamed.collect()).rejects.toMatchObject({ name: "ProviderHTTPError", status });
      expect(chunks).toEqual([]);
    }
  });

  it("rejects a 401 body that looks like a completed SSE response", async () => {
    const fetcher = vi.fn(async () => new Response(
      sse([{ data: { type: "response.completed", response: { status: "completed", output: [] } } }]),
      { status: 401, headers: { "content-type": "text/event-stream" } }
    ));
    const model = modelFor(fetcher);
    await expect(streamText({ model, prompt: "hi", maxRetries: 0 }).collect()).rejects.toBeInstanceOf(ProviderHTTPError);
    await expect(streamText({ model, prompt: "hi", maxRetries: 0 }).collect()).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a nested Mantle error even when a later event looks completed", async () => {
    const fetcher = vi.fn(async () => new Response(sse([
      { data: { error: { message: "Forbidden", type: "permission_error", code: 403 } } },
      { data: { type: "response.completed", response: { status: "completed", output: [] } } }
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const model = modelFor(fetcher);
    const events: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of await model.stream!({
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        maxRetries: 0
      })) events.push(event);
    })()).rejects.toMatchObject({ status: 403 });
    expect(events.some((event) => event.type === "finish")).toBe(false);
  });

  it("rejects an SSE error event that carries HTTP 401", async () => {
    const fetcher = vi.fn(async () => new Response(sse([
      { event: "error", data: { message: "Unauthorized", status: 401 } }
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    await expect(streamText({
      model: modelFor(fetcher),
      prompt: "hi",
      maxRetries: 0
    }).collect()).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a completed terminal event that still reports an authentication failure", async () => {
    const fetcher = vi.fn(async () => new Response(sse([
      {
        data: {
          type: "response.completed",
          response: { status: "completed", error: { message: "bad key", code: "invalid_api_key" } }
        }
      }
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const streamed = streamText({ model: modelFor(fetcher), prompt: "hi", maxRetries: 0 });
    await expect(streamed.collect()).rejects.toMatchObject({ name: "ProviderHTTPError", status: 401 });
  });

  it("sends Responses tool_choice and does not drop input.reasoning", async () => {
    const fetcher = vi.fn(async () => Response.json({
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
    }));
    const model = modelFor(fetcher);
    await model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "weather" }] }],
      tools: {
        weather: tool({
          name: "weather",
          description: "Look up weather",
          schema: z.object({ city: z.string() }),
          execute: async () => ({ ok: true })
        })
      },
      toolChoice: { type: "tool", toolName: "weather" },
      reasoning: { effort: "low", includeThoughts: true },
      providerOptions: { reasoning: { summary: "concise" } },
      maxRetries: 0
    });
    expect(requestBody(fetcher)).toMatchObject({
      tool_choice: { type: "function", name: "weather" },
      reasoning: { effort: "low", summary: "auto" },
      stream: false
    });
    expect(requestBody(fetcher).tool_choice).not.toHaveProperty("function");

    fetcher.mockClear();
    fetcher.mockResolvedValueOnce(new Response(sse([
      { data: { type: "response.output_text.delta", delta: "ok" } },
      { data: { type: "response.completed", response: { status: "completed" } } }
    ])));
    const events: StreamEvent[] = [];
    for await (const event of await model.stream!({
      messages: [{ role: "user", parts: [{ type: "text", text: "think" }] }],
      reasoning: { effort: "high" },
      toolChoice: "required",
      maxRetries: 0
    })) events.push(event);
    expect(requestBody(fetcher)).toMatchObject({
      tool_choice: "required",
      reasoning: { effort: "high" },
      stream: true
    });
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("accepts advertised reasoning effort, mode, and context through generateText and streamText", async () => {
    const fetcher = vi.fn(async () => Response.json({
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
    }));
    const model = modelFor(fetcher);
    expect(model.capabilities.reasoningEfforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(model.capabilities.reasoningModes).toEqual(["standard", "pro"]);
    expect(model.capabilities.reasoningContexts).toEqual(["auto", "current_turn", "all_turns"]);

    await generateText({
      model,
      prompt: "hi",
      reasoning: { effort: "max", mode: "pro", context: "all_turns" }
    });
    expect(requestBody(fetcher).reasoning).toEqual({
      effort: "max",
      mode: "pro",
      context: "all_turns"
    });

    fetcher.mockResolvedValueOnce(new Response(sse([
      { data: { type: "response.output_text.delta", delta: "ok" } },
      { data: { type: "response.completed", response: { status: "completed" } } }
    ])));
    await streamText({
      model,
      prompt: "hi",
      reasoning: { effort: "max", mode: "standard", context: "current_turn" }
    }).collect();
    const streamed = JSON.parse(String((fetcher.mock.calls[1]?.[1] as RequestInit).body)) as {
      reasoning?: Record<string, unknown>;
    };
    expect(streamed.reasoning).toEqual({
      effort: "max",
      mode: "standard",
      context: "current_turn"
    });
  });

  it("keeps providerOptions.reasoning when input.reasoning is omitted and rejects budget tokens", async () => {
    const fetcher = vi.fn(async () => Response.json({
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
    }));
    const model = modelFor(fetcher);
    await model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      providerOptions: { reasoning: { effort: "medium" } },
      maxRetries: 0
    });
    expect(requestBody(fetcher).reasoning).toEqual({ effort: "medium" });

    await expect(model.generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      reasoning: { budgetTokens: 1024 },
      maxRetries: 0
    })).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it("rejects a code_interpreter hosted tool before the request", async () => {
    const fetcher = vi.fn();
    await expect(modelFor(fetcher).generate({
      messages: [{ role: "user", parts: [{ type: "text", text: "run" }] }],
      tools: {
        code: hostedTool({
          name: "code_interpreter",
          provider: "bedrock",
          type: "code_interpreter",
          toolClass: "code-execution",
          config: { container: { type: "auto" } }
        })
      },
      maxRetries: 0
    })).rejects.toThrow(/does not support code execution/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
