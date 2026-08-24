import { describe, expect, it } from "vitest";

import { createModelCatalog } from "../src/catalog.js";
import { generateText } from "../src/generate-text.js";
import {
  ModelResolutionError,
  createModelResolver,
  type ModelResolutionMetadata
} from "../src/model-resolver.js";
import type { LanguageModel, ProviderAdapter } from "../src/types.js";

const capabilities: LanguageModel["capabilities"] = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: true,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: true,
  webSearch: false,
  reasoningEfforts: ["low", "high"]
};

const createTestAdapter = (
  runtimeProvider = "openai",
  counters: { factories: number; generates: number } = { factories: 0, generates: 0 }
): ProviderAdapter => ({
  name: runtimeProvider,
  languageModel(modelId) {
    counters.factories += 1;
    return {
      provider: runtimeProvider,
      modelId,
      capabilities,
      async generate() {
        counters.generates += 1;
        return {
          text: `${runtimeProvider}/${modelId}`,
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        };
      }
    };
  }
});

const catalog = createModelCatalog(
  [
    {
      provider: "openai",
      modelId: "gpt-test",
      aliases: ["gpt-current"],
      inputCostPer1kTokens: 0.1,
      outputCostPer1kTokens: 0.2,
      recommendedFor: ["chat", "tools"]
    },
    { provider: "openai", modelId: "gpt-fast", costPer1kTokens: 0.05 }
  ],
  {
    snapshotVersion: "test-1",
    pricing: { version: "prices-1", currency: "USD", unit: "per_1k_tokens" }
  }
);

describe("explicit model resolver Beta contract", () => {
  it("resolves explicit and catalog-aliased identifiers with frozen trace and budget metadata", () => {
    const decisions: ModelResolutionMetadata[] = [];
    const resolver = createModelResolver({
      adapters: { openai: createTestAdapter() },
      catalog,
      onResolve: (metadata) => decisions.push(metadata)
    });

    const resolution = resolver.resolve("openai/gpt-current");

    expect(resolution.model.modelId).toBe("gpt-test");
    expect(resolution.metadata).toMatchObject({
      schemaVersion: 1,
      identifier: "openai/gpt-current",
      requested: { provider: "openai", modelId: "gpt-current" },
      resolved: { provider: "openai", modelId: "gpt-test" },
      source: { kind: "adapter", name: "openai" },
      catalog: {
        contractVersion: "1",
        snapshotVersion: "test-1",
        pricingVersion: "prices-1",
        currency: "USD"
      },
      catalogEntry: {
        inputCostPer1kTokens: 0.1,
        outputCostPer1kTokens: 0.2,
        recommendedFor: ["chat", "tools"]
      },
      capabilities: { tools: true, reasoning: true }
    });
    expect(decisions).toEqual([resolution.metadata]);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.metadata)).toBe(true);
    expect(Object.isFrozen(resolution.metadata.capabilities)).toBe(true);
    expect(Object.isFrozen(resolution.metadata.capabilities.reasoningEfforts)).toBe(true);
    expect(Object.isFrozen(resolution.metadata.catalogEntry)).toBe(true);
    expect(Object.isFrozen(resolution.metadata.catalogEntry.aliases)).toBe(true);
  });

  it("snapshots application aliases and rejects collisions at registry construction", () => {
    const aliases = [{ alias: "fast", target: "openai/gpt-fast" }];
    const resolver = createModelResolver({
      adapters: { openai: createTestAdapter() },
      aliases,
      catalog
    });
    aliases[0] = { alias: "fast", target: "openai/gpt-test" };
    aliases.push({ alias: "later", target: "openai/gpt-test" });

    expect(resolver.resolve("fast").metadata).toMatchObject({
      alias: "fast",
      requested: { provider: "openai", modelId: "gpt-fast" },
      resolved: { provider: "openai", modelId: "gpt-fast" }
    });
    expect(() => resolver.resolve("later")).toThrowError(
      expect.objectContaining({ code: "unknown_alias" })
    );
    expect(() =>
      createModelResolver({
        adapters: { openai: createTestAdapter() },
        aliases: [
          { alias: "same", target: "openai/gpt-test" },
          { alias: "same", target: "openai/gpt-fast" }
        ],
        catalog
      })
    ).toThrowError(expect.objectContaining({ code: "alias_collision" }));
    expect(() =>
      createModelResolver({
        adapters: { openai: createTestAdapter() },
        aliases: [{ alias: "openai/gpt-test", target: "openai/gpt-fast" }],
        catalog
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_configuration" }));
  });

  it("fails unknown providers, models, aliases, and malformed IDs before invoking a factory", () => {
    const counters = { factories: 0, generates: 0 };
    const resolver = createModelResolver({
      adapters: { openai: createTestAdapter("openai", counters) },
      catalog
    });

    const cases = [
      ["anthropic/claude", "unknown_provider"],
      ["openai/missing", "unknown_model"],
      ["missing-alias", "unknown_alias"],
      ["/missing-provider", "invalid_identifier"],
      ["openai/", "invalid_identifier"]
    ] as const;

    for (const [identifier, code] of cases) {
      try {
        resolver.resolve(identifier);
        throw new Error("expected resolution to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelResolutionError);
        expect(error).toMatchObject({ code });
      }
    }
    expect(counters).toEqual({ factories: 0, generates: 0 });

    const secretLikeInput = "openai/sk-private-example";
    try {
      resolver.resolve(secretLikeInput);
      throw new Error("expected resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelResolutionError);
      expect(String(error)).not.toContain(secretLikeInput);
      expect(JSON.stringify((error as ModelResolutionError).details)).not.toContain("sk-private-example");
    }
  });

  it("rejects catalog providers inherited by the adapter snapshot prototype", () => {
    const inheritedProviderCatalog = createModelCatalog([
      { provider: "constructor", modelId: "prototype-model" }
    ]);
    const resolver = createModelResolver({
      adapters: { openai: createTestAdapter() },
      catalog: inheritedProviderCatalog
    });

    expect(() => resolver.resolve("constructor/prototype-model")).toThrowError(
      expect.objectContaining({ code: "unknown_provider" })
    );
  });

  it("supports an explicitly named backend without changing canonical catalog identity", () => {
    const references: Array<{ provider: string; modelId: string }> = [];
    const resolver = createModelResolver({
      backend: {
        name: "vercel-ai-gateway",
        languageModel(reference) {
          references.push(reference);
          return createTestAdapter("vercel-ai-gateway").languageModel(
            `${reference.provider}/${reference.modelId}`
          );
        }
      },
      catalog
    });

    const resolution = resolver.resolve("openai/gpt-test");
    expect(references).toEqual([{ provider: "openai", modelId: "gpt-test" }]);
    expect(resolution.metadata).toMatchObject({
      resolved: { provider: "openai", modelId: "gpt-test" },
      source: { kind: "backend", name: "vercel-ai-gateway" }
    });
  });

  it("keeps concurrent registries isolated", async () => {
    const first = createModelResolver({
      adapters: { openai: createTestAdapter("openai-a") },
      aliases: [{ alias: "current", target: "openai/gpt-test" }],
      catalog
    });
    const second = createModelResolver({
      adapters: { openai: createTestAdapter("openai-b") },
      aliases: [{ alias: "current", target: "openai/gpt-fast" }],
      catalog
    });

    const [a, b] = await Promise.all([
      Promise.resolve().then(() => first.resolve("current")),
      Promise.resolve().then(() => second.resolve("current"))
    ]);

    expect(a.metadata).toMatchObject({
      resolved: { modelId: "gpt-test" }
    });
    expect(b.metadata).toMatchObject({
      resolved: { modelId: "gpt-fast" }
    });
  });

  it("keeps direct factories canonical and behavior-equivalent to the convenience model path", async () => {
    const adapter = createTestAdapter();
    const resolver = createModelResolver({ adapters: { openai: adapter }, catalog });

    const direct = await generateText({
      model: adapter.languageModel("gpt-test"),
      prompt: "contract"
    });
    const resolved = await generateText({
      model: resolver.model("openai/gpt-test"),
      prompt: "contract"
    });

    expect(resolved).toEqual(direct);
    expect(resolved.text).toBe("openai/gpt-test");
  });

  it("rejects malformed models returned by a configured source before a network call", () => {
    const resolver = createModelResolver({
      adapters: {
        openai: {
          name: "openai",
          languageModel: () => ({ provider: "openai" }) as unknown as LanguageModel
        }
      },
      catalog
    });

    expect(() => resolver.resolve("openai/gpt-test")).toThrowError(
      expect.objectContaining({ code: "invalid_resolved_model" })
    );
  });

  it("allowlists capability metadata instead of copying source-specific fields", () => {
    const secret = "sk-source-only-example";
    const resolver = createModelResolver({
      adapters: {
        openai: {
          name: "openai",
          languageModel(modelId) {
            return {
              provider: "openai",
              modelId,
              capabilities: {
                ...capabilities,
                apiKey: secret,
                realtime: {
                  sessions: true,
                  audioInput: true,
                  audioOutput: true,
                  imageInput: true,
                  tools: true,
                  browserTokens: true,
                  apiKey: secret
                }
              } as LanguageModel["capabilities"],
              async generate() {
                return { text: "ok" };
              }
            };
          }
        }
      },
      catalog
    });

    const metadata = resolver.resolve("openai/gpt-test").metadata;
    expect(JSON.stringify(metadata)).not.toContain(secret);
    expect("apiKey" in metadata.capabilities).toBe(false);
    expect(metadata.capabilities.realtime).toEqual({
      sessions: true,
      audioInput: true,
      audioOutput: true,
      imageInput: true,
      tools: true,
      browserTokens: true
    });
    expect("apiKey" in (metadata.capabilities.realtime ?? {})).toBe(false);
  });
});
