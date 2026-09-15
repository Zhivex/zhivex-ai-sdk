import { GatewayError, type GatewayModelTarget, type GatewayTaskIntent } from "./types.js";
import type { GatewayMetricsSnapshot } from "./metrics.js";
import type { ModelCostValuation } from "@zhivex-ai/core";
export interface GatewayQualityProfile { target: GatewayModelTarget; intent: GatewayTaskIntent; score: number; version: string; }
export interface GatewayAdaptiveRoutingPolicy {
  version: string;
  weights: { latency: number; cost: number; quality: number; load: number; errorRate: number };
  latencyScaleMs: number;
  costScale: number;
  coldStart: "allow" | "reject";
  unknownCost: "allow" | "reject";
  missingQuality: "allow" | "reject";
  qualityProfiles?: GatewayQualityProfile[];
}
export interface GatewayAdaptiveCandidate {
  target: GatewayModelTarget;
  score?: number;
  exclusions: string[];
  missingSignals: string[];
  metrics?: GatewayMetricsSnapshot;
  cost?: ModelCostValuation;
  quality?: { score: number; version: string };
}
export const validateAdaptivePolicy = (policy: GatewayAdaptiveRoutingPolicy) => {
  if (!policy.version?.trim()) throw new GatewayError("Adaptive policy requires a version.", false);
  if (![policy.latencyScaleMs, policy.costScale].every(x => Number.isFinite(x) && x > 0)) throw new GatewayError("Adaptive scales must be positive.", false);
  const values = [policy.weights?.latency, policy.weights?.cost, policy.weights?.quality, policy.weights?.load, policy.weights?.errorRate];
  if (!values.every(x => Number.isFinite(x) && x >= 0) || values.every(x => x === 0)) throw new GatewayError("Adaptive weights must be nonnegative with at least one positive weight.", false);
  if (![policy.coldStart, policy.unknownCost, policy.missingQuality].every(x => x === "allow" || x === "reject")) throw new GatewayError("Adaptive missing-data policies must be explicit.", false);
  const keys = new Set<string>();
  for (const profile of policy.qualityProfiles ?? []) {
    const key = JSON.stringify([profile.target.provider, profile.target.modelId, profile.intent]);
    if (keys.has(key) || !profile.version?.trim() || !Number.isFinite(profile.score) || profile.score < 0 || profile.score > 1) throw new GatewayError("Invalid or ambiguous quality profile.", false);
    keys.add(key);
  }
};
export const scoreAdaptiveTarget = (policy: GatewayAdaptiveRoutingPolicy, target: GatewayModelTarget, intent: GatewayTaskIntent, metrics?: GatewayMetricsSnapshot, cost?: ModelCostValuation): GatewayAdaptiveCandidate => {
  const result: GatewayAdaptiveCandidate = { target: { ...target }, exclusions: [], missingSignals: [], ...(metrics ? { metrics } : {}), ...(cost ? { cost } : {}) };
  const quality = policy.qualityProfiles?.find(x => x.target.provider === target.provider && x.target.modelId === target.modelId && x.intent === intent);
  if (quality) result.quality = { score: quality.score, version: quality.version };
  const missing = (signal: string, action: "allow" | "reject") => { result.missingSignals.push(signal); if (action === "reject") result.exclusions.push(`${signal}-unavailable`); };
  if ((policy.weights.latency || policy.weights.errorRate) && (!metrics || metrics.successes + metrics.errors === 0)) missing("health", policy.coldStart);
  if (policy.weights.load && !metrics) missing("load", policy.coldStart);
  if (policy.weights.cost && (!cost || cost.amount === null)) missing("cost", policy.unknownCost);
  if (policy.weights.quality && !quality) missing("quality", policy.missingQuality);
  if (result.exclusions.length) return result;
  const errorRate = metrics && metrics.successes + metrics.errors > 0 ? metrics.errors / (metrics.successes + metrics.errors) : 0;
  const score = (quality?.score ?? 0) * policy.weights.quality
    - (metrics?.p95LatencyMs ?? 0) / policy.latencyScaleMs * policy.weights.latency
    - (cost?.amount ?? 0) / policy.costScale * policy.weights.cost
    - (metrics?.inFlight ?? 0) * policy.weights.load - errorRate * policy.weights.errorRate;
  if (!Number.isFinite(score)) throw new GatewayError("Adaptive signals produced a nonfinite score.", false);
  result.score = score; return result;
};
