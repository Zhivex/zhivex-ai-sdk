import { describe, expect, it, vi } from "vitest";

import {
  createCachedGenerateMiddleware,
  createInMemoryGenerateCache,
  createTextMessage,
  wrapLanguageModel
} from "../src/index.js";
import type { GenerateResult, LanguageModel } from "../src/index.js";

const capabilities: LanguageModel["capabilities"] = {
  streaming: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: false,
  parallelToolCalls: false,
  vision: false,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

const messages = [createTextMessage("user", "sensitive prompt")];

const setup = () => {
  const store = new Map<string, GenerateResult>();
  const observedKeys: string[] = [];
  let calls = 0;
  const model: LanguageModel = {
    provider: "test",
    modelId: "cache-key",
    capabilities,
    async generate() {
      calls += 1;
      return { text: `response-${calls}` };
    }
  };
  const wrapped = wrapLanguageModel(model, [
    createCachedGenerateMiddleware({
      cache: {
        get(key) {
          observedKeys.push(key);
          return store.get(key);
        },
        set(key, value) {
          store.set(key, value);
        }
      }
    })
  ]);
  return { wrapped, observedKeys, getCalls: () => calls, store };
};

describe("default generate cache keys", () => {
  it("are deterministic, bounded, and do not expose prompts", async () => {
    const { wrapped, observedKeys, getCalls } = setup();

    const first = await wrapped.generate({
      messages,
      providerOptions: { nested: { b: 2, a: 1 } }
    });
    const second = await wrapped.generate({
      messages,
      providerOptions: { nested: { a: 1, b: 2 } }
    });

    expect(first).toEqual(second);
    expect(getCalls()).toBe(1);
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toMatch(/^generate:v2:[a-f0-9]{64}$/);
    expect(observedKeys[0]).toBe(observedKeys[1]);
    expect(observedKeys[0]).not.toContain("sensitive prompt");
  });

  it("ignores abort-signal identity", async () => {
    const { wrapped, getCalls } = setup();

    await wrapped.generate({ messages, abortSignal: new AbortController().signal });
    await wrapped.generate({ messages, abortSignal: new AbortController().signal });

    expect(getCalls()).toBe(1);
  });

  it("bypasses caching when input contains secrets or unsupported cycles", async () => {
    const { wrapped, observedKeys, getCalls, store } = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await wrapped.generate({ messages, providerOptions: { authorization: "Bearer secret" } });
    await wrapped.generate({ messages, providerOptions: { authorization: "Bearer secret" } });
    await wrapped.generate({ messages, providerOptions: cyclic });

    expect(getCalls()).toBe(3);
    expect(observedKeys).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("isolates shared caches by model instance unless a stable scope is explicit", async () => {
    const store = new Map<string, GenerateResult>();
    const cache = {
      get: (key: string) => store.get(key),
      set: (key: string, value: GenerateResult) => store.set(key, value)
    };
    const createTenantModel = (tenant: string): LanguageModel => ({
      provider: "test",
      modelId: "shared-id",
      capabilities,
      async generate() {
        return { text: tenant };
      }
    });
    const tenantA = wrapLanguageModel(createTenantModel("tenant-a"), [
      createCachedGenerateMiddleware({ cache })
    ]);
    const tenantB = wrapLanguageModel(createTenantModel("tenant-b"), [
      createCachedGenerateMiddleware({ cache })
    ]);

    await expect(tenantA.generate({ messages })).resolves.toMatchObject({ text: "tenant-a" });
    await expect(tenantB.generate({ messages })).resolves.toMatchObject({ text: "tenant-b" });

    const scopedA = wrapLanguageModel(createTenantModel("scoped-a"), [
      createCachedGenerateMiddleware({ cache, scope: "auth/tenant-a" })
    ]);
    const scopedB = wrapLanguageModel(createTenantModel("scoped-b"), [
      createCachedGenerateMiddleware({ cache, scope: "auth/tenant-b" })
    ]);

    await expect(scopedA.generate({ messages })).resolves.toMatchObject({ text: "scoped-a" });
    await expect(scopedB.generate({ messages })).resolves.toMatchObject({ text: "scoped-b" });
  });

  it("allows an explicit stable scope to share persistent entries", async () => {
    const cache = createInMemoryGenerateCache();
    let calls = 0;
    const createScopedModel = (): LanguageModel => ({
      provider: "test",
      modelId: "shared-id",
      capabilities,
      async generate() {
        calls += 1;
        return { text: `response-${calls}` };
      }
    });
    const first = wrapLanguageModel(createScopedModel(), [
      createCachedGenerateMiddleware({ cache, scope: "same-auth-boundary" })
    ]);
    const second = wrapLanguageModel(createScopedModel(), [
      createCachedGenerateMiddleware({ cache, scope: "same-auth-boundary" })
    ]);

    await first.generate({ messages });
    await second.generate({ messages });

    expect(calls).toBe(1);
  });

  it("does not create orphan entries when a persistent cache has no stable scope", async () => {
    let calls = 0;
    const cache = {
      scopeRequirement: "stable" as const,
      get: vi.fn<() => GenerateResult | undefined>(),
      set: vi.fn<() => void>()
    };
    const model: LanguageModel = {
      provider: "test",
      modelId: "persistent",
      capabilities,
      async generate() {
        calls += 1;
        return { text: `response-${calls}` };
      }
    };
    const wrapped = wrapLanguageModel(model, [createCachedGenerateMiddleware({ cache })]);

    await wrapped.generate({ messages });
    await wrapped.generate({ messages });

    expect(calls).toBe(2);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("rejects empty cache scopes", () => {
    expect(() => createCachedGenerateMiddleware({
      cache: createInMemoryGenerateCache(),
      scope: "  "
    })).toThrow("scope");
  });
});
