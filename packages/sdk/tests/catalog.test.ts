import { defaultModelCatalog as coreCompatibilityCatalog } from "@zhivex-ai/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  defaultModelCatalog,
  listDefaultModelCatalogFragments
} from "../src/catalog.js";
import {
  defaultModelCatalog as rootDefaultModelCatalog,
  listDefaultModelCatalogFragments as listRootFragments
} from "../src/index.js";

describe("SDK model catalog ownership", () => {
  it("includes current Vertex open models without inventing retirement dates", () => {
    for (const modelId of ["zai-org/glm-5.2-maas", "google/gemma-4-26b-a4b-it-maas", "openai/gpt-oss-120b-maas", "meta/llama-4-maverick-17b-128e-instruct-maas", "meta/llama-4-scout-17b-16e-instruct-maas"]) {
      const entry = defaultModelCatalog.find("vertex", modelId);
      expect(entry).toMatchObject({ provider: "vertex", modelId });
      expect(entry?.lifecycle?.retiredAt).toBeUndefined();
      expect(entry?.inputCostPer1kTokens).toBeUndefined();
    }
  });
  it("records Vertex MaaS retirement without assigning direct-provider pricing", () => {
    const entry = defaultModelCatalog.find("vertex", "deepseek-ai/deepseek-v3.2-maas");
    expect(entry?.lifecycle).toMatchObject({ deprecatedAt: "2026-07-21", retiredAt: "2026-10-21" });
    expect(entry?.inputCostPer1kTokens).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "xai/grok-4.1-fast-reasoning")?.lifecycle?.retiredAt).toBe("2026-08-20");
    expect(defaultModelCatalog.find("vertex", "xai/grok-4.3")?.lifecycle).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "mistralai/codestral-2")).toBeDefined();
    expect(defaultModelCatalog.find("vertex", "lyria-3-pro-preview")).toBeDefined();
    for (const id of ["ai21/jamba-1.5-mini", "ai21/jamba-1.5-large"]) expect(defaultModelCatalog.find("vertex", id)?.lifecycle).toMatchObject({ deprecatedAt: "2025-08-27", retiredAt: "2026-02-27" });
    for (const id of ["gemini-omni-flash-preview", "gemini-omni-1.1-flash-preview"]) expect(defaultModelCatalog.find("vertex", id)).toBeDefined();
    expect(coreCompatibilityCatalog.find("vertex", "deepseek-ai/deepseek-v3.2-maas")).toBeUndefined();
  });
  it("exports the SDK-owned snapshot from both public entrypoints", () => {
    expect(rootDefaultModelCatalog).toBe(defaultModelCatalog);
    expect(defaultModelCatalog).not.toBe(coreCompatibilityCatalog);
    expect(defaultModelCatalog.metadata).toMatchObject({
      snapshotVersion: "2026-09-22",
      policy: { data: "rolling", updates: "package-release" },
      pricing: {
        version: "2026-09-22",
        source: "zhivex-ai-sdk-default-catalog"
      }
    });
    expect(defaultModelCatalog.find("openai", "gpt-5.6")?.modelId).toBe("gpt-5.6-sol");
    expect(defaultModelCatalog.find("openai", "gpt-live-1")).toMatchObject({ modelId: "gpt-live-1" });
    expect(defaultModelCatalog.find("openai", "gpt-live-1")?.inputCostPer1kTokens).toBeUndefined();
    expect(defaultModelCatalog.find("deepseek", "deepseek-v4-flash")?.modelId).toBe("deepseek-flash");
    expect(defaultModelCatalog.find("deepseek", "deepseek-v4-flash-vision-exp")?.modelId).toBe("deepseek-flash");
    for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
      const entry = defaultModelCatalog.find("deepseek", id);
      expect(entry).toBeDefined();
      for (const field of ["costPer1kTokens", "inputCostPer1kTokens", "outputCostPer1kTokens", "cachedInputCostPer1kTokens"]) {
        expect(entry).not.toHaveProperty(field);
      }
    }
    for (const id of ["deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-pro-0813", "deepseek-v4-flash-0731", "glm-5.2", "glm-5.3", "ZHIPU/GLM-5.3", "kimi-k3", "MiniMax-M2.5"]) {
      expect(defaultModelCatalog.find("qwen", id)).toMatchObject({ provider: "qwen", modelId: id });
    }
    expect(defaultModelCatalog.find("gemini", "gemini-3.8-live-extended-thinking")).toBeDefined();
    const entries = defaultModelCatalog.list();
    expect(entries).toHaveLength(181);
    expect(defaultModelCatalog.find("vertex", "virtual-try-on-001")).toMatchObject({ provider: "vertex", modelId: "virtual-try-on-001" });
    expect(defaultModelCatalog.find("vertex", "multimodalembedding@001")).toBeDefined();
    expect(defaultModelCatalog.find("zai", "glm-5.3-flash")).toMatchObject({
      inputCostPer1kTokens: 0.00015,
      cachedInputCostPer1kTokens: 0.00003,
      outputCostPer1kTokens: 0.0005,
      recommendedFor: ["chat", "tools", "reasoning", "vision", "speed"]
    });
    expect(defaultModelCatalog.find("qwen", "qwen3.8-omni-flash")).toMatchObject({
      inputCostPer1kTokens: 0.00015,
      cachedInputCostPer1kTokens: 0.000016,
      outputCostPer1kTokens: 0.00047
    });
    expect(defaultModelCatalog.find("qwen", "qwen3.8-flash")).toMatchObject({
      inputCostPer1kTokens: 0.00016,
      cachedInputCostPer1kTokens: 0.000016,
      outputCostPer1kTokens: 0.00047,
      recommendedFor: ["chat", "speed", "tools", "reasoning", "vision"]
    });
    expect([...new Set(entries.map((entry) => entry.provider))].sort()).toEqual([
      "anthropic",
      "azure-openai",
      "bedrock",
      "deepseek",
      "gemini",
      "kimi",
      "meta",
      "ollama",
      "openai",
      "openrouter",
      "qwen",
      "vertex",
      "xai",
      "zai"
    ]);
  });

  it("publishes immutable provider-scoped freshness and provenance metadata", () => {
    expect(listRootFragments).toBe(listDefaultModelCatalogFragments);
    const fragments = listDefaultModelCatalogFragments();
    expect(fragments).toHaveLength(14);
    expect(fragments.reduce((total, fragment) => total + fragment.modelCount, 0)).toBe(181);
    expect(fragments.find((fragment) => fragment.provider === "openai")).toMatchObject({
      revision: "2026-09-22",
      verifiedAt: "2026-09-22",
      pricingEffectiveAt: "2026-09-22",
      sources: ["https://developers.openai.com/api/docs/models/gpt-6-sol", "https://developers.openai.com/api/docs/models/gpt-6-luna", "https://developers.openai.com/api/docs/models/gpt-6-astra", "catalog-release:2026-08-16", "https://developers.openai.com/api/docs/guides/live"]
    });
    expect(fragments.find((fragment) => fragment.provider === "zai")).toMatchObject({
      revision: "2026-08-26",
      verifiedAt: "2026-08-26",
      pricingEffectiveAt: "2026-08-26",
      modelCount: 3
    });
    expect(fragments.find((fragment) => fragment.provider === "qwen")).toMatchObject({
      revision: "2026-09-20",
      verifiedAt: "2026-09-20",
      pricingEffectiveAt: "2026-09-18",
      modelCount: 31
    });
    expect(Object.isFrozen(fragments[0])).toBe(true);
    expect(Object.isFrozen(fragments[0]?.sources)).toBe(true);
  });

  it("keeps Claude served by Vertex separate from direct Anthropic entries", () => {
    const entry = defaultModelCatalog.find("vertex", "claude-sonnet-4-6");
    expect(entry).toMatchObject({ provider: "vertex", modelId: "claude-sonnet-4-6" });
    expect(entry?.inputCostPer1kTokens).toBeUndefined();
    expect(entry?.recommendedFor).toBeUndefined();
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "vertex")?.revision).toBe("2026-09-19");
  });

  it("does not derive the release-managed snapshot from the frozen core compatibility copy", () => {
    const source = readFileSync(new URL("../src/catalog.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(
      /import\s*\{[^}]*defaultModelCatalog[^}]*\}\s*from\s*["']@zhivex-ai\/core["']/su
    );
  });
});
