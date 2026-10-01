import type { ModelCatalogEntry } from "@zhivex-ai/core/catalog";
import { GatewayError, type GatewayConfig } from "./types.js";
import { targetKey } from "./target.js";

/** Maximum declared token rate, including cache and long-context tiers, independent of token mix. */
export const catalogRoutingRate = (entry?: ModelCatalogEntry): number | undefined => {
  if (!entry) return undefined;
  if (entry.inputCostPer1kTokens !== undefined && entry.outputCostPer1kTokens !== undefined) {
    const inputMultiplier = Math.max(1, entry.longContextPricing?.inputMultiplier ?? 1);
    const outputMultiplier = Math.max(1, entry.longContextPricing?.outputMultiplier ?? 1);
    return Math.max(
      entry.inputCostPer1kTokens * inputMultiplier,
      entry.outputCostPer1kTokens * outputMultiplier,
      (entry.cachedInputCostPer1kTokens ?? 0) * inputMultiplier,
      (entry.cacheWriteCostPer1kTokens ?? 0) * inputMultiplier
    );
  }
  return entry.costPer1kTokens;
};

export const validateRoutingPolicy = (config: GatewayConfig) => {
  const policy = config.routingPolicy;
  if (!policy) return;
  if (config.adaptiveRouting || config.scoreTarget) throw new GatewayError("Choose routingPolicy, adaptiveRouting or scoreTarget.", false);
  if (policy.mode !== undefined && policy.mode !== "legacy" && policy.mode !== "evidence") throw new GatewayError("Invalid routingPolicy mode.", false);
  if (policy.unknownCostPenalty !== undefined && (!Number.isFinite(policy.unknownCostPenalty) || policy.unknownCostPenalty < 0)) throw new GatewayError("unknownCostPenalty must be finite and nonnegative.", false);
  const keys = new Set<string>();
  for (const profile of policy.qualityProfiles ?? []) {
    const key = JSON.stringify([targetKey(profile.target), profile.intent]);
    if (keys.has(key) || !["chat", "reasoning", "tool-heavy"].includes(profile.intent) || !profile.version?.trim() || !Number.isFinite(profile.score) || profile.score < 0 || profile.score > 1) {
      throw new GatewayError("Invalid or ambiguous routing quality profile.", false);
    }
    keys.add(key);
  }
};
