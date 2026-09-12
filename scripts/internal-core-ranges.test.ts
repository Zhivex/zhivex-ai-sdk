import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const readManifest = async (packageName: string) => JSON.parse(
  await readFile(path.join(repoRoot, "packages", packageName, "package.json"), "utf8")
) as { version: string; dependencies?: Record<string, string> };

// Reviewed minimum Core versions for this release. The updated provider cohort
// uses withResponseRetry from Core 1.13; the tool-history cohort needs 1.12.
// OpenAI needs the Live contract in Core 1.16; xAI follows its OpenAI dependency.
// Older
// adapters retain their existing minimum instead of tracking Core automatically.
const reviewedProviderCoreRanges = {
  anthropic: "^1.13.0",
  "azure-openai": "^1.4.0",
  bedrock: "^1.0.2",
  deepseek: "^1.12.0",
  gemini: "^1.13.0",
  kimi: "^1.1.2",
  meta: "^1.3.0",
  ollama: "^1.3.0",
  openai: "^1.16.0",
  openrouter: "^1.0.2",
  qwen: "^1.13.0",
  vertex: "^1.12.0",
  xai: "^1.16.0",
  zai: "^1.3.0"
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
    expect(sdk.dependencies?.["@zhivex-ai/core"]).toBe(`~${core.version}`);
  });
});
