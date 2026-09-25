import { describe, expect, it } from "vitest";
import { createModelCatalog, type ModelCatalogEntry } from "../src/catalog-contracts.js";
import { recommendAuxiliaryModel } from "../src/catalog-recommendation.js";

const evidence = { source: "https://provider.example/models/model", sourceType: "primary" as const, verifiedAt: "2026-09-24" };
const entry = (modelId = "model"): ModelCatalogEntry => ({
  provider: "provider", modelId, aliases: [`${modelId}-alias`], contextWindowTokens: 1000, contextWindowType: "combined",
  maxOutputTokens: 200, inputCostPer1kTokens: 1, outputCostPer1kTokens: 2,
  compaction: { status: "candidate" },
  evidence: Object.fromEntries(["contextWindowTokens", "contextWindowType", "maxOutputTokens", "inputCostPer1kTokens", "outputCostPer1kTokens"].map(field => [field, { ...evidence }]))
});
const catalog = (entries: ModelCatalogEntry[]) => createModelCatalog(entries, { pricing: { version: "test", currency: "USD", unit: "per_1k_tokens" } });
const recommend = (entries: ModelCatalogEntry[], overrides: Partial<Parameters<typeof recommendAuxiliaryModel>[0]> = {}) => recommendAuxiliaryModel({
  catalog: catalog(entries), routes: entries.map(e => ({ provider: e.provider, modelId: e.modelId, available: true, credentialsAvailable: true })),
  inputTokens: 800, outputTokens: 100, now: "2026-09-24T12:00:00Z", maxEvidenceAgeMs: 86_400_000, ...overrides
});

describe("catalog context evidence and auxiliary recommendations", () => {
  it("preserves backward compatibility and isolates nested metadata", () => {
    expect(createModelCatalog([{ provider: "old", modelId: "old" }]).list()[0]?.contextWindowTokens).toBeUndefined();
    const original = entry();
    original.evidence!.contextWindowTokens!.conditions = ["region:eu"];
    const snapshot = catalog([original]);
    original.evidence!.contextWindowTokens!.conditions.push("changed");
    const read = snapshot.find("provider", "model")!;
    read.evidence!.contextWindowTokens!.conditions!.push("also-changed");
    expect(snapshot.find("provider", "model-alias")?.evidence?.contextWindowTokens?.conditions).toEqual(["region:eu"]);
  });
  it("requires valid per-datum evidence and evaluation artifacts", () => {
    expect(() => catalog([{ ...entry(), evidence: {} }])).toThrow("per-datum evidence");
    expect(() => catalog([{ ...entry(), contextWindowTokens: 0 }])).toThrow("positive safe integer");
    expect(() => catalog([{ ...entry(), compaction: { status: "evaluated" } }])).toThrow("evaluation evidence");
    const invalid = entry(); invalid.evidence!.maxOutputTokens!.verifiedAt = "2026-02-30";
    expect(() => catalog([invalid])).toThrow("ISO 8601");
  });
  it("counts output against combined windows and reports exclusion", () => {
    expect(recommend([entry()]).selected?.estimatedCost).toBe(1);
    expect(recommend([entry()], { inputTokens: 950 }).candidates[0]?.exclusions).toContain("context_window_exceeded");
    expect(recommend([entry()], { outputTokens: 201 }).selected).toBeUndefined();
  });
  it("keeps conditional limits unavailable until route conditions match", () => {
    const model = entry(); model.evidence!.contextWindowTokens!.conditions = ["region:eu", "tier:paid"];
    expect(recommend([model]).selected).toBeUndefined();
    expect(recommend([model], { routes: [{ provider: "provider", modelId: "model", available: true, credentialsAvailable: true, conditions: ["region:eu", "tier:paid"] }] }).selected).toBeDefined();
  });
  it("rejects stale and future evidence", () => {
    expect(recommend([entry()], { now: "2026-09-26" }).selected).toBeUndefined();
    expect(recommend([entry()], { now: "2026-09-23" }).selected).toBeUndefined();
  });
  it("does not bypass a stale combined window using a fresh input limit", () => {
    const model = entry();
    model.maxInputTokens = 900;
    model.evidence!.maxInputTokens = { ...evidence };
    model.evidence!.contextWindowTokens!.verifiedAt = "2026-09-20";
    expect(recommend([model]).candidates[0]?.exclusions).toContain("context_window_unknown_stale_or_conditional");
    expect(recommend([model]).selected).toBeUndefined();
  });
  it("keeps conditional regional input prices unknown outside their region", () => {
    const model = entry();
    model.evidence!.inputCostPer1kTokens!.conditions = ["region:eu", "tier:paid"];
    expect(recommend([model]).selected?.estimatedCost).toBeUndefined();
    expect(recommend([model], { maxCost: 10 }).selected).toBeUndefined();
    expect(recommend([model], { routes: [{ provider: "provider", modelId: "model", available: true, credentialsAvailable: true, conditions: ["region:eu", "tier:paid"] }] }).selected?.estimatedCost).toBe(1);
  });
  it("distinguishes curated candidates from evaluated compaction", () => {
    expect(recommend([entry()], { requireEvaluated: true }).selected).toBeUndefined();
    const model = entry(); model.compaction = { status: "evaluated", evaluation: { source: "https://app.example/eval", fixture: "compaction-v1", version: "model-snapshot-1", evaluatedAt: "2026-09-24", passed: true } };
    expect(recommend([model], { requireEvaluated: true }).selected?.reasons).toContain("compaction_evaluated");
    model.compaction.evaluation!.passed = false;
    expect(recommend([model]).selected).toBeUndefined();
  });
  it("never treats unknown price as free or estimates without pricing evidence", () => {
    const unknown = entry("unknown"); delete unknown.outputCostPer1kTokens; delete unknown.evidence!.outputCostPer1kTokens;
    expect(recommend([unknown, entry("known")]).selected?.modelId).toBe("known");
    expect(recommend([unknown]).selected?.estimatedCost).toBeUndefined();
    expect(recommend([unknown], { maxCost: 5 }).selected).toBeUndefined();
  });
  it("applies long-context tiers with region and tier evidence", () => {
    const model = entry(); model.longContextPricing = { inputTokenThreshold: 799, inputMultiplier: 2, outputMultiplier: 1.5 };
    model.evidence!.longContextPricing = { ...evidence, conditions: ["region:eu"] };
    expect(recommend([model]).selected?.estimatedCost).toBeUndefined();
    const routes = [{ provider: "provider", modelId: "model", available: true, credentialsAvailable: true, conditions: ["region:eu"] }];
    expect(recommend([model], { routes }).selected?.estimatedCost).toBe(1.9);
    expect(recommend([model], { routes, inputTokens: 799 }).selected?.estimatedCost).toBe(.999);
  });
  it("respects explicit aliases, availability, credentials and absent routes", () => {
    const explicitRoute = { provider: "provider", modelId: "b-alias" };
    expect(recommend([entry("a"), entry("b")], { explicitRoute }).selected?.modelId).toBe("b");
    expect(recommend([entry("a")], { explicitRoute }).selected).toBeUndefined();
    const routes = [{ provider: "provider", modelId: "a", available: false, credentialsAvailable: false }];
    expect(recommend([entry("a")], { routes }).candidates[0]?.exclusions).toEqual(["route_unavailable", "credentials_unavailable"]);
  });
  it("selects deterministic ties and excludes retired models", () => {
    expect(recommend([entry("b"), entry("a")]).selected?.modelId).toBe("a");
    const a = entry("a"); a.lifecycle = { retiredAt: "2026-09-23", source: "https://provider.example/deprecations" };
    expect(recommend([a, entry("b")]).selected?.modelId).toBe("b");
  });
});
