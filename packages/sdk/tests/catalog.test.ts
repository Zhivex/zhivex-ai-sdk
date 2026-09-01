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
  it("exports the SDK-owned snapshot from both public entrypoints", () => {
    expect(rootDefaultModelCatalog).toBe(defaultModelCatalog);
    expect(defaultModelCatalog).not.toBe(coreCompatibilityCatalog);
    expect(defaultModelCatalog.metadata).toMatchObject({
      snapshotVersion: "2026-08-26",
      policy: { data: "rolling", updates: "package-release" },
      pricing: {
        version: "2026-08-26",
        source: "zhivex-ai-sdk-default-catalog"
      }
    });
    expect(defaultModelCatalog.find("openai", "gpt-5.6")?.modelId).toBe("gpt-5.6-sol");
    const entries = defaultModelCatalog.list();
    expect(entries).toHaveLength(107);
    expect(defaultModelCatalog.find("zai", "glm-5.3-flash")).toMatchObject({
      inputCostPer1kTokens: 0.00015,
      cachedInputCostPer1kTokens: 0.00003,
      outputCostPer1kTokens: 0.0005,
      recommendedFor: ["chat", "tools", "reasoning", "vision", "speed"]
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
    expect(fragments.reduce((total, fragment) => total + fragment.modelCount, 0)).toBe(107);
    expect(fragments.find((fragment) => fragment.provider === "openai")).toMatchObject({
      revision: "2026-08-16",
      verifiedAt: "2026-08-16",
      pricingEffectiveAt: "2026-08-16",
      sources: ["catalog-release:2026-08-16"]
    });
    expect(fragments.find((fragment) => fragment.provider === "zai")).toMatchObject({
      revision: "2026-08-26",
      verifiedAt: "2026-08-26",
      pricingEffectiveAt: "2026-08-26",
      modelCount: 3
    });
    expect(fragments.find((fragment) => fragment.provider === "qwen")).toMatchObject({
      revision: "2026-08-26",
      verifiedAt: "2026-08-26",
      pricingEffectiveAt: "2026-08-26",
      modelCount: 17
    });
    expect(Object.isFrozen(fragments[0])).toBe(true);
    expect(Object.isFrozen(fragments[0]?.sources)).toBe(true);
  });

  it("does not derive the release-managed snapshot from the frozen core compatibility copy", () => {
    const source = readFileSync(new URL("../src/catalog.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(
      /import\s*\{[^}]*defaultModelCatalog[^}]*\}\s*from\s*["']@zhivex-ai\/core["']/su
    );
  });
});
