import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createVertex } from "../src/index.js";
import type { ModelGenerateInput } from "@zhivex-ai/core";
const input: ModelGenerateInput = { messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }] };
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  const provider = createVertex({ projectId: "project", accessToken: "google-token", fetch });
  return { provider, fetch };
};

describe("Vertex hosted chat", () => {
  it("separates Jamba JSON mode from native schema and rejects streaming tools before network", async () => {
    const { provider, fetch } = setup();
    const model = provider("ai21/jamba-1.5-mini@001");
    expect(model.capabilities).toMatchObject({ tools: true, jsonMode: true, structuredOutput: false });
    await expect(model.generate({ ...input, providerOptions: { response_format: { type: "json_schema", json_schema: { name: "test", schema: { type: "object" } } } } })).rejects.toThrow();
    await expect(model.stream!({ ...input, tools: { sum: { name: "sum", schema: z.object({}) } } })).rejects.toThrow("streaming requests with tools");
    expect(fetch).not.toHaveBeenCalled();
    await model.generate({ ...input, providerOptions: { response_format: { type: "json_object" } } });
    expect(JSON.parse(fetch.mock.lastCall![1]!.body as string).response_format).toEqual({ type: "json_object" });
  });

  it("rejects Mistral safe_prompt on managed Vertex without imposing it on deployed endpoints", async () => {
    const { provider, fetch } = setup();
    await expect(provider("mistralai/codestral-2").generate({ ...input, providerOptions: { safe_prompt: false } })).rejects.toThrow("safe_prompt");
    expect(fetch).not.toHaveBeenCalled();
    await provider.chatModel("custom", { endpoint: "42" }).generate({ ...input, providerOptions: { safe_prompt: true } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not infer advanced capabilities from unrecognized model-name prefixes", async () => {
    const { provider, fetch } = setup();
    for (const id of ["google/gemma-4-unknown", "xai/grok-4-unknown", "meta/llama-4-unknown", "deepseek-ai/deepseek-v3.20-maas", "openai/gpt-oss-999b-maas", "mistralai/mistral-medium-30", "zai-org/glm-unknown"]) {
      const model = provider(id);
      expect(model.capabilities).toMatchObject({ tools: false, toolChoice: false, structuredOutput: false, jsonMode: false, vision: false, reasoning: false });
      expect(model.capabilities.reasoningEfforts).toBeUndefined();
      await expect(model.generate({ ...input, tools: { sum: { name: "sum", schema: z.object({}) } } })).rejects.toThrow("does not support tools");
      await expect(model.generate({ ...input, reasoning: { effort: "high" } })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    await provider("google/gemma-4-unknown").generate(input);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves exact hosted profiles and raw publisher revisions", () => {
    const { provider } = setup();
    for (const id of ["meta/llama-4-scout-17b-16e-instruct-maas", "google/gemma-4-26b-a4b-it-maas", "mistralai/mistral-small-2503@001"]) expect(provider(id).capabilities).toMatchObject({ vision: true, tools: true, structuredOutput: true });
    expect(provider("zai-org/glm-5.2-maas").capabilities).toMatchObject({ vision: false, tools: true, reasoning: true });
    expect(provider("qwen/qwen3-next-80b-a3b-instruct-maas").capabilities.reasoning).toBe(false);
    expect(provider("qwen/qwen3-next-80b-a3b-thinking-maas").capabilities.reasoning).toBe(true);
    expect(provider("google/gemma-4-26b-a4b-it-maas").capabilities).not.toHaveProperty("thinkingControl");
  });

  it("uses explicit auto for gpt-oss and Qwen tools while preserving none", async () => {
    const { provider, fetch } = setup();
    const tools = { sum: { name: "sum", schema: z.object({}) } };
    for (const id of ["openai/gpt-oss-120b-maas", "qwen/qwen3-235b-a22b-instruct-2507-maas"]) {
      await provider(id).generate({ ...input, tools });
      expect(JSON.parse(fetch.mock.lastCall![1]!.body as string).tool_choice).toBe("auto");
      if (id.startsWith("openai/")) expect(JSON.parse(fetch.mock.lastCall![1]!.body as string).tools[0].function.description).toBe("");
      await provider(id).generate({ ...input, tools, toolChoice: "none" });
      expect(JSON.parse(fetch.mock.lastCall![1]!.body as string).tool_choice).toBe("none");
    }
    const model = provider("openai/gpt-oss-120b-maas");
    await expect(model.generate({ ...input, tools, toolChoice: "required" })).rejects.toThrow("only auto or none");
    await expect(model.generate({ ...input, tools, toolChoice: { type: "tool", toolName: "sum" } })).rejects.toThrow("only auto or none");
    await expect(model.generate({ ...input, tools, providerOptions: { tool_choice: "required" } })).rejects.toThrow("only auto or none");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("rejects partner selectors on Google-specific model factories", () => {
    const { provider, fetch } = setup();
    for (const modelId of ["meta/llama-4-maverick-17b-128e-instruct-maas", "mistral-medium-3", "intfloat/multilingual-e5-small-maas", "publishers/anthropic/models/claude-opus-5"]) {
      expect(() => provider.groundedLanguageModel!(modelId)).toThrow("Google-specific");
      expect(() => provider.imageGenerationModel!(modelId)).toThrow("Google-specific");
      expect(() => provider.realtimeModel!(modelId)).toThrow("Google-specific");
    }
    expect(() => provider.embeddingModel("meta/llama-4-maverick-17b-128e-instruct-maas")).toThrow("Google-specific");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not advertise thinking for Grok non-reasoning variants", () => {
    const { provider } = setup();
    expect(provider("xai/grok-4.20-non-reasoning").capabilities.reasoning).toBe(false);
    expect(provider("xai/grok-4.20-reasoning").capabilities.reasoning).toBe(true);
  });
  it("permits function calls for R1-0528 without enabling them on older R1", async () => {
    const { provider, fetch } = setup();
    const model = provider("deepseek-ai/deepseek-r1-0528-maas");
    expect(model.capabilities.tools).toBe(true);
    expect(provider("deepseek-ai/deepseek-r1").capabilities.tools).toBe(false);
    await model.generate({ ...input, tools: { lookup: { name: "lookup", schema: z.object({}) } }, toolChoice: "auto" });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).tools[0].function.name).toBe("lookup");
  });
  it("normalizes the legacy Kimi Thinking publisher spelling", async () => {
    const { provider, fetch } = setup();
    await provider("moonshot-ai/kimi-k2-thinking-maas").generate(input);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).model).toBe("moonshotai/kimi-k2-thinking-maas");
  });

  it("treats DeepSeek OCR as vision without tools, structured output or reasoning", async () => {
    const { provider, fetch } = setup();
    const model = provider("deepseek-ai/deepseek-ocr-maas");
    expect(model.capabilities).toMatchObject({ vision: true, tools: false, toolChoice: false, parallelToolCalls: false, structuredOutput: false, jsonMode: false, reasoning: false });
    await model.generate({ messages: [{ role: "user", parts: [{ type: "text", text: "Free OCR" }, { type: "image", image: "data:image/png;base64,AQI=" }] }] });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AQI=" } });
    await expect(model.generate({ ...input, reasoning: { effort: "high" } })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["xai/grok-4.1-fast-reasoning", "meta/llama-4-maverick-17b-128e-instruct-maas", "deepseek-ai/deepseek-v3.2-maas", "qwen/qwen3-next-80b-a3b-thinking-maas", "zai-org/glm-5-maas", "moonshotai/kimi-k2-thinking-maas", "minimaxai/minimax-m2-maas", "google/gemma-4-26b-a4b-it-maas", "openai/gpt-oss-120b-maas"])("routes %s through Google's OpenAPI endpoint", async (id) => {
    const { provider, fetch } = setup();
    const model = provider(id);
    expect(model.provider).toBe("vertex");
    expect((await model.generate(input)).text).toBe("ok");
    expect(String(fetch.mock.calls[0][0])).toBe("https://aiplatform.googleapis.com/v1/projects/project/locations/global/endpoints/openapi/chat/completions");
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer google-token");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).model).toBe(id);
    expect(fetch.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("uses the Mistral publisher and strips only the body revision", async () => {
    const { provider, fetch } = setup();
    await provider("mistralai/mistral-medium-3@001").generate(input);
    expect(String(fetch.mock.calls[0][0])).toContain("publishers/mistralai/models/mistral-medium-3%40001:rawPredict");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).model).toBe("mistral-medium-3");
  });

  it("maps required tool choice to Mistral any without changing other publisher protocols", async () => {
    const { provider, fetch } = setup();
    const tools = { sum: { name: "sum", schema: z.object({}) } };
    await provider("mistralai/mistral-medium-3").generate({ ...input, tools, toolChoice: "required" });
    expect(JSON.parse(fetch.mock.lastCall![1]!.body as string).tool_choice).toBe("any");
    await provider("meta/llama-3.3-70b-instruct-maas").generate({ ...input, tools, toolChoice: "required" });
    expect(JSON.parse(fetch.mock.lastCall![1]!.body as string).tool_choice).toBe("required");
  });

  it("keeps self-deployed capabilities independent of publisher model names", async () => {
    const { provider, fetch } = setup();
    for (const id of ["openai/gpt-oss-120b-maas", "google/gemma-4-26b-a4b-it-maas", "deepseek-ai/deepseek-v3.2-maas"]) {
      const model = provider.chatModel(id, { endpoint: "42" });
      expect(model.capabilities.reasoning).toBe(false);
      expect(model.capabilities.reasoningEfforts).toBeUndefined();
      await expect(model.generate({ ...input, providerOptions: { reasoning_effort: "high" } })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    const custom = provider.chatModel("openai/gpt-oss-120b-maas", { endpoint: "42", capabilities: { reasoning: true } });
    await custom.generate({ ...input, reasoning: { effort: "minimal" } });
    expect(JSON.parse(fetch.mock.lastCall![1]!.body as string).reasoning_effort).toBe("minimal");
  });

  it("supports a self-deployed chat endpoint", async () => {
    const { provider, fetch } = setup();
    await provider.chatModel("custom-model", { endpoint: "projects/project/locations/global/endpoints/42", capabilities: { vision: true } }).generate(input);
    expect(String(fetch.mock.calls[0][0])).toBe("https://aiplatform.googleapis.com/v1/projects/project/locations/global/endpoints/42/chat/completions");
  });

  it("rejects Grok effort without a network call", async () => {
    const { provider, fetch } = setup();
    await expect(provider("grok-4.1-fast-reasoning").generate({ ...input, reasoning: { effort: "high" } })).rejects.toThrow("does not support reasoning_effort");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps host-specific thinking controls", async () => {
    const { provider, fetch } = setup();
    await provider("openai/gpt-oss-120b-maas").generate({ ...input, reasoning: { effort: "high" } });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).reasoning_effort).toBe("high");
    await provider("deepseek-ai/deepseek-v3.1-maas").generate({ ...input, reasoning: { effort: "none" } });
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string).chat_template_kwargs).toEqual({ thinking: false });
  });

  it.each(["zai-org/glm-4.7-maas", "zai-org/glm-5-maas", "zai-org/glm-5.2-maas"])("maps documented GLM thinking toggles for %s", async (id) => {
    const { provider, fetch } = setup();
    for (const effort of ["none", "low", "medium", "high"] as const) {
      await provider(id).generate({ ...input, reasoning: { effort }, providerOptions: { chat_template_kwargs: { custom: "preserved" } } });
      const body = JSON.parse(fetch.mock.lastCall![1]!.body as string);
      expect(body.chat_template_kwargs).toEqual({ custom: "preserved", enable_thinking: effort !== "none" });
      expect(body.reasoning_effort).toBeUndefined();
    }
    await expect(provider(id).generate({ ...input, reasoning: { effort: "minimal" } })).rejects.toThrow("enabling or disabling thinking");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("requires Google bearer credentials for partner chat", () => {
    const provider = createVertex({ apiKey: "test-key" });
    expect(() => provider("xai/grok-4.3")).toThrow("bearer");
  });
  it.each(["openai/gpt-6-astra", "meta/muse-spark", "mistralai/mistral-ocr-2505"])("does not imply chat support for %s", (id) => {
    const { provider, fetch } = setup();
    expect(() => provider(id)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

});
