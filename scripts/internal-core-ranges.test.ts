import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { compareVersions } from "./check-release-readiness";

const repoRoot = path.resolve(import.meta.dirname, "..");
const readManifest = async (packageName: string) => JSON.parse(
  await readFile(path.join(repoRoot, "packages", packageName, "package.json"), "utf8")
) as { version: string; dependencies?: Record<string, string> };

// All providers now import the focused Core entrypoints introduced in 1.19.0.
// Older Core versions do not expose these package subpaths. Image URL adapters
// additionally require imageInputToDataUrl from 1.20.0; xAI follows OpenAI.
// Anthropic browser toolsets and Vertex/Qwen's shared realtime transport
// require the contracts and provider helpers introduced in 1.21.0.
// OpenAI and Qwen rejected-tool accounting requires ProviderToolCallError.usage in 1.22.0.
const reviewedProviderCoreRanges = {
  anthropic: "^1.21.0",
  "azure-openai": "^1.20.0",
  bedrock: "^1.19.0",
  deepseek: "^1.19.0",
  gemini: "^1.19.0",
  kimi: "^1.19.0",
  meta: "^1.20.0",
  ollama: "^1.19.0",
  openai: "^1.22.0",
  openrouter: "^1.20.0",
  qwen: "^1.22.0",
  vertex: "^1.21.0",
  xai: "^1.20.0",
  zai: "^1.19.0"
} as const;

// Changesets can raise a provider's minimum when graduating a prerelease.
// Keep explicit stable caret ranges within the reviewed major, at or above
// the helper floor, and no newer than the Core version in this checkout.
const acceptsCoreStable = (version: string, range: string | undefined, reviewedRange: string): boolean => {
  const stableVersion = /^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const minimum = range?.startsWith("^") ? range.slice(1) : "";
  const reviewedMinimum = reviewedRange.slice(1);
  if (![version, minimum, reviewedMinimum].every(value => stableVersion.test(value))) return false;
  const major = version.split(".")[0];
  return minimum.split(".")[0] === major && reviewedMinimum.split(".")[0] === major &&
    compareVersions(minimum, reviewedMinimum) >= 0 && compareVersions(version, minimum) >= 0;
};

// A provider can retain an earlier next revision when Changesets only bumps
// Core: ^1.23.0-next.0 accepts 1.23.0-next.1. Keep the same release tuple
// and channel so this does not admit unrelated or future prerelease floors.
const acceptsCorePrerelease = (version: string, range: string | undefined): boolean => {
  const current = /^(\d+\.\d+\.\d+)-next\.(0|[1-9]\d*)$/.exec(version);
  const minimum = /^\^(\d+\.\d+\.\d+)-next\.(0|[1-9]\d*)$/.exec(range ?? "");
  return Boolean(current && minimum && current[1] === minimum[1] &&
    BigInt(minimum[2]!) <= BigInt(current[2]!));
};

describe("internal Core dependency ranges", () => {
  it.each([
    ["1.23.0", "^1.21.0", "^1.21.0", true],
    ["1.23.0", "^1.23.0", "^1.21.0", true],
    ["1.23.2", "^1.23.1", "^1.21.0", true],
    ["1.23.0", "^1.20.0", "^1.21.0", false],
    ["1.23.2", "^1.23.0", "^1.23.1", false],
    ["1.23.0", "^1.9.0", "^1.21.0", false],
    ["1.23.0", "^1.24.0", "^1.21.0", false],
    ["1.23.0", "^1.23.1", "^1.21.0", false],
    ["2.0.0", "^1.23.0", "^1.21.0", false],
    ["2.0.0", "^2.0.0", "^1.21.0", false],
    ["1.23.0", "^1.23.0-next.0", "^1.21.0", false],
    ["1.23.0-next.1", "^1.23.0", "^1.21.0", false],
    ["1.23.0", "~1.23.0", "^1.21.0", false],
    ["1.23.0", "1.23.0", "^1.21.0", false],
    ["1.23.0", ">=1.21.0", "^1.21.0", false],
    ["1.23.0", "^1.21.0 || ^2.0.0", "^1.21.0", false],
    ["1.23.0", "*", "^1.21.0", false],
    ["1.23.0", undefined, "^1.21.0", false]
  ])("checks stable compatibility for %s against %s with floor %s", (version, range, reviewedRange, expected) => {
    expect(acceptsCoreStable(version!, range, reviewedRange!)).toBe(expected);
  });

  it.each([
    ["1.23.0-next.1", "^1.23.0-next.0", true],
    ["1.23.0-next.1", "^1.23.0-next.1", true],
    ["1.23.0-next.10", "^1.23.0-next.2", true],
    ["1.23.0-next.1", "^1.23.0-next.2", false],
    ["1.23.0-next.1", "^1.22.0-next.0", false],
    ["1.23.0-next.1", "^1.23.1-next.0", false],
    ["1.23.0-next.1", "^1.23.0-rc.0", false],
    ["1.23.0-next.1", "^1.23.0", false],
    ["1.23.0-next.1", "*", false],
    ["1.23.0-next.1", undefined, false]
  ])("checks prerelease compatibility for %s against %s", (version, range, expected) => {
    expect(acceptsCorePrerelease(version!, range)).toBe(expected);
  });

  it("requires the reviewed Core release for each provider helper surface", async () => {
    const core = await readManifest("core");
    for (const [packageName, expectedRange] of Object.entries(reviewedProviderCoreRanges)) {
      const manifest = await readManifest(packageName);
      const range = manifest.dependencies?.["@zhivex-ai/core"];
      if (core.version.includes("-")) {
        expect(acceptsCorePrerelease(core.version, range), `${packageName}: ${range} must accept ${core.version}`).toBe(true);
      } else {
        expect(acceptsCoreStable(core.version, range, expectedRange),
          `${packageName}: ${range} must accept ${core.version} without admitting Core below ${expectedRange}`
        ).toBe(true);
      }
    }
  });

  it("pins SDK to the same Core minor because its opt-in subpaths re-export that release's APIs", async () => {
    const core = await readManifest("core");
    const sdk = await readManifest("sdk");
    const [major, minor, patch] = core.version.split(".");
    const range = sdk.dependencies?.["@zhivex-ai/core"] ?? "";
    if (core.version.includes("-")) {
      expect(range, "SDK must pin the exact Core prerelease batch").toBe(`~${core.version}`);
      return;
    }
    const minimum = range.match(/^~(\d+)\.(\d+)\.(\d+)$/);
    expect(minimum, "SDK must pin Core to a minor with a tilde range").not.toBeNull();
    expect(minimum?.[1]).toBe(major);
    expect(minimum?.[2]).toBe(minor);
    expect(Number(minimum?.[3])).toBeLessThanOrEqual(Number(patch));
  });
});
