import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "@zhivex-ai/core";
import { createOpenRouter } from "../src/index.js";

const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];

describe("OpenRouter model capabilities", () => {
  it("rejects unverified advanced features in generate and stream before network", async () => {
    const fetcher = vi.fn();
    const model = createOpenRouter({ apiKey: "test", fetch: fetcher })("vendor/unrecognized");
    expect(model.capabilities).toMatchObject({ streaming: true, tools: false, vision: false, structuredOutput: false });
    const inputs = [
      { messages, tools: { echo: tool({ name: "echo", schema: z.object({}), execute: () => "ok" }) } },
      { messages: [{ role: "user" as const, parts: [{ type: "image" as const, url: "https://example.com/image.png" }] }] },
      { messages, structuredOutput: { mode: "native" as const, schema: z.object({}) } },
      { messages, providerOptions: { response_format: { type: "json_schema" } } },
    ];
    for (const input of inputs) {
      await expect(model.generate(input)).rejects.toThrow("no declared");
      await expect(model.stream(input)).rejects.toThrow("no declared");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves registered host routes and explicit overrides", () => {
    const provider = createOpenRouter({ apiKey: "test", modelCapabilities: { "vendor/private": { tools: true, agentCapabilities: { toolChoiceNone: true } } } });
    for (const id of ["openai/gpt-4o-mini", "meta/muse-spark-1.2", "meta/muse-glimmer-30b"]) expect(provider(id).capabilities.tools).toBe(true);
    expect(provider("vendor/private").capabilities).toMatchObject({ tools: true, vision: false, agentCapabilities: { toolChoiceNone: true, hostedWebSearch: true } });
    expect(provider("constructor").capabilities.tools).toBe(false);
    expect(createOpenRouter({ apiKey: "test", unknownModelCapabilities: "legacy" })("vendor/private").capabilities.tools).toBe(true);
  });
});
