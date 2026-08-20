import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFileGenerateCache } from "../src/index.js";
import type { GenerateResult } from "../src/index.js";

const createCacheDirectory = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhivex-file-generate-cache-"));
  return { root, dir: path.join(root, "cache") };
};

describe("file generate cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("roundtrips generate results", async () => {
    const { dir } = await createCacheDirectory();
    const cache = createFileGenerateCache({ dir });
    const result: GenerateResult = {
      text: "cached response",
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    };

    await cache.set("provider/model/request", result);

    await expect(cache.get("provider/model/request")).resolves.toEqual(result);
    await expect(cache.get("provider/model/other-request")).resolves.toBeUndefined();
  });

  it("hashes long keys into bounded, non-reversible filenames", async () => {
    const { dir } = await createCacheDirectory();
    const cache = createFileGenerateCache({ dir });
    const key = `secret-prompt-${"x".repeat(100_000)}`;

    await cache.set(key, { text: "cached" });

    const entries = await fs.readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^generate-cache_v2_[a-f0-9]{64}\.json$/);
    expect(entries[0]?.length).toBeLessThan(128);
    expect(entries[0]).not.toContain("secret-prompt");
    await expect(cache.get(key)).resolves.toEqual({ text: "cached" });
  });

  const itOnPosix = process.platform === "win32" ? it.skip : it;
  itOnPosix("enforces private directory and file permissions", async () => {
    const { dir } = await createCacheDirectory();
    await fs.mkdir(dir, { mode: 0o755 });
    await fs.chmod(dir, 0o755);
    const cache = createFileGenerateCache({ dir });

    await cache.set("sensitive", { text: "private" });

    const [entry] = await fs.readdir(dir);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(dir, entry!))).mode & 0o777).toBe(0o600);
  });

  it("treats corrupt JSON as a cache miss", async () => {
    const { dir } = await createCacheDirectory();
    const cache = createFileGenerateCache({ dir });
    await cache.set("corrupt", { text: "valid before corruption" });
    const [entry] = await fs.readdir(dir);
    await fs.writeFile(path.join(dir, entry!), "{not-json", "utf8");

    await expect(cache.get("corrupt")).resolves.toBeUndefined();
  });

  it("expires and removes entries when a TTL is configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const { dir } = await createCacheDirectory();
    const cache = createFileGenerateCache({ dir, ttlMs: 1_000 });
    await cache.set("expiring", { text: "short lived" });

    vi.advanceTimersByTime(1_000);

    await expect(cache.get("expiring")).resolves.toBeUndefined();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("allows callers to bound keys and entries without failing generation", async () => {
    const { dir } = await createCacheDirectory();
    const cache = createFileGenerateCache({ dir, maxKeyBytes: 8, maxEntryBytes: 32 });

    await expect(cache.set("key-too-long", { text: "ignored" })).resolves.toBeUndefined();
    await expect(cache.set("key", { text: "x".repeat(64) })).resolves.toBeUndefined();
    await expect(cache.get("key-too-long")).resolves.toBeUndefined();
    await expect(fs.readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => createFileGenerateCache({ dir, ttlMs: 0 })).toThrow("ttlMs");
  });

  it("treats non-serializable results as non-cacheable", async () => {
    const { dir } = await createCacheDirectory();
    const cache = createFileGenerateCache({ dir });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(cache.set("cyclic", { rawResponse: cyclic })).resolves.toBeUndefined();
    await expect(fs.readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
