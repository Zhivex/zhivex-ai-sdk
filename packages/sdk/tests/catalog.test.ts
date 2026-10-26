import { defaultModelCatalog as coreCompatibilityCatalog } from "@zhivex-ai/core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  defaultModelCatalog,
  listDefaultModelCatalogFragments
} from "../src/catalog.js";
import {
  calculateModelCost,
  defaultModelCatalog as rootDefaultModelCatalog,
  listDefaultModelCatalogFragments as listRootFragments
} from "../src/index.js";

describe("SDK model catalog ownership", () => {
  it("includes current Vertex open models without inventing retirement dates", () => {
    for (const modelId of ["zai-org/glm-5.2-maas", "deepseek-ai/deepseek-v4.1-flash-maas", "google/gemma-4-26b-a4b-it-maas", "openai/gpt-oss-120b-maas", "meta/llama-4-maverick-17b-128e-instruct-maas", "meta/llama-4-scout-17b-16e-instruct-maas"]) {
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
      snapshotVersion: "2026-10-26",
      policy: { data: "rolling", updates: "package-release" },
      pricing: {
        version: "2026-10-26",
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
    expect(defaultModelCatalog.find("meta", "muse-spark-1.3-contributor")).toMatchObject({
      provider: "meta", modelId: "muse-spark-1.3-contributor",
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    });
    const entries = defaultModelCatalog.list();
    expect(entries).toHaveLength(284);
    expect(defaultModelCatalog.find("vertex", "virtual-try-on-001")).toMatchObject({ provider: "vertex", modelId: "virtual-try-on-001" });
    expect(defaultModelCatalog.find("vertex", "multimodalembedding@001")?.lifecycle).toEqual({
      retiredAt: "2027-04-01",
      source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions"
    });
    expect(defaultModelCatalog.find("vertex", "multimodalembedding@001")?.recommendedFor).toBeUndefined();
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
    expect(fragments.reduce((total, fragment) => total + fragment.modelCount, 0)).toBe(284);
    expect(fragments.find((fragment) => fragment.provider === "openai")).toMatchObject({
      revision: "2026-10-26",
      verifiedAt: "2026-10-26",
      pricingEffectiveAt: "2026-10-26",
      sources: ["https://developers.openai.com/api/docs/models/gpt-4o-mini", "https://developers.openai.com/api/docs/deprecations", "https://developers.openai.com/api/docs/guides/conversation-state", "https://developers.openai.com/api/docs/models/gpt-6-sol", "https://developers.openai.com/api/docs/models/gpt-6-luna", "https://developers.openai.com/api/docs/models/gpt-6-astra", "https://developers.openai.com/api/docs/models/gpt-6.1-sol", "https://developers.openai.com/api/docs/models/gpt-6.1-terra", "https://developers.openai.com/api/docs/pricing", "https://openai.com/index/introducing-gpt-6-1-terra", "https://developers.openai.com/api/docs/models/gpt-image-2.5-flare", "https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst", "https://developers.openai.com/api/docs/guides/image-generation", "catalog-release:2026-08-16", "https://developers.openai.com/api/docs/guides/live"]
    });
    expect(fragments.find((fragment) => fragment.provider === "zai")).toMatchObject({
      revision: "2026-08-26",
      verifiedAt: "2026-08-26",
      pricingEffectiveAt: "2026-08-26",
      modelCount: 3
    });
    expect(fragments.find((fragment) => fragment.provider === "qwen")).toMatchObject({
      revision: "2026-10-23",
      verifiedAt: "2026-10-23",
      pricingEffectiveAt: "2026-09-18",
      modelCount: 81,
      sources: expect.arrayContaining(["https://docs.qwencloud.com/api-reference/video-generation/pixverse-image-to-video/create-task"])
    });
    for (const id of ["pixverse/pixverse-v6-t2v", "pixverse/pixverse-v6-it2v", "pixverse/pixverse-v6-kf2v", "pixverse/pixverse-v6-r2v"]) {
      expect(defaultModelCatalog.find("qwen", id)).toMatchObject({ provider: "qwen", modelId: id });
    }
    expect(Object.isFrozen(fragments[0])).toBe(true);
    expect(Object.isFrozen(fragments[0]?.sources)).toBe(true);
  });

  it("keeps Claude served by Vertex separate from direct Anthropic entries", () => {
    const entry = defaultModelCatalog.find("vertex", "claude-sonnet-4-6");
    expect(entry).toMatchObject({ provider: "vertex", modelId: "claude-sonnet-4-6" });
    expect(entry?.inputCostPer1kTokens).toBeUndefined();
    expect(entry?.recommendedFor).toBeUndefined();
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "anthropic")?.revision).toBe("2026-10-13");
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "bedrock")?.revision).toBe("2026-10-15");
    expect(defaultModelCatalog.find("bedrock", "anthropic.claude-3-5-sonnet")).toBeUndefined();
    expect(defaultModelCatalog.find("bedrock", "anthropic.claude-sonnet-5-5")?.modelId).toBe("anthropic.claude-sonnet-5-5");
    expect(defaultModelCatalog.find("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0")?.modelId).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    );
    expect(defaultModelCatalog.find("bedrock", "amazon.nova-2-lite-v1:0")?.modelId).toBe("amazon.nova-2-lite-v1:0");
    expect(defaultModelCatalog.find("azure-openai", "gpt-5.4-nano")?.modelId).toBe("gpt-5.4-nano");
    expect(defaultModelCatalog.find("azure-openai", "text-embedding-3-large")?.inputCostPer1kTokens).toBeUndefined();
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "vertex")?.revision).toBe("2026-10-20");
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "gemini")).toMatchObject({
      revision: "2026-10-20",
      verifiedAt: "2026-10-20",
      sources: expect.arrayContaining(["https://ai.google.dev/gemini-api/docs/deprecations"])
    });
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "azure-openai")).toMatchObject({
      revision: "2026-10-26",
      verifiedAt: "2026-10-26",
      sources: expect.arrayContaining(["https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule"])
    });
  });

  it("records the October 2026 frontier inventory without inventing token prices", () => {
    expect(defaultModelCatalog.find("meta", "muse-wonder-1.0")).toMatchObject({
      inputCostPer1kTokens: 0.004,
      cachedInputCostPer1kTokens: 0.0002,
      outputCostPer1kTokens: 0.02,
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    });
    expect(defaultModelCatalog.find("meta", "muse-wonder-1.0")?.contextWindowTokens).toBeUndefined();
    expect(defaultModelCatalog.find("gemini", "gemini-nano-banana-2.1")).toMatchObject({
      recommendedFor: ["vision", "speed"]
    });
    expect(defaultModelCatalog.find("vertex", "gemini-nano-banana-2.1")).toMatchObject({
      recommendedFor: ["vision", "speed"]
    });
    for (const id of ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]) {
      const entry = defaultModelCatalog.find("gemini", id);
      expect(entry).toMatchObject({ recommendedFor: ["speed"] });
      expect(entry?.inputCostPer1kTokens).toBeUndefined();
      expect(entry?.lifecycle).toBeUndefined();
    }
    expect(defaultModelCatalog.find("gemini", "gemini-4-argon")).toMatchObject({
      inputCostPer1kTokens: 0.002,
      cachedInputCostPer1kTokens: 0.0001,
      outputCostPer1kTokens: 0.01,
      recommendedFor: ["chat", "reasoning", "vision", "tools"]
    });
    expect(defaultModelCatalog.find("vertex", "gemini-4-argon")).toMatchObject({
      inputCostPer1kTokens: 0.002,
      cachedInputCostPer1kTokens: 0.0001,
      outputCostPer1kTokens: 0.01
    });
    expect(defaultModelCatalog.find("gemini", "gemini-4-argon-cyber-permissive")).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "gemini-4-argon-cyber-permissive")).toBeUndefined();
    expect(defaultModelCatalog.find("gemini", "gemini-3.7-flash")?.lifecycle).toMatchObject({
      deprecatedAt: "2026-10-08",
      source: "https://ai.google.dev/gemini-api/docs/changelog"
    });
    expect(defaultModelCatalog.find("gemini", "gemini-3.7-flash")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("gemini", "gemini-3.5-flash")).toMatchObject({
      aliases: ["gemini-flash-latest"],
      lifecycle: { deprecatedAt: "2026-10-08" }
    });
    expect(defaultModelCatalog.find("gemini", "gemini-3.5-flash")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("gemini", "gemini-3.5-flash-lite")?.lifecycle).toBeUndefined();
    expect(defaultModelCatalog.find("gemini", "gemini-3.1-flash-image")?.lifecycle).toMatchObject({
      deprecatedAt: "2026-10-06"
    });
    expect(defaultModelCatalog.find("vertex", "gemini-3.7-flash")?.lifecycle).toEqual({
      retiredAt: "2027-01-28",
      source: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions"
    });
    expect(defaultModelCatalog.find("vertex", "gemini-3.7-flash")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("gemini", "gemini-3.6-flash")?.lifecycle).toBeUndefined();
    expect(defaultModelCatalog.find("gemini", "gemini-3.6-flash")?.recommendedFor).toEqual([
      "chat", "reasoning", "speed", "vision", "tools"
    ]);
    expect(defaultModelCatalog.find("vertex", "gemini-3.5-flash")?.recommendedFor).toEqual([
      "chat", "reasoning", "speed", "vision", "tools"
    ]);
    for (const id of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
      const entry = defaultModelCatalog.find("openai", id);
      expect(entry?.recommendedFor).toEqual(["vision"]);
      for (const field of ["inputCostPer1kTokens", "outputCostPer1kTokens", "cachedInputCostPer1kTokens"]) {
        expect(entry).not.toHaveProperty(field);
      }
    }
    expect(defaultModelCatalog.find("openai", "gpt-image-2.5-flare")?.aliases).toEqual(["gpt-image-2.5-flare-2026-09-08"]);
    expect(defaultModelCatalog.find("openai", "gpt-image-2.5-sunburst")?.aliases).toEqual(["gpt-image-2.5-sunburst-2026-09-08"]);
    for (const id of ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
      const entry = defaultModelCatalog.find("azure-openai", id);
      expect(entry).toMatchObject({ recommendedFor: ["chat", "reasoning", "tools", "vision"] });
      expect(entry?.inputCostPer1kTokens).toBeUndefined();
    }
    expect(defaultModelCatalog.find("openrouter", "meta/muse-wonder")).toMatchObject({
      inputCostPer1kTokens: 0.004,
      cachedInputCostPer1kTokens: 0.0002,
      outputCostPer1kTokens: 0.02
    });
    expect(defaultModelCatalog.find("openrouter", "meta/muse-spark-open")).toMatchObject({
      inputCostPer1kTokens: 0.00125,
      cachedInputCostPer1kTokens: 0.00015,
      outputCostPer1kTokens: 0.00425,
      costPer1kTokens: 0.00125,
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    });
    expect(defaultModelCatalog.find("meta", "muse-spark-open")).toBeUndefined();
    expect(defaultModelCatalog.find("ollama", "muse-spark-open")).toMatchObject({
      inputCostPer1kTokens: 0.00125,
      cachedInputCostPer1kTokens: 0.00015,
      outputCostPer1kTokens: 0.00425,
      costPer1kTokens: 0.00125,
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    });
    expect(defaultModelCatalog.find("openrouter", "openai/gpt-4o-mini")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("openrouter", "openai/gpt-4o-mini")?.costPer1kTokens).toBe(0.0007);
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "openrouter")).toMatchObject({
      revision: "2026-10-26",
      verifiedAt: "2026-10-26",
      pricingEffectiveAt: "2026-10-26",
      modelCount: 12,
      sources: expect.arrayContaining([
        "https://openrouter.ai/meta/muse-spark-open",
        "https://research.meta.ai/blog/muse-spark-open",
        "https://dev.meta.ai/docs/muse-spark-open"
      ])
    });
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "ollama")).toMatchObject({
      revision: "2026-10-16",
      verifiedAt: "2026-10-16",
      pricingEffectiveAt: "2026-10-16",
      modelCount: 10,
      sources: expect.arrayContaining([
        "https://ollama.com/library/muse-spark-open",
        "https://research.meta.ai/blog/muse-spark-open"
      ])
    });
    expect(defaultModelCatalog.find("openrouter", "openai/gpt-6.1-sol")?.longContextPricing).toEqual({
      inputTokenThreshold: 272000, inputMultiplier: 2, outputMultiplier: 1.5
    });
    expect(defaultModelCatalog.find("openrouter", "x-ai/grok-4.7")?.longContextPricing).toEqual({
      inputTokenThreshold: 200000, inputMultiplier: 2, outputMultiplier: 2
    });
    expect(defaultModelCatalog.find("openrouter", "google/gemini-nano-banana-2.1")?.inputCostPer1kTokens).toBeUndefined();
    expect(defaultModelCatalog.find("openai", "gpt-6.1-sol")?.recommendedFor).toContain("tools");
    expect(defaultModelCatalog.find("openai", "gpt-6.1")).toBeUndefined();
    expect(defaultModelCatalog.find("openai", "gpt-6.1-terra")).toMatchObject({
      modelId: "gpt-6.1-terra",
      contextWindowTokens: 1_050_000,
      contextWindowType: "combined",
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      inputCostPer1kTokens: 0.001,
      cachedInputCostPer1kTokens: 0.00005,
      cacheWriteCostPer1kTokens: 0.00125,
      outputCostPer1kTokens: 0.005,
      longContextPricing: { inputTokenThreshold: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    });
    const terraCost = (inputTokens: number, extra: Parameters<typeof calculateModelCost>[0]["usage"] = {}) => calculateModelCost({
      catalog: defaultModelCatalog,
      provider: "openai",
      modelId: "gpt-6.1-terra",
      reasoningAccounting: "included",
      usage: { inputTokens, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000, ...extra }
    });
    expect(terraCost(1_000).components.input).toMatchObject({ ratePer1kTokens: 0.001, amount: 0.001 });
    expect(terraCost(1_000).components.output).toMatchObject({ ratePer1kTokens: 0.005, amount: 0.005 });
    expect(terraCost(272_000).longContext).toBe(false);
    expect(terraCost(272_001).longContext).toBe(true);
    expect(terraCost(272_001).components.input?.ratePer1kTokens).toBeCloseTo(0.002);
    expect(terraCost(272_001).components.output?.ratePer1kTokens).toBeCloseTo(0.0075);
    const cached = calculateModelCost({
      catalog: defaultModelCatalog,
      provider: "openai",
      modelId: "gpt-6.1-terra",
      reasoningAccounting: "included",
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 200,
        cacheWriteTokens: 300,
        cacheWriteTokensDetails: { ttl30mTokens: 100, ttl12hTokens: 200 },
        outputTokens: 0
      }
    });
    expect(cached.status).toBe("known");
    expect(cached.components.cachedInput).toMatchObject({ tokens: 200, ratePer1kTokens: 0.00005 });
    expect(cached.cacheWriteDetails?.ttl30m.ratePer1kTokens).toBeCloseTo(0.00125);
    expect(cached.cacheWriteDetails?.ttl12h.ratePer1kTokens).toBeCloseTo(0.0025);
    expect(defaultModelCatalog.find("azure-openai", "gpt-6.1-terra")).toMatchObject({
      contextWindowTokens: 1_050_000,
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    });
    expect(defaultModelCatalog.find("azure-openai", "gpt-6.1-terra")?.inputCostPer1kTokens).toBeUndefined();
    expect(calculateModelCost({
      catalog: defaultModelCatalog,
      provider: "azure-openai",
      modelId: "gpt-6.1-terra",
      usage: { inputTokens: 1_000, outputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0 },
      reasoningAccounting: "included"
    }).status).toBe("unknown");
    expect(defaultModelCatalog.find("openrouter", "openai/gpt-6.1-terra")).toMatchObject({
      inputCostPer1kTokens: 0.001,
      cachedInputCostPer1kTokens: 0.00005,
      cacheWriteCostPer1kTokens: 0.00125,
      outputCostPer1kTokens: 0.005,
      maxOutputTokens: 128_000
    });
    expect(defaultModelCatalog.find("openrouter", "openai/gpt-6.1-terra")?.longContextPricing).toBeUndefined();
    expect(defaultModelCatalog.find("xai", "grok-4.7")?.recommendedFor).toContain("reasoning");
    expect(defaultModelCatalog.find("xai", "grok-4.7")).toMatchObject({
      contextWindowTokens: 500_000,
      contextWindowType: "combined",
      inputCostPer1kTokens: 0.002,
      cachedInputCostPer1kTokens: 0.0005,
      outputCostPer1kTokens: 0.006,
      longContextPricing: {
        inputTokenThreshold: 199_999,
        inputMultiplier: 2,
        outputMultiplier: 2
      }
    });
    expect(defaultModelCatalog.find("xai", "grok-4.5")?.cachedInputCostPer1kTokens).toBeCloseTo(0.0003);
    expect(defaultModelCatalog.find("xai", "grok-4.3")).toMatchObject({
      contextWindowTokens: 1_000_000,
      inputCostPer1kTokens: 0.00125,
      cachedInputCostPer1kTokens: 0.0002,
      outputCostPer1kTokens: 0.0025
    });
    expect(defaultModelCatalog.find("xai", "grok-build-0.1")?.contextWindowTokens).toBe(256_000);
    expect(defaultModelCatalog.find("xai", "grok-4.20-0309-non-reasoning")?.recommendedFor).toEqual([
      "chat",
      "tools",
      "vision"
    ]);
    expect(defaultModelCatalog.find("xai", "grok-imagine-image-2.0")?.recommendedFor).toEqual(["vision"]);
    expect(defaultModelCatalog.find("xai", "grok-imagine-image-quality")).toMatchObject({
      lifecycle: {
        deprecatedAt: "2026-09-02",
        retiredAt: "2026-11-02",
        source: "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2"
      }
    });
    expect(defaultModelCatalog.find("xai", "grok-imagine-image-quality")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("openai", "gpt-4o-mini")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("openai", "gpt-4o-mini")?.lifecycle).toEqual({
      deprecatedAt: "2026-10-14",
      retiredAt: "2027-01-14",
      source: "https://developers.openai.com/api/docs/deprecations"
    });
    expect(defaultModelCatalog.find("azure-openai", "gpt-4o-mini")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("azure-openai", "gpt-4o-mini")?.lifecycle).toEqual({
      deprecatedAt: "2026-10-14",
      retiredAt: "2027-04-14",
      source: "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule"
    });
    const geminiDeprecations = "https://ai.google.dev/gemini-api/docs/deprecations";
    const vertexModelVersions = "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions";
    for (const modelId of ["veo-3.1-generate-preview", "veo-3.1-fast-generate-preview", "veo-3.1-lite-generate-preview"]) {
      const entry = defaultModelCatalog.find("gemini", modelId);
      expect(entry?.lifecycle).toEqual({ retiredAt: "2026-10-22", source: geminiDeprecations });
      expect(entry?.recommendedFor).toBeUndefined();
    }
    expect(defaultModelCatalog.find("gemini", "gemini-omni-flash-preview")?.lifecycle).toEqual({
      deprecatedAt: "2026-09-30",
      retiredAt: "2026-10-22",
      source: geminiDeprecations
    });
    expect(defaultModelCatalog.find("gemini", "gemini-omni-flash-preview")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("gemini", "gemini-robotics-er-1.6-preview")?.lifecycle).toEqual({
      retiredAt: "2026-08-31",
      source: geminiDeprecations
    });
    expect(defaultModelCatalog.find("gemini", "gemini-robotics-er-1.6-preview")?.recommendedFor).toBeUndefined();
    for (const modelId of ["gemini-3.1-flash-live-preview", "gemini-3.1-flash-tts-preview"]) {
      const entry = defaultModelCatalog.find("gemini", modelId);
      expect(entry?.lifecycle).toEqual({ retiredAt: "2026-11-17", source: geminiDeprecations });
      expect(entry?.recommendedFor).toBeUndefined();
    }
    expect(defaultModelCatalog.find("gemini", "gemini-3.1-flash-lite")?.lifecycle).toEqual({
      retiredAt: "2027-05-07",
      source: geminiDeprecations
    });
    expect(defaultModelCatalog.find("gemini", "gemini-3.1-flash-lite")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "gemini-3.1-flash-lite")?.lifecycle).toBeUndefined();
    expect(defaultModelCatalog.find("gemini", "gemini-2.5-flash-image")?.lifecycle).toEqual({
      retiredAt: "2027-03-15",
      source: geminiDeprecations
    });
    expect(defaultModelCatalog.find("gemini", "gemini-2.5-flash-image")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "gemini-3.6-flash")?.lifecycle).toEqual({
      retiredAt: "2026-11-19",
      source: vertexModelVersions
    });
    expect(defaultModelCatalog.find("vertex", "gemini-3.6-flash")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "gemini-live-2.5-flash-native-audio")?.lifecycle).toEqual({
      retiredAt: "2026-12-13",
      source: vertexModelVersions
    });
    expect(defaultModelCatalog.find("vertex", "gemini-live-2.5-flash-native-audio")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "gemini-2.5-flash-image")?.lifecycle).toEqual({
      retiredAt: "2027-03-15",
      source: vertexModelVersions
    });
    expect(defaultModelCatalog.find("vertex", "gemini-2.5-flash-image")?.recommendedFor).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "gemini-omni-flash-preview")?.lifecycle).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "gemini-3.1-flash-tts-preview")?.lifecycle).toBeUndefined();
    expect(defaultModelCatalog.find("vertex", "deepseek-ai/deepseek-v4.1-flash-maas")?.recommendedFor).toBeUndefined();
    for (const id of ["gpt-4o", "gpt-4.1", "gpt-4.1-mini"]) {
      expect(defaultModelCatalog.find("openai", id)).toBeUndefined();
      expect(defaultModelCatalog.find("azure-openai", id)).toBeUndefined();
    }
    for (const modelId of [
      "grok-4.6",
      "grok-4.20-0309-reasoning",
      "grok-4.20-multi-agent-0309"
    ]) {
      expect(defaultModelCatalog.find("xai", modelId)?.longContextPricing).toEqual({
        inputTokenThreshold: 199_999,
        inputMultiplier: 2,
        outputMultiplier: 2
      });
    }
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "xai")).toMatchObject({
      revision: "2026-10-15",
      verifiedAt: "2026-10-15",
      pricingEffectiveAt: "2026-10-14",
      modelCount: 10,
      sources: expect.arrayContaining(["https://docs.x.ai/docs/models"])
    });
    expect(defaultModelCatalog.find("kimi", "kimi-k3.1-pro")).toMatchObject({
      provider: "kimi",
      modelId: "kimi-k3.1-pro",
      contextWindowTokens: 1_048_576,
      contextWindowType: "combined",
      maxOutputTokens: 1_048_576,
      inputCostPer1kTokens: 0.002,
      cachedInputCostPer1kTokens: 0.0002,
      cacheWriteCostPer1kTokens: 0.002,
      outputCostPer1kTokens: 0.01,
      costPer1kTokens: 0.002,
      recommendedFor: ["chat", "reasoning", "tools", "vision"]
    });
    expect(defaultModelCatalog.find("kimi", "kimi-k3.1-pro-highspeed")).toMatchObject({
      provider: "kimi",
      modelId: "kimi-k3.1-pro-highspeed",
      contextWindowTokens: 1_048_576,
      contextWindowType: "combined",
      maxOutputTokens: 1_048_576,
      inputCostPer1kTokens: 0.004,
      cachedInputCostPer1kTokens: 0.0002,
      cacheWriteCostPer1kTokens: 0.004,
      outputCostPer1kTokens: 0.02,
      recommendedFor: ["chat", "reasoning", "tools", "vision", "speed"]
    });
    expect(defaultModelCatalog.find("kimi", "kimi-k3.1-pro")?.maxInputTokens).toBeUndefined();
    expect(listDefaultModelCatalogFragments().find((fragment) => fragment.provider === "kimi")).toMatchObject({
      revision: "2026-10-24",
      verifiedAt: "2026-10-24",
      modelCount: 5,
      sources: expect.arrayContaining([
        "https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart",
        "https://platform.kimi.ai/docs/pricing/chat"
      ])
    });
    expect(defaultModelCatalog.find("kimi", "kimi-k2.5")).toBeUndefined();
    expect(defaultModelCatalog.find("openrouter", "google/gemini-3.8-flash-tts")).toBeUndefined();
    for (const id of ["qwen-image-2.1-pro", "qwen-image-2.1-turbo"]) {
      const entry = defaultModelCatalog.find("qwen", id);
      expect(entry).toMatchObject({ recommendedFor: ["vision"] });
      expect(entry?.inputCostPer1kTokens).toBeUndefined();
    }
  });

  it("does not derive the release-managed snapshot from the frozen core compatibility copy", () => {
    const source = readFileSync(new URL("../src/catalog.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(
      /import\s*\{[^}]*defaultModelCatalog[^}]*\}\s*from\s*["']@zhivex-ai\/core["']/su
    );
  });
});
