import { describe, expect, it } from "vitest";

import {
  MODEL_CATALOG_CONTRACT_VERSION,
  MODEL_CATALOG_SCHEMA_VERSION,
  createModelCatalog,
  defaultModelCatalog,
  type ModelCatalogEntry
} from "../src/catalog.js";

describe("model catalog stable snapshot contract", () => {
  it("preserves the one-argument API with pinned custom metadata", () => {
    const catalog = createModelCatalog([
      { provider: "openai", modelId: "gpt-test", aliases: ["test"], costPer1kTokens: 0.5 }
    ]);

    expect(catalog.find("openai", "test")).toMatchObject({ modelId: "gpt-test" });
    expect(catalog.metadata).toEqual({
      schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
      contractVersion: MODEL_CATALOG_CONTRACT_VERSION,
      snapshotVersion: "custom",
      policy: { data: "pinned", updates: "never" }
    });
  });

  it("takes a deep snapshot and returns defensive copies", () => {
    const entry: ModelCatalogEntry = {
      provider: "openai",
      modelId: "gpt-test",
      aliases: ["test"],
      inputCostPer1kTokens: 0.1,
      outputCostPer1kTokens: 0.2,
      longContextPricing: {
        inputTokenThreshold: 10_000,
        inputMultiplier: 2,
        outputMultiplier: 1.5
      },
      recommendedFor: ["chat", "tools"]
    };
    const entries = [entry];
    const catalog = createModelCatalog(entries, {
      snapshotVersion: "models-1",
      policy: { data: "rolling", updates: "catalog-replacement" },
      pricing: {
        version: "prices-1",
        currency: "USD",
        unit: "per_1k_tokens",
        effectiveAt: "2026-08-16"
      }
    });

    entry.modelId = "mutated-input";
    entry.aliases?.push("mutated-alias");
    if (entry.longContextPricing) entry.longContextPricing.inputMultiplier = 99;
    entry.recommendedFor?.push("vision");
    entries.push({ provider: "openai", modelId: "late-entry" });

    const found = catalog.find("openai", "test");
    expect(found).toEqual({
      provider: "openai",
      modelId: "gpt-test",
      aliases: ["test"],
      inputCostPer1kTokens: 0.1,
      outputCostPer1kTokens: 0.2,
      longContextPricing: {
        inputTokenThreshold: 10_000,
        inputMultiplier: 2,
        outputMultiplier: 1.5
      },
      recommendedFor: ["chat", "tools"]
    });
    expect(catalog.find("openai", "mutated-input")).toBeUndefined();
    expect(catalog.find("openai", "mutated-alias")).toBeUndefined();
    expect(catalog.find("openai", "late-entry")).toBeUndefined();

    if (!found) throw new Error("expected catalog entry");
    found.modelId = "mutated-output";
    found.aliases?.push("output-alias");
    if (found.longContextPricing) found.longContextPricing.inputMultiplier = 42;
    found.recommendedFor?.push("vision");
    const listed = catalog.list();
    listed[0]!.modelId = "mutated-list";
    listed[0]!.aliases?.push("list-alias");
    listed.push({ provider: "openai", modelId: "output-entry" });

    expect(catalog.find("openai", "test")).toMatchObject({
      modelId: "gpt-test",
      aliases: ["test"],
      longContextPricing: { inputMultiplier: 2 },
      recommendedFor: ["chat", "tools"]
    });
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.find("openai", "output-alias")).toBeUndefined();
    expect(catalog.find("openai", "list-alias")).toBeUndefined();
  });

  it("returns defensive metadata copies for an explicitly versioned snapshot", () => {
    const catalog = createModelCatalog([], {
      snapshotVersion: "models-2026-08",
      publishedAt: "2026-08-16T12:30:00.000Z",
      policy: { data: "rolling", updates: "catalog-replacement" },
      pricing: {
        version: "pricing-7",
        currency: "USD",
        unit: "per_1k_tokens",
        effectiveAt: "2026-08-01",
        source: "internal-rate-card"
      }
    });

    expect(catalog.metadata).toEqual({
      schemaVersion: 1,
      contractVersion: "1",
      snapshotVersion: "models-2026-08",
      publishedAt: "2026-08-16T12:30:00.000Z",
      policy: { data: "rolling", updates: "catalog-replacement" },
      pricing: {
        version: "pricing-7",
        currency: "USD",
        unit: "per_1k_tokens",
        effectiveAt: "2026-08-01",
        source: "internal-rate-card"
      }
    });

    const metadata = catalog.metadata;
    metadata.snapshotVersion = "mutated";
    metadata.policy.data = "pinned";
    if (metadata.pricing) metadata.pricing.version = "mutated";

    expect(catalog.metadata).toMatchObject({
      snapshotVersion: "models-2026-08",
      policy: { data: "rolling" },
      pricing: { version: "pricing-7" }
    });
  });

  it.each([
    ["empty provider", { provider: "", modelId: "model" }, "provider"],
    ["provider whitespace", { provider: " openai", modelId: "model" }, "provider"],
    ["empty model ID", { provider: "openai", modelId: "" }, "modelId"],
    ["model ID control character", { provider: "openai", modelId: "bad\nmodel" }, "modelId"],
    ["non-array aliases", { provider: "openai", modelId: "model", aliases: "alias" }, "aliases"],
    ["empty alias", { provider: "openai", modelId: "model", aliases: [""] }, "aliases"],
    ["duplicate alias", { provider: "openai", modelId: "model", aliases: ["alias", "alias"] }, "duplicate alias"],
    ["empty recommendations", { provider: "openai", modelId: "model", recommendedFor: [] }, "recommendedFor"],
    ["unknown recommendation", { provider: "openai", modelId: "model", recommendedFor: ["coding"] }, "recommendedFor"],
    ["duplicate recommendation", { provider: "openai", modelId: "model", recommendedFor: ["chat", "chat"] }, "duplicate value"],
    ["unknown field", { provider: "openai", modelId: "model", contextWindow: 10 }, "not a supported"],
    [
      "unknown long-context field",
      {
        provider: "openai",
        modelId: "model",
        costPer1kTokens: 1,
        longContextPricing: {
          inputTokenThreshold: 1,
          inputMultiplier: 2,
          outputMultiplier: 2,
          extra: true
        }
      },
      "longContextPricing.extra is not supported"
    ]
  ])("rejects %s", (_name, entry, expectedMessage) => {
    expect(() => createModelCatalog([entry as unknown as ModelCatalogEntry])).toThrow(expectedMessage);
  });

  it.each([
    "inputCostPer1kTokens",
    "cachedInputCostPer1kTokens",
    "cacheWriteCostPer1kTokens",
    "outputCostPer1kTokens",
    "costPer1kTokens"
  ] as const)("rejects invalid %s pricing", (field) => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createModelCatalog([{ provider: "openai", modelId: "model", [field]: value }])
      ).toThrow(`${field} must be a finite, non-negative number`);
    }
  });

  it.each([
    [
      "threshold",
      { inputTokenThreshold: 0, inputMultiplier: 2, outputMultiplier: 2 },
      "inputTokenThreshold"
    ],
    [
      "fractional threshold",
      { inputTokenThreshold: 1.5, inputMultiplier: 2, outputMultiplier: 2 },
      "inputTokenThreshold"
    ],
    [
      "input multiplier",
      { inputTokenThreshold: 1, inputMultiplier: 0, outputMultiplier: 2 },
      "inputMultiplier"
    ],
    [
      "output multiplier",
      { inputTokenThreshold: 1, inputMultiplier: 2, outputMultiplier: Number.POSITIVE_INFINITY },
      "outputMultiplier"
    ]
  ])("rejects invalid long-context %s", (_name, longContextPricing, expectedMessage) => {
    expect(() =>
      createModelCatalog([
        { provider: "openai", modelId: "model", costPer1kTokens: 1, longContextPricing }
      ])
    ).toThrow(expectedMessage);
  });

  it("rejects long-context multipliers without base token pricing", () => {
    expect(() =>
      createModelCatalog([
        {
          provider: "openai",
          modelId: "model",
          longContextPricing: { inputTokenThreshold: 1, inputMultiplier: 2, outputMultiplier: 2 }
        }
      ])
    ).toThrow("requires input, output, or fallback token pricing");
  });

  it("rejects canonical and alias collisions within a provider", () => {
    const invalidCatalogs: ModelCatalogEntry[][] = [
      [
        { provider: "openai", modelId: "a" },
        { provider: "openai", modelId: "a" }
      ],
      [
        { provider: "openai", modelId: "a" },
        { provider: "openai", modelId: "b", aliases: ["a"] }
      ],
      [
        { provider: "openai", modelId: "a", aliases: ["b"] },
        { provider: "openai", modelId: "b" }
      ],
      [
        { provider: "openai", modelId: "a", aliases: ["shared"] },
        { provider: "openai", modelId: "b", aliases: ["shared"] }
      ],
      [{ provider: "openai", modelId: "a", aliases: ["a"] }]
    ];

    for (const entries of invalidCatalogs) {
      expect(() => createModelCatalog(entries)).toThrow(/identifier .* collides/u);
    }

    expect(() =>
      createModelCatalog([
        { provider: "openai", modelId: "shared" },
        { provider: "anthropic", modelId: "shared" }
      ])
    ).not.toThrow();
  });

  it.each([
    ["empty snapshot version", { snapshotVersion: "" }, "snapshotVersion"],
    ["invalid publication date", { publishedAt: "tomorrow" }, "publishedAt"],
    ["impossible publication date", { publishedAt: "2026-02-31" }, "publishedAt"],
    [
      "pinned changing policy",
      { policy: { data: "pinned", updates: "package-release" } },
      "must pair pinned data"
    ],
    ["rolling never policy", { policy: { data: "rolling", updates: "never" } }, "must pair pinned data"],
    [
      "empty pricing version",
      { pricing: { version: "", currency: "USD", unit: "per_1k_tokens" } },
      "pricing.version"
    ],
    [
      "invalid pricing currency",
      { pricing: { version: "1", currency: "usd", unit: "per_1k_tokens" } },
      "pricing.currency"
    ],
    [
      "invalid pricing unit",
      { pricing: { version: "1", currency: "USD", unit: "tokens" } },
      "pricing.unit"
    ],
    [
      "invalid pricing effective date",
      { pricing: { version: "1", currency: "USD", unit: "per_1k_tokens", effectiveAt: "invalid" } },
      "effectiveAt"
    ]
  ])("rejects %s metadata", (_name, options, expectedMessage) => {
    expect(() => createModelCatalog([], options as never)).toThrow(expectedMessage);
  });

  it("declares the default catalog as an immutable rolling package snapshot", () => {
    expect(defaultModelCatalog.metadata).toEqual({
      schemaVersion: 1,
      contractVersion: "1",
      snapshotVersion: "2026-08-16",
      publishedAt: "2026-08-16T00:00:00.000Z",
      policy: { data: "rolling", updates: "package-release" },
      pricing: {
        version: "2026-08-16",
        currency: "USD",
        unit: "per_1k_tokens",
        effectiveAt: "2026-08-16",
        source: "zhivex-ai-sdk-default-catalog"
      }
    });

    const entries = defaultModelCatalog.list();
    expect(entries.length).toBeGreaterThan(90);
    const identifiers = new Set<string>();
    for (const entry of entries) {
      for (const identifier of [entry.modelId, ...(entry.aliases ?? [])]) {
        const key = `${entry.provider}\u0000${identifier}`;
        expect(identifiers.has(key)).toBe(false);
        identifiers.add(key);
      }
    }

    entries[0]!.modelId = "mutated-default";
    expect(defaultModelCatalog.find("openai", "gpt-5.6")).toMatchObject({ modelId: "gpt-5.6-sol" });
    expect(defaultModelCatalog.find("openai", "mutated-default")).toBeUndefined();
  });
});
