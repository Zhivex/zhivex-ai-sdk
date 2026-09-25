import type { ModelCatalog, ModelCatalogEntry, ModelCatalogEvidenceField } from "./catalog-contracts.js";

export interface AuxiliaryModelRoute {
  provider: string;
  modelId: string;
  available: boolean;
  credentialsAvailable: boolean;
  conditions?: string[];
}
export interface RecommendAuxiliaryModelOptions {
  catalog: ModelCatalog;
  routes: readonly AuxiliaryModelRoute[];
  inputTokens: number;
  outputTokens: number;
  /** Explicit time and freshness policy keep decisions deterministic and replayable. */
  now: string;
  maxEvidenceAgeMs: number;
  explicitRoute?: { provider: string; modelId: string };
  requireEvaluated?: boolean;
  maxCost?: number;
}
export interface AuxiliaryModelRecommendationCandidate {
  provider: string;
  modelId: string;
  eligible: boolean;
  reasons: string[];
  exclusions: string[];
  estimatedCost?: number;
  currency?: string;
}
export interface AuxiliaryModelRecommendationResult {
  selected?: AuxiliaryModelRecommendationCandidate;
  candidates: AuxiliaryModelRecommendationCandidate[];
}

/** Pure, opt-in selection; never resolves credentials, performs I/O, or overrides an explicit route. */
export function recommendAuxiliaryModel(options: RecommendAuxiliaryModelOptions): AuxiliaryModelRecommendationResult {
  for (const field of ["inputTokens", "outputTokens"] as const) {
    if (!Number.isSafeInteger(options[field]) || options[field] < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  const now = Date.parse(options.now);
  if (!Number.isFinite(now)) throw new TypeError("now must be an ISO timestamp");
  if (!Number.isFinite(options.maxEvidenceAgeMs) || options.maxEvidenceAgeMs < 0) throw new TypeError("maxEvidenceAgeMs must be finite and non-negative");
  if (options.maxCost !== undefined && (!Number.isFinite(options.maxCost) || options.maxCost < 0)) throw new TypeError("maxCost must be finite and non-negative");
  const seen = new Set<string>();
  const candidates = options.routes.map((route): AuxiliaryModelRecommendationCandidate => {
    const entry = options.catalog.find(route.provider, route.modelId);
    const modelId = entry?.modelId ?? route.modelId;
    const key = JSON.stringify([route.provider, modelId]);
    if (seen.has(key)) throw new TypeError("routes must not contain duplicate provider/model identities (including aliases)");
    seen.add(key);
    const reasons: string[] = [];
    const exclusions: string[] = [];
    const result: AuxiliaryModelRecommendationCandidate = { provider: route.provider, modelId, eligible: false, reasons, exclusions };
    if (!route.available) exclusions.push("route_unavailable");
    if (!route.credentialsAvailable) exclusions.push("credentials_unavailable");
    if (options.explicitRoute) {
      const explicit = options.catalog.find(options.explicitRoute.provider, options.explicitRoute.modelId);
      if (route.provider !== options.explicitRoute.provider || modelId !== (explicit?.modelId ?? options.explicitRoute.modelId)) exclusions.push("explicit_route_mismatch");
      else reasons.push("explicit_route");
    }
    if (!entry) { exclusions.push("model_unknown"); return result; }
    if (entry.lifecycle?.retiredAt && Date.parse(entry.lifecycle.retiredAt) <= now) exclusions.push("model_retired");
    if (entry.lifecycle?.deprecatedAt && Date.parse(entry.lifecycle.deprecatedAt) <= now) reasons.push("model_deprecated");
    if (!entry.compaction && !entry.recommendedFor?.includes("compaction")) exclusions.push("compaction_not_curated");
    if (entry.compaction?.status === "evaluated") {
      const evaluation = entry.compaction.evaluation;
      if (!evaluation?.passed) exclusions.push("compaction_evaluation_failed");
      else if (!fresh(evaluation.evaluatedAt)) exclusions.push("compaction_evaluation_stale");
      else reasons.push("compaction_evaluated");
    } else if (options.requireEvaluated) exclusions.push("compaction_not_evaluated");
    else reasons.push("compaction_candidate_only");
    function fresh(date: string): boolean {
      const age = now - Date.parse(date);
      return age >= 0 && age <= options.maxEvidenceAgeMs;
    }
    function usable(field: ModelCatalogEvidenceField): boolean {
      const evidence = entry!.evidence?.[field];
      if (!evidence || !fresh(evidence.verifiedAt)) return false;
      return (evidence.conditions ?? []).every(condition => route.conditions?.includes(condition));
    }
    const inputKnown = entry.maxInputTokens !== undefined && usable("maxInputTokens");
    const windowKnown = entry.contextWindowTokens !== undefined && usable("contextWindowTokens") && usable("contextWindowType");
    if (!inputKnown && !windowKnown) exclusions.push("input_limit_unknown_stale_or_conditional");
    if (entry.contextWindowTokens !== undefined && !windowKnown) exclusions.push("context_window_unknown_stale_or_conditional");
    if (entry.maxInputTokens !== undefined && !inputKnown) exclusions.push("max_input_unknown_stale_or_conditional");
    if (inputKnown && options.inputTokens > entry.maxInputTokens!) exclusions.push("input_limit_exceeded");
    if (windowKnown && options.inputTokens + (entry.contextWindowType === "combined" ? options.outputTokens : 0) > entry.contextWindowTokens!) exclusions.push("context_window_exceeded");
    if (entry.maxOutputTokens === undefined || !usable("maxOutputTokens")) exclusions.push("output_limit_unknown_stale_or_conditional");
    else if (options.outputTokens > entry.maxOutputTokens) exclusions.push("output_limit_exceeded");
    const cost = estimate(entry, usable, options.inputTokens, options.outputTokens);
    const currency = options.catalog.metadata.pricing?.currency;
    if (cost === undefined || currency === undefined) {
      reasons.push("cost_unknown");
      if (options.maxCost !== undefined) exclusions.push("budget_requires_known_cost");
    } else {
      result.estimatedCost = cost;
      result.currency = currency;
      reasons.push("cost_estimated");
      if (options.maxCost !== undefined && cost > options.maxCost) exclusions.push("budget_exceeded");
    }
    result.eligible = exclusions.length === 0;
    if (result.eligible) reasons.push("limits_fit");
    return result;
  });
  if (options.explicitRoute && !candidates.some(candidate => candidate.reasons.includes("explicit_route"))) {
    candidates.push({ ...options.explicitRoute, eligible: false, reasons: ["explicit_route"], exclusions: ["explicit_route_unavailable"] });
  }
  const compare = (a: AuxiliaryModelRecommendationCandidate, b: AuxiliaryModelRecommendationCandidate): number => {
    const cost = (a.estimatedCost ?? Infinity) - (b.estimatedCost ?? Infinity);
    if (Number.isFinite(cost) && cost !== 0) return cost;
    if (a.estimatedCost !== undefined && b.estimatedCost === undefined) return -1;
    if (a.estimatedCost === undefined && b.estimatedCost !== undefined) return 1;
    const left = JSON.stringify([a.provider, a.modelId]);
    const right = JSON.stringify([b.provider, b.modelId]);
    return left < right ? -1 : left > right ? 1 : 0;
  };
  candidates.sort(compare);
  const selected = candidates.find(candidate => candidate.eligible);
  return { ...(selected ? { selected } : {}), candidates };
}

function estimate(entry: ModelCatalogEntry, usable: (field: ModelCatalogEvidenceField) => boolean, input: number, output: number): number | undefined {
  if (entry.inputCostPer1kTokens === undefined || entry.outputCostPer1kTokens === undefined || !usable("inputCostPer1kTokens") || !usable("outputCostPer1kTokens")) return undefined;
  const tier = entry.longContextPricing;
  if (tier && !usable("longContextPricing")) return undefined;
  const elevated = tier !== undefined && input > tier.inputTokenThreshold;
  const value = (input * entry.inputCostPer1kTokens * (elevated ? tier.inputMultiplier : 1) + output * entry.outputCostPer1kTokens * (elevated ? tier.outputMultiplier : 1)) / 1000;
  return Number.isFinite(value) ? value : undefined;
}
