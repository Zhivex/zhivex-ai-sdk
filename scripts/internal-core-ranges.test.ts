import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const readManifest = async (packageName: string) => JSON.parse(
  await readFile(path.join(repoRoot, "packages", packageName, "package.json"), "utf8")
) as { version: string; dependencies?: Record<string, string> };

// All providers now import the focused Core entrypoints introduced in 1.19.0.
// Older Core versions do not expose these package subpaths. Image URL adapters
// additionally require imageInputToDataUrl from 1.20.0; xAI follows OpenAI.
const reviewedProviderCoreRanges = {
  anthropic: "^1.20.0",
  "azure-openai": "^1.20.0",
  bedrock: "^1.19.0",
  deepseek: "^1.19.0",
  gemini: "^1.19.0",
  kimi: "^1.19.0",
  meta: "^1.20.0",
  ollama: "^1.19.0",
  openai: "^1.20.0",
  openrouter: "^1.20.0",
  qwen: "^1.20.0",
  vertex: "^1.19.0",
  xai: "^1.20.0",
  zai: "^1.19.0"
} as const;

describe("internal Core dependency ranges", () => {
  it("requires the reviewed Core release for each provider helper surface", async () => {
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
