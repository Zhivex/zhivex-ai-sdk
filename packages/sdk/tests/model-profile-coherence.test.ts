import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateText, tool } from "../src/index.js";
import { createOpenAI, openAIToolSearchTool } from "../../openai/src/index.js";
import { createOpenRouter } from "../../openrouter/src/index.js";
import { createGemini } from "../../gemini/src/index.js";
import { defaultModelCatalog } from "../src/catalog.js";

const lookup = tool({ name: "lookup", schema: z.object({}), execute: () => "found" });

describe("model profiles through the SDK facade", () => {
  it.each([
    ["openai", createOpenAI],
    ["openrouter", createOpenRouter]
  ] as const)("rejects unverified %s tool routes before network or execution", async (_, factory) => {
    const fetcher = vi.fn();
    const model = factory({ apiKey: "test", fetch: fetcher as typeof fetch })("private-text-model");
    await expect(generateText({ model, prompt: "Use lookup", tools: { lookup } })).rejects.toThrow("does not support tools");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["openai", createOpenAI],
    ["openrouter", createOpenRouter]
  ] as const)("accepts an explicitly declared private %s tool model without catalog registration", async (_, factory) => {
    const fetcher = vi.fn(async () => Response.json({
      choices: [{ message: { role: "assistant", content: "ready" }, finish_reason: "stop" }]
    }));
    const model = factory({
      apiKey: "test", fetch: fetcher as typeof fetch,
      modelCapabilities: { "private-tool-model": { tools: true } }
    })("private-tool-model");
    const result = await generateText({ model, prompt: "Use lookup if needed", tools: { lookup } });
    expect(result.text).toBe("ready");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("private-tool-model");
    expect(body.tools[0].function.name).toBe("lookup");
    expect(defaultModelCatalog.find(model.provider, model.modelId)).toBeUndefined();
  });

  it.each([
    ["openai", createOpenAI],
    ["openrouter", createOpenRouter]
  ] as const)("keeps raw text and JSON-object formats distinct from native schema output for %s", async (_, factory) => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({
      choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }]
    }));
    const model = factory({ apiKey: "test", fetch: fetcher as typeof fetch,
      modelCapabilities: { "private-json-model": { jsonMode: true } }
    })("private-json-model");
    const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];
    for (const type of ["text", "json_object"]) {
      await model.generate({ messages, providerOptions: { response_format: { type } } });
      const body = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
      expect(body.response_format).toEqual({ type });
    }
    for (const method of ["generate", "stream"] as const) {
      await expect(model[method]({ messages, providerOptions: { response_format: { type: "json_schema" } } })).rejects.toThrow("native structured output");
      await expect(model[method]({ messages, providerOptions: { parallel_tool_calls: true } })).rejects.toThrow("parallel tool");
      await expect(model[method]({ messages: [{ role: "assistant", parts: [{
        type: "tool-call", toolCall: { id: "call-1", name: "lookup", input: {} }
      }] }] })).rejects.toThrow("tool support");
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    const plain = factory({ apiKey: "test", fetch: fetcher as typeof fetch })("private-text-model");
    await expect(plain.generate({ messages, providerOptions: { response_format: { type: "json_object" } } })).rejects.toThrow("JSON mode");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["gpt-4-0613", "gpt-4-1106-preview", "gpt-3.5-turbo-0125"])(
    "recognizes historical %s without granting audio capabilities", (id) => {
      expect(createOpenAI({ apiKey: "test" })(id).capabilities).toMatchObject({
        tools: true, audioInput: false, audioOutput: false
      });
    }
  );

  it("uses the resolved hosted-tool declaration for private and known OpenAI models", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ready" }] }],
      status: "completed"
    }));
    const provider = createOpenAI({ apiKey: "test", fetch: fetcher as typeof fetch, modelCapabilities: {
      "private-responses": { tools: true, agentCapabilities: { toolSearch: true } },
      "gpt-6-sol": { agentCapabilities: { toolSearch: false } }
    } });
    const input = { messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }],
      tools: { search: openAIToolSearchTool() }, providerOptions: { apiMode: "responses" as const }
    };
    const result = await provider("private-responses").generate(input);
    expect(result.text).toBe("ready");
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.tools).toEqual([{ type: "tool_search" }]);
    await expect(provider("gpt-6-sol").generate(input)).rejects.toThrow("tool_search");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"])(
    "keeps curated %s reasoning metadata consistent with actual requests", async (id) => {
      const fetcher = vi.fn(async () => Response.json({ candidates: [{
        content: { parts: [{ text: "ready" }] }, finishReason: "STOP"
      }] }));
      const model = createGemini({ apiKey: "test", fetch: fetcher as typeof fetch })(id);
      expect(defaultModelCatalog.find("gemini", id)).toBeDefined();
      await generateText({ model, prompt: "hello", reasoning: { effort: "low" } });
      const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
      const unsupported = model.capabilities.reasoningEfforts?.includes("minimal") ? "max" : "minimal";
      await expect(generateText({ model, prompt: "hello", reasoning: { effort: unsupported } })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );
});
