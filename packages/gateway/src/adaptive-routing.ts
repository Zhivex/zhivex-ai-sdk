import { targetKey, sameTarget } from "./target.js";
import { GatewayError, type GatewayModelTarget, type GatewayTaskIntent } from "./types.js";
import type { GatewayMetricsSnapshot } from "./metrics.js";
import type { ModelCostValuation } from "@zhivex-ai/core";
export interface GatewayQualityProfile { target: GatewayModelTarget; intent: GatewayTaskIntent; score: number; version: string; }
export interface GatewayAdaptiveRoutingPolicy {
  version: string;
  /** Select latency relevant to the workload; full attempt is the legacy default. */
  latencyMetric?: "total" | "ttft";
  minSamples?: number;
  /** Probe one allowed cold destination every N operations. Disabled unless configured. */
  explorationEvery?: number;
  throughputScale?: number;
  /** Conservative normalized penalties used for allowed missing signals. */
  missingSignalPenalty?: number;
  minQuality?: number;
  weights: { latency: number; cost: number; quality: number; load: number; errorRate: number; throughput?: number };
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
  const values = [policy.weights?.latency, policy.weights?.cost, policy.weights?.quality, policy.weights?.load, policy.weights?.errorRate, policy.weights?.throughput ?? 0];
  if (!values.every(x => Number.isFinite(x) && x >= 0) || values.every(x => x === 0)) throw new GatewayError("Adaptive weights must be nonnegative with at least one positive weight.", false);
  if (![policy.coldStart, policy.unknownCost, policy.missingQuality].every(x => x === "allow" || x === "reject")) throw new GatewayError("Adaptive missing-data policies must be explicit.", false);
  if (policy.latencyMetric !== undefined && !["total", "ttft"].includes(policy.latencyMetric)) throw new GatewayError("Invalid latencyMetric.", false);
  if (policy.minSamples !== undefined && (!Number.isSafeInteger(policy.minSamples) || policy.minSamples < 1)) throw new GatewayError("Invalid minSamples.", false);
  if (policy.missingSignalPenalty !== undefined && (!Number.isFinite(policy.missingSignalPenalty) || policy.missingSignalPenalty < 1)) throw new GatewayError("missingSignalPenalty must be at least one.", false);
  if (policy.minQuality !== undefined && (!Number.isFinite(policy.minQuality) || policy.minQuality < 0 || policy.minQuality > 1)) throw new GatewayError("Invalid minQuality.", false);
  if (policy.throughputScale !== undefined && (!Number.isFinite(policy.throughputScale) || policy.throughputScale <= 0)) throw new GatewayError("Invalid throughputScale.", false);
  if (policy.explorationEvery !== undefined && (!Number.isSafeInteger(policy.explorationEvery) || policy.explorationEvery < 2)) throw new GatewayError("explorationEvery must be at least two.", false);
  const keys = new Set<string>();
  for (const profile of policy.qualityProfiles ?? []) {
    const key = JSON.stringify([targetKey(profile.target), profile.intent]);
    if (keys.has(key) || !profile.version?.trim() || !Number.isFinite(profile.score) || profile.score < 0 || profile.score > 1) throw new GatewayError("Invalid or ambiguous quality profile.", false);
    keys.add(key);
  }
};
export const scoreAdaptiveTarget = (policy: GatewayAdaptiveRoutingPolicy, target: GatewayModelTarget, intent: GatewayTaskIntent, metrics?: GatewayMetricsSnapshot, cost?: ModelCostValuation): GatewayAdaptiveCandidate => {
  const result: GatewayAdaptiveCandidate = { target: { ...target }, exclusions: [], missingSignals: [], ...(metrics ? { metrics } : {}), ...(cost ? { cost } : {}) };
  const quality = policy.qualityProfiles?.find(x => sameTarget(x.target, target) && x.intent === intent);
  if (quality) result.quality = { score: quality.score, version: quality.version };
  const missing = (signal: string, action: "allow" | "reject") => { result.missingSignals.push(signal); if (action === "reject") result.exclusions.push(`${signal}-unavailable`); };
  const healthy = !!metrics && metrics.successes + metrics.errors >= (policy.minSamples ?? 1);
  const latency = policy.latencyMetric === "ttft" ? metrics?.p95TtftMs : metrics?.p95LatencyMs;
  if ((policy.weights.latency || policy.weights.errorRate) && !healthy) missing("health", policy.coldStart);
  if (policy.weights.latency && healthy && latency === undefined) missing("latency", policy.coldStart);
  if (policy.weights.throughput && (!healthy || metrics?.p50TokensPerSecond === undefined)) missing("throughput", policy.coldStart);
  if (policy.weights.load && !metrics) missing("load", policy.coldStart);
  if (policy.weights.cost && (!cost || cost.amount === null)) missing("cost", policy.unknownCost);
  if (policy.weights.quality && !quality) missing("quality", policy.missingQuality);
  if (policy.minQuality !== undefined && (!quality || quality.score < policy.minQuality)) result.exclusions.push("quality-floor");
  if (result.exclusions.length) return result;
  const penalty = policy.missingSignalPenalty ?? 1;
  const errorRate = healthy ? metrics!.errors / (metrics!.successes + metrics!.errors) : penalty;
  const score = (quality?.score ?? 0) * policy.weights.quality
    + (healthy ? metrics?.p50TokensPerSecond ?? 0 : 0) / (policy.throughputScale ?? 100) * (policy.weights.throughput ?? 0)
    - (healthy && latency !== undefined ? latency / policy.latencyScaleMs : penalty) * policy.weights.latency
    - (cost?.amount != null ? cost.amount / policy.costScale : penalty) * policy.weights.cost
    - (metrics?.inFlight ?? penalty) * policy.weights.load - errorRate * policy.weights.errorRate;
  if (!Number.isFinite(score)) throw new GatewayError("Adaptive signals produced a nonfinite score.", false);
  result.score = score; return result;
};

/** Explicit starting policies. Calibrate scales and quality profiles against your own workloads. */
export const createGatewayRoutingPolicy = (preset: "interactive" | "economy" | "quality", overrides: Partial<GatewayAdaptiveRoutingPolicy> = {}): GatewayAdaptiveRoutingPolicy => {
  const policy: GatewayAdaptiveRoutingPolicy = {
    version: `gateway-${preset}-v1`, latencyMetric: preset === "interactive" ? "ttft" : "total",
    latencyScaleMs: 1000, costScale: 0.01, minSamples: 5, explorationEvery: 20,
    coldStart: "allow", unknownCost: "reject", missingQuality: "reject",
    weights: preset === "interactive" ? { latency: 2, cost: 1, quality: 0, load: 1, errorRate: 3 }
      : preset === "economy" ? { latency: .25, cost: 3, quality: 1, load: 1, errorRate: 3 }
      : { latency: .25, cost: .25, quality: 3, load: 1, errorRate: 3 },
    ...overrides
  };
  validateAdaptivePolicy(policy); return policy;
};
