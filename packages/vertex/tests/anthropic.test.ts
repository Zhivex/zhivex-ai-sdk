import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ConfigurationError, ProviderHTTPError, UnsupportedFeatureError,
  generateObject, generateText, tool, hostedTool, predictRaw,
  type ModelGenerateInput
} from "@zhivex-ai/core";
import { createVertex } from "../src/index.js";

const input: ModelGenerateInput = { messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }], maxRetries: 0 };
const response = (text = "Hello") => Response.json({
  content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 }
});
const provider = (fetcher: ReturnType<typeof vi.fn>, extra = {}) => createVertex({
  accessToken: "google-token", projectId: "test-project", location: "us-east5", fetch: fetcher as typeof fetch, ...extra
});
const bodyAt = (fetcher: ReturnType<typeof vi.fn>, index = 0) => JSON.parse(fetcher.mock.calls[index][1].body);

afterEach(() => vi.unstubAllEnvs());

describe("Claude on Vertex", () => {
  it("uses Google credentials and the Anthropic publisher with no direct API environment leakage", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "unrelated-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://unrelated.example/v1");
    vi.stubEnv("ANTHROPIC_WORKSPACE_ID", "unrelated-workspace");
    const fetcher = vi.fn(async () => response());
    const model = provider(fetcher)("claude-sonnet-4-6");
    const result = await generateText({ model, system: "Be brief", prompt: "Hello", maxTokens: 64 });
    expect(model.provider).toBe("vertex");
    expect(result.text).toBe("Hello");
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    expect(fetcher.mock.calls[0][0]).toBe("https://us-east5-aiplatform.googleapis.com/v1/projects/test-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6:rawPredict");
    const init = fetcher.mock.calls[0][1];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer google-token");
    for (const name of ["x-api-key", "anthropic-version", "anthropic-beta", "anthropic-workspace-id"]) {
      expect(new Headers(init.headers).has(name)).toBe(false);
    }
    expect(init.redirect).toBe("error");
    expect(bodyAt(fetcher)).toMatchObject({ anthropic_version: "vertex-2023-10-16", max_tokens: 64, messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] });
    expect(bodyAt(fetcher).model).toBeUndefined();
    expect(bodyAt(fetcher).system).toBeDefined();
  });

  it("refreshes the Google token for each retry and preserves typed HTTP errors", async () => {
    let counter = 0;
    const getAccessToken = vi.fn(async () => `google-token-${++counter}`);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: "busy" } }, { status: 429 })).mockResolvedValueOnce(response());
    const model = provider(fetcher, { accessToken: undefined, getAccessToken })("claude-sonnet-4-6");
    await model.generate({ ...input, maxRetries: 1, retryBackoffMs: 1 });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1][1].headers).get("authorization")).toBe("Bearer google-token-2");
    const forbidden = vi.fn(async () => Response.json({ error: { message: "IAM denied" } }, { status: 403 }));
    await expect(provider(forbidden)("claude-sonnet-4-6").generate(input)).rejects.toBeInstanceOf(ProviderHTTPError);
  });

  it("streams Anthropic SSE from streamRawPredict, including tool calls and usage", async () => {
    const events = [
      ["message_start", { message: { usage: { input_tokens: 3, output_tokens: 0 } } }],
      ["content_block_delta", { delta: { type: "text_delta", text: "Hello" } }],
      ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-1", name: "sum" } }],
      ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"a":2}' } }],
      ["content_block_stop", { index: 1 }],
      ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }],
      ["message_stop", {}]
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    const fetcher = vi.fn(async () => new Response(events, { headers: { "content-type": "text/event-stream" } }));
    const stream = await provider(fetcher)("claude-sonnet-4-6").stream!(input);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(fetcher.mock.calls[0][0]).toMatch(/:streamRawPredict$/);
    expect(bodyAt(fetcher).stream).toBe(true);
    expect(chunks).toContainEqual({ type: "text-delta", textDelta: "Hello" });
    expect(chunks).toContainEqual(expect.objectContaining({ type: "tool-call", toolCall: expect.objectContaining({ name: "sum", input: { a: 2 } }) }));
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 3, outputTokens: 4 } });
  });

  it("runs a client tool loop and maps its result back into Claude messages", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({
      content: [{ type: "tool_use", id: "call-1", name: "sum", input: { a: 2, b: 3 } }], stop_reason: "tool_use"
    })).mockResolvedValueOnce(response("5"));
    const execute = vi.fn(({ a, b }: { a: number; b: number }) => ({ total: a + b }));
    const result = await generateText({
      model: provider(fetcher)("claude-sonnet-4-6"), prompt: "Sum 2 and 3", maxSteps: 2,
      tools: { sum: tool({ name: "sum", schema: z.object({ a: z.number(), b: z.number() }), execute }) }
    });
    expect(result.text).toBe("5");
    expect(execute).toHaveBeenCalledOnce();
    expect(bodyAt(fetcher).tools[0]).toMatchObject({ name: "sum", input_schema: { type: "object" } });
    expect(bodyAt(fetcher, 1).messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call-1" });
  });

  it("maps native structured output and reasoning without claiming Opus 4.1 support", async () => {
    const fetcher = vi.fn(async () => response('{"ok":true}'));
    const vertex = provider(fetcher);
    const result = await generateObject({ model: vertex("claude-sonnet-4-6"), prompt: "Return ok=true", schema: z.object({ ok: z.boolean() }), mode: "native", reasoning: { effort: "low" } });
    expect(result.object).toEqual({ ok: true });
    expect(bodyAt(fetcher).output_config).toMatchObject({ format: { type: "json_schema" }, effort: "low" });
    expect(bodyAt(fetcher).thinking).toMatchObject({ type: "adaptive" });
    expect(vertex("claude-opus-4-1").capabilities.structuredOutput).toBe(false);
  });

  it("rejects API keys, unsafe IDs and Google grounding before fetch", () => {
    const fetcher = vi.fn();
    expect(() => createVertex({ apiKey: "test", fetch: fetcher as typeof fetch })("claude-sonnet-4-6")).toThrow(ConfigurationError);
    expect(() => provider(fetcher)("claude-../../other")).toThrow(ConfigurationError);
    expect(() => provider(fetcher).groundedLanguageModel!("claude-sonnet-4-6")).toThrow(UnsupportedFeatureError);
    expect(() => provider(fetcher).embeddingModel("claude-sonnet-4-6")).toThrow(UnsupportedFeatureError);
    expect(() => provider(fetcher).realtimeModel!("claude-sonnet-4-6")).toThrow(UnsupportedFeatureError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { providerOptions: { speed: "fast" } },
    { providerOptions: { stream: true } },
    { providerOptions: { betas: ["test-beta"] } },
    { providerOptions: { mcp_servers: [] } },
    { providerOptions: { fallbacks: "default" } },
    { tools: { search: hostedTool({ provider: "anthropic", type: "web_search_20250305", name: "search" }) } },
    { messages: [{ role: "user", parts: [{ type: "file", mediaType: "application/pdf", data: "file_abc" }] }] }
  ])("rejects direct-API-only inputs before sending a request: %j", async (extra) => {
    const fetcher = vi.fn();
    const model = provider(fetcher)("claude-sonnet-4-6");
    expect(model.capabilities.webSearch).toBe(false);
    await expect(model.generate({ ...input, ...extra } as ModelGenerateInput)).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves global and revision IDs and does not authenticate rawFetch", async () => {
    const fetcher = vi.fn(async () => response());
    const vertex = provider(fetcher, { location: "global" });
    await vertex("claude-3-5-sonnet-v2@20241022").generate(input);
    expect(fetcher.mock.calls[0][0]).toBe("https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/anthropic/models/claude-3-5-sonnet-v2%4020241022:rawPredict");
    await vertex.rawFetch("https://example.com");
    expect(fetcher.mock.calls[1][1]).toBeUndefined();
  });

  it("routes explicit raw publisher resources without pretending they use Gemini messages", async () => {
    const fetcher = vi.fn(async () => Response.json({ output: "raw" }));
    const vertex = provider(fetcher);
    expect(vertex.predictionModel!("publishers/anthropic/models/claude-sonnet-4-6").capabilities).toMatchObject({ rawPrediction: true, streaming: false, tools: false, webSearch: false });
    await predictRaw({ model: vertex.predictionModel!("publishers/anthropic/models/claude-sonnet-4-6"), body: { anthropic_version: "vertex-2023-10-16", messages: [], max_tokens: 32 }, providerOptions: { action: "rawPredict" } });
    expect(fetcher.mock.calls[0][0]).toMatch(/publishers\/anthropic\/models\/claude-sonnet-4-6:rawPredict$/);
    expect(bodyAt(fetcher)).not.toHaveProperty("instances");
    expect(() => vertex.predictionModel!("publishers/../models/test")).toThrow(ConfigurationError);
    expect(() => vertex.predictionModel!("claude-sonnet-4-6")).toThrow(ConfigurationError);
    expect(() => vertex.predictionModel!("publishers/anthropic/models/a/b")).toThrow(ConfigurationError);
  });
});
