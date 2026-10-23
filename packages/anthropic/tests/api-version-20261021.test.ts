import { describe, expect, it, vi } from "vitest";

import { UnsupportedFeatureError, providerDataPart, type ModelGenerateInput } from "@zhivex-ai/core";
import { createAnthropic, createAnthropicMessagesModel } from "../src/index.js";

const response = () =>
  Response.json({
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 }
  });

const prompt = (text = "Hello"): ModelGenerateInput => ({
  messages: [{ role: "user", parts: [{ type: "text", text }] }]
});

const headersOf = (fetcher: ReturnType<typeof vi.fn>) =>
  (fetcher.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;

const bodyOf = (fetcher: ReturnType<typeof vi.fn>) =>
  JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;

const assistantDocument = (text = "Thanks"): ModelGenerateInput => ({
  messages: [
    { role: "user", parts: [{ type: "text", text: "Read this." }] },
    {
      role: "assistant",
      parts: [
        {
          type: "file",
          mediaType: "application/pdf",
          data: "JVBERi0xLjEK",
          filename: "brief.pdf"
        }
      ]
    },
    { role: "user", parts: [{ type: "text", text }] }
  ]
});

describe("Anthropic API version 2023-06-01", () => {
  it("sends the default anthropic-version header and still forwards sampling parameters", async () => {
    const fetcher = vi.fn(async () => response());
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })("claude-3-5-sonnet");
    await model.generate({
      ...prompt(),
      temperature: 1,
      topP: 0.99,
      providerOptions: { top_k: 5, metadata: { source: "test" } }
    });

    expect(headersOf(fetcher)["anthropic-version"]).toBe("2023-06-01");
    expect(bodyOf(fetcher)).toMatchObject({
      temperature: 1,
      top_p: 0.99,
      top_k: 5,
      metadata: { source: "test" }
    });
  });

  it("keeps an explicit 2023-06-01 header and accepts non-default sampling on older models", async () => {
    const fetcher = vi.fn(async () => response());
    const model = createAnthropic({
      apiKey: "test",
      anthropicVersion: "2023-06-01",
      fetch: fetcher as typeof fetch
    })("claude-sonnet-4-6");
    await model.generate({
      ...prompt(),
      temperature: 0.2,
      providerOptions: { top_p: 0.9, top_k: 40 }
    });

    expect(headersOf(fetcher)["anthropic-version"]).toBe("2023-06-01");
    expect(bodyOf(fetcher)).toMatchObject({ temperature: 0.2, top_p: 0.9, top_k: 40 });
  });

  it("still accepts direct assistant documents and user citations", async () => {
    const fetcher = vi.fn(async () => response());
    const model = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch })("claude-3-5-sonnet");
    await model.generate({
      messages: [
        ...assistantDocument().messages,
        {
          role: "user",
          parts: [
            providerDataPart("anthropic", {
              type: "text",
              text: "quoted",
              citations: [{ type: "char_location", cited_text: "quoted" }]
            })
          ]
        }
      ]
    });

    const messages = bodyOf(fetcher).messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "document"))).toBe(true);
    expect(messages.at(-1)?.content[0]).toMatchObject({
      type: "text",
      citations: [{ type: "char_location", cited_text: "quoted" }]
    });
  });

  it("forwards an unrecognized version without applying the 2026-10-21 rules", async () => {
    const fetcher = vi.fn(async () => response());
    const model = createAnthropic({
      apiKey: "test",
      anthropicVersion: "2099-01-01",
      fetch: fetcher as typeof fetch
    })("claude-3-5-sonnet");
    await model.generate({ ...prompt(), temperature: 0.4, ...assistantDocument() });
    expect(headersOf(fetcher)["anthropic-version"]).toBe("2099-01-01");
    expect(bodyOf(fetcher).temperature).toBe(0.4);
    const messages = bodyOf(fetcher).messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "document"))).toBe(true);
  });

  it("forwards the selected version on managed-agent requests", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: "agent_123" }));
    const client = createAnthropic({ apiKey: "test", fetch: fetcher as typeof fetch }).managedAgents;
    await client.agents.create({ name: "Assistant", model: "claude-opus-5" });
    expect(new Headers((fetcher.mock.calls[0]?.[1] as RequestInit).headers).get("anthropic-version")).toBe("2023-06-01");
  });
});

describe("Anthropic API version 2026-10-21", () => {
  const provider = (fetcher: ReturnType<typeof vi.fn>, modelId = "claude-sonnet-4-6") =>
    createAnthropic({
      apiKey: "test",
      anthropicVersion: "2026-10-21",
      fetch: fetcher as typeof fetch
    })(modelId);

  it("sends the opted-in header and omits sampling fields when the caller omits them", async () => {
    const fetcher = vi.fn(async () => response());
    await provider(fetcher, "claude-3-5-sonnet").generate({
      ...prompt(),
      stopSequences: ["END"],
      providerOptions: { metadata: { source: "test" } }
    });

    expect(headersOf(fetcher)["anthropic-version"]).toBe("2026-10-21");
    const body = bodyOf(fetcher);
    expect(body).toMatchObject({ stop_sequences: ["END"], metadata: { source: "test" } });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["temperature=1", { temperature: 1 }],
    ["temperature=0", { temperature: 0 }],
    ["shared topP", { topP: 0.99 }],
    ["provider top_p", { providerOptions: { top_p: 1 } }],
    ["top_k", { providerOptions: { top_k: 1 } }]
  ] as const)("rejects %s before fetch on every model", async (_label, extra) => {
    const fetcher = vi.fn(async () => response());
    await expect(provider(fetcher, "claude-3-5-sonnet").generate({ ...prompt(), ...extra })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(provider(fetcher, "claude-opus-4-7").generate({ ...prompt(), ...extra })).rejects.toThrow(
      /API version "2026-10-21" rejects .* including default values such as temperature=1 and top_p>=0\.99/
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects explicit defaults on Claude Opus 5 instead of treating them as allowed sampling", async () => {
    const fetcher = vi.fn(async () => response());
    await expect(
      provider(fetcher, "claude-opus-5").generate({
        ...prompt(),
        temperature: 1,
        providerOptions: { top_p: 0.99 }
      })
    ).rejects.toThrow(/rejects temperature, top_p/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects the same sampling parameters before a stream starts", async () => {
    const fetcher = vi.fn(async () => response());
    await expect(provider(fetcher).stream({ ...prompt(), temperature: 1 })).rejects.toThrow(/2026-10-21/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a document placed directly in an assistant message and still allows user and nested documents", async () => {
    const fetcher = vi.fn(async () => response());
    const model = provider(fetcher, "claude-opus-4-7");
    await expect(model.generate(assistantDocument())).rejects.toThrow(/document block placed directly in an assistant message/);
    expect(fetcher).not.toHaveBeenCalled();

    await model.generate({
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "Summarize this PDF." },
            { type: "file", mediaType: "text/plain", data: "plain notes", filename: "notes.txt" }
          ]
        },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "I fetched it." },
            providerDataPart("anthropic", {
              type: "web_fetch_tool_result",
              content: {
                type: "document",
                source: { type: "text", media_type: "text/plain", data: "nested" }
              }
            })
          ]
        },
        { role: "user", parts: [{ type: "text", text: "Thanks" }] }
      ]
    });
    const messages = bodyOf(fetcher).messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content.some((block) => block.type === "document")).toBe(true);
    expect(messages[1]?.content.some((block) => block.type === "document")).toBe(false);
    expect(messages[1]?.content[1]).toMatchObject({
      type: "web_fetch_tool_result",
      content: { type: "document" }
    });
  });

  it("rejects user citations, including inside search_result, and keeps the placements the API still accepts", async () => {
    const fetcher = vi.fn(async () => response());
    const model = provider(fetcher, "claude-3-5-sonnet");
    const cited = providerDataPart("anthropic", {
      type: "text",
      text: "quoted",
      citations: [{ type: "char_location", cited_text: "quoted" }]
    });
    await expect(model.generate({ messages: [{ role: "user", parts: [cited] }] })).rejects.toThrow(
      /non-empty citations array on a text block in a user message/
    );
    await expect(
      model.generate({
        messages: [
          {
            role: "user",
            parts: [
              providerDataPart("anthropic", {
                type: "search_result",
                source: "https://example.com",
                title: "Example",
                content: [{ type: "text", text: "quoted", citations: [{ type: "char_location", cited_text: "quoted" }] }]
              })
            ]
          }
        ]
      })
    ).rejects.toThrow(/search_result/);
    expect(fetcher).not.toHaveBeenCalled();

    await model.generate({
      messages: [
        {
          role: "user",
          parts: [
            providerDataPart("anthropic", {
              type: "text",
              text: "no citations",
              citations: []
            }),
            providerDataPart("anthropic", {
              type: "search_result",
              source: "https://example.com",
              title: "Example",
              content: [{ type: "text", text: "source" }],
              citations: { enabled: true }
            })
          ]
        },
        {
          role: "assistant",
          parts: [
            providerDataPart("anthropic", {
              type: "text",
              text: "answer",
              citations: [{ type: "char_location", cited_text: "answer" }]
            })
          ]
        },
        { role: "user", parts: [{ type: "text", text: "Continue" }] }
      ]
    });
    const messages = bodyOf(fetcher).messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]).toMatchObject({ citations: [] });
    expect(messages[0]?.content[1]).toMatchObject({ citations: { enabled: true } });
    expect(messages[1]?.content[0]).toMatchObject({
      citations: [{ type: "char_location", cited_text: "answer" }]
    });
  });

  it("sends the opted-in header on managed-agent requests without rewriting their bodies", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: "agent_123" }));
    const client = createAnthropic({
      apiKey: "test",
      anthropicVersion: "2026-10-21",
      fetch: fetcher as typeof fetch
    }).managedAgents;
    await client.agents.create({ name: "Assistant", model: "claude-opus-5" });
    expect(new Headers((fetcher.mock.calls[0]?.[1] as RequestInit).headers).get("anthropic-version")).toBe("2026-10-21");
    expect(JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      name: "Assistant",
      model: "claude-opus-5"
    });
  });

  it.each(["generate", "stream"] as const)(
    "releases the timeout and abort listener when %s rejects removed sampling parameters",
    async (method) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const fetcher = vi.fn(async () => response());
      try {
        await expect(provider(fetcher)[method]({
          ...prompt(),
          temperature: 1,
          topP: 0.99,
          timeoutMs: 60_000,
          abortSignal: controller.signal,
          providerOptions: { top_p: 1, top_k: 5 }
        })).rejects.toBeInstanceOf(UnsupportedFeatureError);

        const listener = add.mock.calls.find(([event]) => event === "abort")?.[1];
        expect(listener).toEqual(expect.any(Function));
        expect(remove).toHaveBeenCalledWith("abort", listener);
        expect(vi.getTimerCount()).toBe(0);
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        add.mockRestore();
        remove.mockRestore();
        vi.useRealTimers();
      }
    }
  );
});

describe("Anthropic sampling capabilities by API version", () => {
  const fetchImpl = vi.fn(async () => response()) as typeof fetch;
  const transport = { send: vi.fn(async () => response()) };
  const modelIds = ["claude-3-5-sonnet", "claude-opus-4-7", "claude-sonnet-5-5"];

  it("reports today's capabilities for the default version, explicit 2023-06-01, and any other version", () => {
    for (const modelId of modelIds) {
      const implicit = createAnthropic({ apiKey: "test", fetch: fetchImpl })(modelId);
      const explicit = createAnthropic({ apiKey: "test", anthropicVersion: "2023-06-01", fetch: fetchImpl })(modelId);
      const unrecognized = createAnthropic({ apiKey: "test", anthropicVersion: "2099-01-01", fetch: fetchImpl })(modelId);
      expect(implicit.capabilities.sampling).toEqual({ topP: true, seed: false, stopSequences: true });
      expect(explicit.capabilities).toEqual(implicit.capabilities);
      expect(unrecognized.capabilities).toEqual(implicit.capabilities);

      const host = createAnthropicMessagesModel({ modelId, transport });
      const hostExplicit = createAnthropicMessagesModel({
        modelId,
        transport,
        anthropicVersion: "2023-06-01"
      });
      expect(host.capabilities).toEqual(implicit.capabilities);
      expect(hostExplicit.capabilities).toEqual(implicit.capabilities);
    }
  });

  it("reports topP as unsupported on 2026-10-21 and keeps stop sequences and the rest of the profile", () => {
    for (const modelId of modelIds) {
      const current = createAnthropic({ apiKey: "test", fetch: fetchImpl })(modelId);
      const next = createAnthropic({
        apiKey: "test",
        anthropicVersion: "2026-10-21",
        fetch: fetchImpl
      })(modelId);
      expect(next.capabilities.sampling).toEqual({ topP: false, seed: false, stopSequences: true });
      expect(next.capabilities).toEqual({
        ...current.capabilities,
        sampling: { topP: false, seed: false, stopSequences: true }
      });

      const host = createAnthropicMessagesModel({
        modelId,
        provider: "bedrock",
        anthropicVersion: "2026-10-21",
        capabilities: { vision: false },
        transport
      });
      expect(host.capabilities.vision).toBe(false);
      expect(host.capabilities.sampling).toEqual({ topP: false, seed: false, stopSequences: true });
      expect(host.capabilities).toEqual({
        ...current.capabilities,
        vision: false,
        sampling: { topP: false, seed: false, stopSequences: true }
      });
    }
  });
});

describe("Bedrock Messages hosts", () => {
  const send = vi.fn(async () => response());

  it("keeps legacy sampling when the host does not opt into 2026-10-21", async () => {
    send.mockClear();
    const model = createAnthropicMessagesModel({
      modelId: "us.anthropic.claude-sonnet-4-6",
      provider: "bedrock",
      transport: { send }
    });
    await model.generate({ ...prompt(), temperature: 0.2, providerOptions: { top_k: 10 } });
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({ temperature: 0.2, top_k: 10 });
  });

  it("applies the 2026-10-21 rules for Claude 4.7 and later and rejects older Bedrock models", async () => {
    send.mockClear();
    const current = createAnthropicMessagesModel({
      modelId: "global.anthropic.claude-opus-4-7",
      provider: "bedrock",
      anthropicVersion: "2026-10-21",
      transport: { send }
    });
    await expect(current.generate({ ...prompt(), temperature: 1 })).rejects.toThrow(/rejects temperature/);
    await current.generate(prompt());
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).not.toHaveProperty("temperature");

    const legacy = createAnthropicMessagesModel({
      modelId: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-6",
      provider: "bedrock",
      anthropicVersion: "2026-10-21",
      transport: { send }
    });
    await expect(legacy.generate(prompt())).rejects.toThrow(
      /Amazon Bedrock accepts API version "2026-10-21" only for Claude 4.7 and later/
    );

    for (const modelId of ["anthropic.claude-haiku-5-5", "claude-fable-5", "jp.anthropic.claude-sonnet-5"]) {
      const later = createAnthropicMessagesModel({
        modelId,
        provider: "bedrock",
        anthropicVersion: "2026-10-21",
        transport: { send }
      });
      await later.generate(prompt());
    }
    expect(send).toHaveBeenCalledTimes(4);
  });
});
