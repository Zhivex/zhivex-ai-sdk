import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { integrationProviderStatuses } from "../packages/core/tests/integration-registry.js";
import {
  createProviderConformanceReport,
  parseProviderConformanceCliOptions,
  runProviderConformanceCli
} from "./provider-smoke-report.js";

describe("provider smoke registry", () => {
  it("accounts for every live provider route, including Meta and opt-in Ollama", () => {
    const providerNames = integrationProviderStatuses.map((provider) => provider.name);
    expect(providerNames).toEqual([
      "openai",
      "xai",
      "meta",
      "azure-openai",
      "anthropic",
      "gemini",
      "openrouter",
      "deepseek",
      "zai",
      "qwen",
      "kimi",
      "bedrock-converse",
      "bedrock-openai",
      "ollama",
      "vertex"
    ]);
    expect(new Set(providerNames).size).toBe(providerNames.length);
  });

  it("describes Meta credentials and Ollama opt-in requirements", () => {
    expect(integrationProviderStatuses.find((provider) => provider.name === "meta"))
      .toMatchObject({ credentialRequirements: ["MODEL_API_KEY"] });
    expect(integrationProviderStatuses.find((provider) => provider.name === "ollama"))
      .toMatchObject({
        credentialRequirements: ["OLLAMA_INTEGRATION=1 (a reachable Ollama service is also required)"],
        embeddingModelId: "embeddinggemma"
      });
  });

  it("creates versioned declared and offline evidence without confusing skips with passes", () => {
    const report = createProviderConformanceReport({
      now: new Date("2026-08-27T12:00:00.000Z"),
      offlinePassed: true
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.source.gitSha).toMatch(/^(?:[a-f0-9]{40}|unknown)$/);
    expect(report.providers).toHaveLength(integrationProviderStatuses.length);
    expect(report.providers[0]!.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence: "declared", status: "implemented" }),
      expect.objectContaining({ evidence: "offline", status: "offline_passed" })
    ]));
    expect(report.providers.flatMap((provider) => provider.results)
      .some((result) => result.status === "live_passed")).toBe(false);
  });

  it("parses explicit requirements and fails closed when required evidence is absent", () => {
    expect(parseProviderConformanceCliOptions([
      "--required=openai:generateText:live:checkout",
      "--gate=required"
    ])).toMatchObject({
      gate: "required",
      requirements: [{
        provider: "openai",
        capability: "generateText",
        evidence: "live",
        artifactKind: "checkout"
      }]
    });

    const directory = mkdtempSync(join(tmpdir(), "zhivex-provider-report-test-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(runProviderConformanceCli([
        "--required=openai:generateText:live:checkout",
        "--gate=required",
        `--markdown=${join(directory, "report.md")}`
      ])).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Missing required live evidence"));
    } finally {
      log.mockRestore();
      error.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
