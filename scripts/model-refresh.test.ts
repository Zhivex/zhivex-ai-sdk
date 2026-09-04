import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool, type ModelGenerateInput } from "../packages/core/src/index.js";
import { createOpenAI } from "../packages/openai/src/index.js";
import { createAzureOpenAI } from "../packages/azure-openai/src/index.js";
import { createAnthropic } from "../packages/anthropic/src/index.js";
import { createGemini } from "../packages/gemini/src/index.js";
import { createVertex } from "../packages/vertex/src/index.js";
import { createQwen } from "../packages/qwen/src/index.js";
import { createMeta } from "../packages/meta/src/index.js";
import { createOllama } from "../packages/ollama/src/index.js";
import { defaultModelCatalog } from "../packages/sdk/src/catalog.js";

const input: ModelGenerateInput = { messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }], maxRetries: 0 };
const tools = { weather: tool({ name: "weather", description: "Weather", schema: z.object({ city: z.string() }), execute: async () => "sunny" }) };
const response = () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }] }), { headers: { "content-type": "application/json" } });

describe("September provider model contracts", () => {
  for (const host of ["openai", "azure"] as const) {
    const factory = (fetch: typeof globalThis.fetch) => host === "openai"
      ? createOpenAI({ apiKey: "test", fetch })
      : createAzureOpenAI({ apiKey: "test", endpoint: "https://example.openai.azure.com", fetch });
    it(`${host}: routes Astra tools and structured output through Responses`, async () => {
      const fetch = vi.fn(async () => response());
      const model = factory(fetch)("gpt-6-astra");
      const result = await model.generate({ ...input, tools, toolChoice: { type: "tool", toolName: "weather" }, reasoning: { effort: "high" }, structuredOutput: { mode: "native", schema: z.object({ ok: z.boolean() }) } });
      expect(result.text).toBe("OK");
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("/responses");
      const body = JSON.parse(String(init.body));
      expect(body.reasoning).toMatchObject({ effort: "high" });
      expect(body.tool_choice).toEqual({ type: "function", name: "weather" });
      expect(body.text.format.type).toBe("json_schema");
      expect(body).not.toHaveProperty("apiMode");
      expect(model.capabilities.agentCapabilities?.computerUse).toBe(true);
      expect(model.capabilities.reasoningEfforts).not.toContain("none");
    });
    it(`${host}: rejects invalid Astra input before network IO`, async () => {
      const fetch = vi.fn();
      const model = factory(fetch)("gpt-6-astra");
      for (const extra of [{ temperature: .2 }, { reasoning: { effort: "none" } }, { providerOptions: { top_p: .9 } }, { tools, providerOptions: { apiMode: "chat" } }]) {
        await expect(model.generate({ ...input, ...extra } as ModelGenerateInput)).rejects.toThrow();
      }
      expect(fetch).not.toHaveBeenCalled();
    });
    it(`${host}: streams Astra through Responses`, async () => {
      const fetch = vi.fn(async () => new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } }));
      const events = [];
      for await (const e of await factory(fetch)("gpt-6-astra").stream(input)) events.push(e);
      expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", textDelta: "OK" }));
      expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toContain("/responses");
    });
  }
  it.each(["claude-fable-5-1", "claude-mythos-5-1"])("%s rejects forced tools and enables progress updates", async (id) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" })));
    const model = createAnthropic({ apiKey: "test", fetch })(id);
    await expect(model.generate({ ...input, tools, toolChoice: "required" })).rejects.toThrow("automatic or disabled");
    await expect(model.generate({ ...input, tools, providerOptions: { tool_choice: { type: "tool", name: "weather" } } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await model.generate({ ...input, tools, reasoning: { effort: "high" }, providerOptions: { thinking: { type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } } } });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init.body));
    expect(body.thinking).toMatchObject({ type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(new Headers(init.headers).get("anthropic-beta")).toContain("thinking-display-updates-2026-08-18");
    expect(new Headers(init.headers).get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01");
  });
  it("rejects Gemini 3.8 minimal effort on both transports", async () => {
    const fetch = vi.fn();
    const models = [createGemini({ apiKey: "test", fetch })("gemini-3.8-flash"), createVertex({ apiKey: "test", fetch })("gemini-3.8-flash")];
    for (const model of models) {
      await expect(model.generate({ ...input, reasoning: { effort: "minimal" } })).rejects.toThrow();
      await expect(model.stream({ ...input, reasoning: { effort: "minimal" } })).rejects.toThrow();
      await expect(model.generate({ ...input, providerOptions: { generationConfig: { thinkingConfig: { thinkingLevel: "MINIMAL" } } } })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows documented Vertex 3.8 regions and exposes Computer Use", () => {
    for (const location of ["global", "us", "eu"]) {
      const model = createVertex({ accessToken: "test", projectId: "example-project", location })("gemini-3.8-flash");
      expect(model.capabilities.computerUse).toBe(true);
    }
    expect(() => createVertex({ accessToken: "test", projectId: "example-project", location: "us-central1" })("gemini-3.8-flash")).toThrow("not available");
  });
  it("uses Responses with an opaque versioned Azure deployment", async () => {
    const fetch = vi.fn(async () => response());
    const model = createAzureOpenAI({ apiKey: "test", endpoint: "https://example.openai.azure.com", apiVersion: "2025-04-01-preview", fetch })("my-deployment");
    await model.generate({ ...input, providerOptions: { apiMode: "responses", reasoning_effort: "high" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/deployments/my-deployment/responses?api-version=");
    const body = JSON.parse(String(init.body));
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("apiMode");
  });
  it("preserves Qwen snapshot IDs while applying the Max contract", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })));
    const qwen = createQwen({ apiKey: "test", fetch });
    expect(qwen("qwen3.8-max-0902").capabilities).toEqual(qwen("qwen3.8-max").capabilities);
    await qwen("qwen3.8-max-0902").generate({ ...input, providerOptions: { apiMode: "chat" }, maxTokens: 100 });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.model).toBe("qwen3.8-max-0902");
    expect(body.max_completion_tokens).toBe(100);
    expect(body).not.toHaveProperty("max_tokens");
  });
  it("exposes current models without recommending retired Kimi or restricted Mythos", () => {
    for (const [provider, id] of [["openai", "gpt-6-astra"], ["azure-openai", "gpt-6-astra"], ["anthropic", "claude-fable-5-1"], ["gemini", "gemini-3.8-flash"], ["vertex", "gemini-3.8-flash"], ["gemini", "lyria-3.5"], ["meta", "muse-spark-1.3"], ["qwen", "qwen3.8-max-0902"], ["ollama", "qwen3.8"]]) {
      expect(defaultModelCatalog.find(provider!, id!)).toBeDefined();
    }
    for (const id of ["kimi-k2.5", "kimi-k2-0905-preview"]) expect(defaultModelCatalog.find("kimi", id)?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("anthropic", "claude-mythos-5-1")?.recommendedFor).toBeUndefined();
    expect(createOllama()("qwen3.8:27b").capabilities.reasoning).toBe(true);
  });
  it("maps Muse Spark 1.3 max reasoning in the existing Meta protocol", async () => {
    const fetch = vi.fn(async () => response());
    await createMeta({ apiKey: "test", fetch })("muse-spark-1.3").generate({ ...input, reasoning: { effort: "max" }, providerOptions: { apiMode: "responses" } });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.model).toBe("muse-spark-1.3");
    expect(body.reasoning).toMatchObject({ effort: "max" });
  });
});
