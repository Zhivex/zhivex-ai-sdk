import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const readManifest = async (packageName: string) => JSON.parse(
  await readFile(path.join(repoRoot, "packages", packageName, "package.json"), "utf8")
) as { version: string; dependencies?: Record<string, string> };

// Changesets 3 advanced the dependency-update cohort to Core 1.16.1.
// xAI was not part of that release and retains its reviewed Live minimum.
const reviewedProviderCoreRanges = {
  anthropic: "^1.16.1",
  "azure-openai": "^1.16.1",
  bedrock: "^1.16.1",
  deepseek: "^1.16.1",
  gemini: "^1.16.1",
  kimi: "^1.16.1",
  meta: "^1.16.1",
  ollama: "^1.16.1",
  openai: "^1.16.1",
  openrouter: "^1.16.1",
  qwen: "^1.16.1",
  vertex: "^1.16.1",
  xai: "^1.16.0",
  zai: "^1.16.1"
} as const;

describe("internal Core dependency ranges", () => {
  it("preserves the reviewed Core minimum for updated and unchanged providers", async () => {
    for (const [packageName, expectedRange] of Object.entries(reviewedProviderCoreRanges)) {
      const manifest = await readManifest(packageName);
      expect(manifest.dependencies?.["@zhivex-ai/core"], packageName).toBe(expectedRange);
    }
  });

  it("pins SDK to the same Core minor because its opt-in subpaths re-export that release's APIs", async () => {
    const core = await readManifest("core");
    const sdk = await readManifest("sdk");
    const [major, minor, patch] = core.version.split(".");
    const range = sdk.dependencies?.["@zhivex-ai/core"] ?? "";
    const minimum = range.match(/^~(\d+)\.(\d+)\.(\d+)$/);
    expect(minimum, "SDK must pin Core to a minor with a tilde range").not.toBeNull();
    expect(minimum?.[1]).toBe(major);
    expect(minimum?.[2]).toBe(minor);
    expect(Number(minimum?.[3])).toBeLessThanOrEqual(Number(patch));
  });
});
