import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "@zhivex-ai/core";
import { createGemini } from "../src/index.js";

const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];
const id = "gemini-4-hydrogen";
const response = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
const provider = (fetcher: typeof fetch) => createGemini({ apiKey: "test", fetch: fetcher });

describe("Hydrogen", () => {
  it.each(["low", "medium", "high", "xhigh"] as const)("maps %s reasoning without changing tools or JSON output", async (effort) => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json(response));
    const model = provider(fetcher as typeof fetch)(id);
    expect(model.capabilities.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    const result = await model.generate({ messages, reasoning: { effort },
      tools: { lookup: tool({ name: "lookup", description: "Lookup", schema: z.object({ name: z.string() }), execute: async () => "ok" }) },
      structuredOutput: { mode: "native", schema: z.object({ answer: z.string() }) }
    });
    expect(result.text).toBe("ok");
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: effort }, responseMimeType: "application/json" });
    expect(body.generationConfig.responseSchema).toBeDefined();
    expect(body.tools[0].functionDeclarations[0].name).toBe("lookup");
    expect(String(fetcher.mock.calls[0][0])).toContain(id);
  });

  it("leaves the default thinking level to the service", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json(response));
    await provider(fetcher as typeof fetch)(id).generate({ messages });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).generationConfig?.thinkingConfig).toBeUndefined();
  });

  it("streams xhigh output and preserves tool thought signatures", async () => {
    const chunk = { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { name: "a" } }, thoughtSignature: "signed" }] }, finishReason: "STOP" }] };
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const events = [];
    for await (const event of await provider(fetcher as typeof fetch)(id).stream({ messages, reasoning: { effort: "xhigh" } })) events.push(event);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "xhigh" });
    expect(JSON.stringify(events)).toContain("signed");
    expect(JSON.stringify(events)).toContain("lookup");
  });

  it("rejects incompatible requests before generate or stream reaches the network", async () => {
    const fetcher = vi.fn();
    const model = provider(fetcher)(id);
    for (const options of [
      { reasoning: { effort: "minimal" as const } }, { reasoning: { effort: "none" as const } },
      { reasoning: { budgetTokens: 128 } }, { temperature: 0.1 },
      { providerOptions: { generation_config: { top_p: 0.9 } } },
      { providerOptions: { generationConfig: { thinkingConfig: { thinkingBudget: 128 } } } },
      { providerOptions: { generationConfig: { thinkingConfig: { thinkingLevel: "MINIMAL" } } } },
      { providerOptions: { cachedContent: "cachedContents/a" } },
      { providerOptions: { cached_content: "cachedContents/a" } },
      { messages: [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "prefix" }] }] }
    ]) {
      await expect(model.generate({ messages, ...options })).rejects.toThrow();
      await expect(model.stream({ messages, ...options })).rejects.toThrow();
    }
    await expect(provider(fetcher)("gemini-4-argon").generate({ messages, reasoning: { effort: "xhigh" } })).rejects.toThrow();
    await expect(provider(fetcher).caches.create({ modelId: id, contents: messages })).rejects.toThrow("implicit caching");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("supports Interactions background xhigh and rejects incompatible configuration", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ id: "interaction-1", status: "in_progress" }));
    const client = provider(fetcher as typeof fetch).interactions;
    await client.create({ modelId: id, input: "hello", background: true, generationConfig: { thinking_level: "xhigh", max_output_tokens: 100000 } });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: id, background: true, generation_config: { thinking_level: "xhigh", max_output_tokens: 100000 } });
    for (const generationConfig of [{ thinking_level: "minimal" }, { thinking_budget: 128 }, { temperature: 0.3 }]) {
      await expect(client.create({ modelId: id, input: "hello", generationConfig })).rejects.toThrow();
    }
    await expect(client.create({ modelId: id, input: "hello", providerOptions: { cached_content: "cachedContents/a" } })).rejects.toThrow("implicit caching");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
