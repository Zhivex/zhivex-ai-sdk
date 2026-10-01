import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "@zhivex-ai/core";
import { createOpenAI } from "../src/index.js";
import { resolveOpenAIModelProfile } from "../src/model-profiles.js";

const messages = [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }];
const tools = { echo: tool({ name: "echo", schema: z.object({}), execute: () => "ok" }) };

describe("OpenAI model profile policy", () => {
  it("uses conservative metadata and rejects advanced features before network for unknown IDs", async () => {
    const fetcher = vi.fn();
    const model = createOpenAI({ apiKey: "test", fetch: fetcher })("unrecognized-model");
    expect(model.capabilities).toMatchObject({ streaming: true, tools: false, vision: false, structuredOutput: false, reasoning: false });
    for (const input of [{ messages, tools }, { messages, structuredOutput: { mode: "native" as const, schema: z.object({}) } }, { messages, reasoning: { effort: "low" as const }, providerOptions: { apiMode: "responses" as const } }]) {
      await expect(model.generate(input)).rejects.toThrow("no declared");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("supports explicit migration and nested per-ID declarations without inherited overrides", () => {
    expect(createOpenAI({ apiKey: "test", unknownModelCapabilities: "legacy" })("private-model").capabilities.tools).toBe(true);
    const provider = createOpenAI({ apiKey: "test", modelCapabilities: { "private-model": { tools: true, agentCapabilities: { toolChoiceNone: true } } } });
    expect(provider("private-model").capabilities.agentCapabilities).toMatchObject({ supportTier: "tier-c", toolChoiceNone: true, hostedWebSearch: false });
    expect(provider("constructor").capabilities.tools).toBe(false);
  });

  it("couples family reasoning, sampling and default transport", () => {
    expect(resolveOpenAIModelProfile("gpt-6-astra")).toMatchObject({ defaultApi: "responses", sampling: "unsupported", toolsRequireResponses: "always" });
    expect(resolveOpenAIModelProfile("gpt-6-sol")).toMatchObject({ defaultApi: "responses", sampling: "effort-none", toolsRequireResponses: "unless-effort-none" });
    expect(createOpenAI({ apiKey: "test" })("gpt-4-0613").capabilities.tools).toBe(true);
    expect(createOpenAI({ apiKey: "test" })("gpt-6-astra-2026-01-01-extra").capabilities.tools).toBe(false);
  });
});
