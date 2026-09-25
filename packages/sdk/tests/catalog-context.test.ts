import { describe, expect, it } from "vitest";
import { defaultModelCatalog, recommendAuxiliaryModel } from "../src/catalog.js";
import { defineModelCatalogFragment } from "../src/catalog/fragment.js";

describe("SDK managed context metadata", () => {
  it("offers primary-sourced limits without claiming evaluated compaction", () => {
    const entry = defaultModelCatalog.find("openai", "gpt-4o-mini")!;
    expect(entry.contextWindowTokens).toBe(128000);
    expect(entry.maxOutputTokens).toBe(16384);
    expect(entry.compaction).toEqual({ status: "candidate" });
    expect(entry.evidence?.contextWindowType?.source).toContain("conversation-state");
    const result = recommendAuxiliaryModel({ catalog: defaultModelCatalog, routes: [{ provider: "openai", modelId: "gpt-4o-mini", available: true, credentialsAvailable: true }], inputTokens: 1000, outputTokens: 100, now: "2026-09-24T12:00:00Z", maxEvidenceAgeMs: 86400000 });
    expect(result.selected?.estimatedCost).toBeCloseTo(.00021);
    entry.evidence!.contextWindowTokens!.source = "https://mutated.example";
    expect(defaultModelCatalog.find("openai", "gpt-4o-mini")?.evidence?.contextWindowTokens?.source).not.toContain("mutated");
  });
  it("isolates and freezes nested fragment evidence, curation and lifecycle", () => {
    const entry = defaultModelCatalog.find("openai", "gpt-4o-mini")!;
    entry.evidence!.contextWindowTokens!.conditions = ["region:us"];
    entry.compaction = { status: "evaluated", evaluation: { source: "https://example.com/eval", fixture: "dataset-v1", version: "snapshot-1", evaluatedAt: "2026-09-24", passed: true } };
    entry.lifecycle = { source: "https://example.com/lifecycle" };
    const fragment = defineModelCatalogFragment({ provider: "openai", revision: "test", verifiedAt: "2026-09-24", sources: ["https://example.com"], entries: [entry] });
    entry.evidence!.contextWindowTokens!.conditions.push("later");
    entry.compaction.evaluation!.passed = false;
    expect(fragment.entries[0]?.evidence?.contextWindowTokens?.conditions).toEqual(["region:us"]);
    expect(fragment.entries[0]?.compaction?.evaluation?.passed).toBe(true);
    expect(Object.isFrozen(fragment.entries[0]?.evidence?.contextWindowTokens?.conditions)).toBe(true);
    expect(Object.isFrozen(fragment.entries[0]?.lifecycle)).toBe(true);
    expect(Object.isFrozen(fragment.entries[0]?.compaction?.evaluation)).toBe(true);
  });
});
