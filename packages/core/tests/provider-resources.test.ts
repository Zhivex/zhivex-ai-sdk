import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ContextCacheUpdateInput, ContextCachesClient, CachedContent } from "../src/types.js";

import * as googleTools from "../src/google.js";
import * as core from "../src/index.js";
import * as providerResources from "../src/provider-resources.js";

const resourceExports = [
  "cancelBatch",
  "cancelInteraction",
  "createBatch",
  "createContextCache",
  "createFileSearchStore",
  "createInteraction",
  "deleteBatch",
  "deleteContextCache",
  "deleteFile",
  "deleteFileSearchStore",
  "deleteInteraction",
  "fetchPredictionOperation",
  "getBatch",
  "getContextCache",
  "updateContextCache",
  "getFile",
  "getFileSearchStore",
  "getInteraction",
  "importFileToFileSearchStore",
  "listBatches",
  "listContextCaches",
  "listFileSearchStores",
  "listFiles",
  "predictLongRunning",
  "predictRaw",
  "resumeInteraction",
  "streamInteraction",
  "uploadFile",
  "uploadToFileSearchStore"
] as const;

const googleToolExports = [
  "googleCodeExecutionTool",
  "googleComputerUseTool",
  "googleFileSearchTool",
  "googleMapsTool",
  "googleSearchTool",
  "googleUrlContextTool"
] as const;

describe("provider resource module boundary", () => {
  it("forwards cache expiration options and preserves the client receiver", async () => {
    const abortSignal = new AbortController().signal;
    const caches = {
      async update(input: ContextCacheUpdateInput) {
        expect(this).toBe(caches);
        expect(input).toEqual({ name: "cache", ttl: "60s", timeoutMs: 100, maxRetries: 0, abortSignal });
        return { name: "cache", expireTime: "2026-09-20T00:00:00Z" };
      }
    };
    const provider = { name: "test", caches } as unknown as core.ProviderAdapter;
    await expect(core.updateContextCache({ provider, name: "cache", ttl: "60s", timeoutMs: 100, maxRetries: 0, abortSignal })).resolves.toMatchObject({ name: "cache" });
  });

  it("rejects expiration updates for providers without an update operation", async () => {
    for (const caches of [undefined, {}]) {
      const provider = { name: "test", caches } as unknown as core.ProviderAdapter;
      await expect(core.updateContextCache({ provider, name: "cache", ttl: "60s" })).rejects.toBeInstanceOf(core.UnsupportedFeatureError);
    }
  });
  it("exposes optional expiration updates without requiring existing cache adapters to implement them", () => {
    expectTypeOf<ContextCachesClient["update"]>().toEqualTypeOf<((input: ContextCacheUpdateInput) => Promise<CachedContent>) | undefined>();
    expectTypeOf<{ name: string; ttl: string }>().toExtend<ContextCacheUpdateInput>();
    expectTypeOf<{ name: string; expireTime: string }>().toExtend<ContextCacheUpdateInput>();
    expectTypeOf<{ name: string; ttl: string; expireTime: string }>().not.toExtend<ContextCacheUpdateInput>();
    expectTypeOf<{ name: string }>().not.toExtend<ContextCacheUpdateInput>();
  });
  it("keeps the root exports compatible while assigning each symbol to its focused module", () => {
    expect(Object.keys(providerResources).sort()).toEqual([...resourceExports].sort());
    expect(Object.keys(googleTools).sort()).toEqual([...googleToolExports].sort());

    const rootExports = core as Record<string, unknown>;
    const resourceModule = providerResources as Record<string, unknown>;
    const googleModule = googleTools as Record<string, unknown>;

    for (const name of resourceExports) {
      expect(rootExports[name], name).toBe(resourceModule[name]);
    }
    for (const name of googleToolExports) {
      expect(rootExports[name], name).toBe(googleModule[name]);
    }
  });

  it("keeps provider-resources free of provider-specific module dependencies", async () => {
    const filePath = path.resolve(import.meta.dirname, "../src/provider-resources.ts");
    const source = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const dependencies = sourceFile.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        return [];
      }
      return [statement.moduleSpecifier.text];
    });

    expect(dependencies.sort()).toEqual(["./errors.js", "./types.js"]);
    expect(dependencies).not.toContain("./google.js");
  });
});
