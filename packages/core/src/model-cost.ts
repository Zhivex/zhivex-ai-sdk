import { priceCacheWriteLifetimes, readCacheWriteTokensDetails } from "./cache-write-usage.js";
import type { ModelCatalog } from "./catalog.js";
import { ValidationError } from "./errors.js";
import { appliesLongContextPricing } from "./pricing.js";
import type { CacheWriteTokensDetails, TokenUsage } from "./types.js";

export interface ModelCostInput {
  catalog: ModelCatalog;
  provider: string;
  modelId: string;
  usage?: TokenUsage;
  /** Missing cache counters remain unknown unless the caller explicitly assumes no cache. */
  cacheAssumption?: "reported" | "none";
  unknownPolicy?: "allow" | "reject";
  estimated?: boolean;
  /** Required for nonzero reasoning counters: adapters differ in whether output includes them. */
  reasoningAccounting?: "included" | "additional";
}
export interface ModelCostValuation {
  provider: string;
  modelId: string;
  status: "known" | "estimated" | "unknown";
  amount: number | null;
  currency: string | null;
  catalogVersion: string;
  pricingVersion: string | null;
  pricingSource?: string;
  unit: "per_1k_tokens";
  longContext: boolean | null;
  components: Partial<Record<"input" | "cachedInput" | "cacheWrite" | "output", { tokens: number; ratePer1kTokens: number | null; amount: number }>>;
  /**
   * Set when usage carried a lifetime split. `components.cacheWrite.amount` is the sum
   * of these amounts. 12-hour writes use 2.5× uncached input; 30-minute writes use the catalog write rate.
   */
  cacheWriteDetails?: {
    ttl30m: { tokens: number; ratePer1kTokens: number | null; amount: number };
    ttl12h: { tokens: number; ratePer1kTokens: number | null; amount: number };
  };
  unknownReasons: string[];
  assumptions: string[];
}

/** Values usage with cache-inclusive input and an explicit reasoning/output relationship. */
export const calculateModelCost = (input: ModelCostInput): ModelCostValuation => {
  if (input.unknownPolicy !== undefined && !["allow", "reject"].includes(input.unknownPolicy)) throw new ValidationError("Invalid cost unknownPolicy.");
  if (input.cacheAssumption !== undefined && !["reported", "none"].includes(input.cacheAssumption)) throw new ValidationError("Invalid cost cacheAssumption.");
  if (input.reasoningAccounting !== undefined && !["included", "additional"].includes(input.reasoningAccounting)) throw new ValidationError("Invalid reasoningAccounting.");
  const entry = input.catalog.find(input.provider, input.modelId);
  const pricing = input.catalog.metadata.pricing;
  const result: ModelCostValuation = {
    provider: input.provider, modelId: input.modelId, status: "unknown", amount: null,
    currency: pricing?.currency ?? null, catalogVersion: input.catalog.metadata.snapshotVersion,
    pricingVersion: pricing?.version ?? null, ...(pricing?.source ? { pricingSource: pricing.source } : {}),
    unit: "per_1k_tokens", longContext: null, components: {}, unknownReasons: [], assumptions: []
  };
  const unknown = (reason: string) => { if (!result.unknownReasons.includes(reason)) result.unknownReasons.push(reason); };
  if (!entry) unknown("model-pricing-missing");
  if (!pricing) unknown("pricing-provenance-missing");
  const usage = input.usage;
  let cacheWriteDetails: CacheWriteTokensDetails | undefined;
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (key === "cacheWriteTokensDetails") {
      if (value !== undefined) cacheWriteDetails = readCacheWriteTokensDetails(value);
      continue;
    }
    if (key !== "speed" && value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) throw new ValidationError(`Invalid usage counter ${key}.`);
  }
  if (usage?.speed !== undefined && !["standard", "fast"].includes(usage.speed)) throw new ValidationError("Invalid usage speed.");
  if (usage?.speed === "fast") unknown("fast-tier-pricing-unavailable");
  const cache = (key: "cachedInputTokens" | "cacheWriteTokens") => {
    if (usage?.[key] !== undefined) return usage[key];
    if (input.cacheAssumption === "none") { result.assumptions.push(`${key}=0 assumed`); return 0; }
    unknown(`${key}-missing`); return undefined;
  };
  const cached = cache("cachedInputTokens");
  let written: number | undefined;
  if (usage?.cacheWriteTokens !== undefined) written = usage.cacheWriteTokens;
  else if (cacheWriteDetails) written = (cacheWriteDetails.ttl30mTokens ?? 0) + (cacheWriteDetails.ttl12hTokens ?? 0);
  else written = cache("cacheWriteTokens");
  if (cacheWriteDetails && usage?.cacheWriteTokens !== undefined &&
    (cacheWriteDetails.ttl30mTokens ?? 0) + (cacheWriteDetails.ttl12hTokens ?? 0) !== usage.cacheWriteTokens) {
    throw new ValidationError("Cache write lifetime tokens do not match cacheWriteTokens.");
  }
  if (usage?.inputTokens === undefined) unknown("inputTokens-missing");
  if (usage?.outputTokens === undefined) unknown("outputTokens-missing");
  if (usage?.inputTokens !== undefined) {
    result.longContext = entry?.longContextPricing !== undefined && appliesLongContextPricing(usage.inputTokens, entry.longContextPricing);
  }
  if (usage?.inputTokens !== undefined && ((cached ?? 0) + (written ?? 0) > usage.inputTokens)) throw new ValidationError("Cache tokens exceed normalized inputTokens.");
  if (usage?.reasoningTokens && input.reasoningAccounting === undefined) unknown("reasoning-accounting-unspecified");
  if (input.reasoningAccounting === "included" && usage?.reasoningTokens !== undefined && usage.outputTokens !== undefined && usage.reasoningTokens > usage.outputTokens) throw new ValidationError("Reasoning tokens exceed inclusive outputTokens.");
  const component = (name: keyof ModelCostValuation["components"], tokens: number | undefined, rate: number | undefined, multiplier: number) => {
    if (tokens === undefined) return;
    if (tokens === 0) { result.components[name] = { tokens: 0, ratePer1kTokens: rate ?? null, amount: 0 }; return; }
    if (rate === undefined) { unknown(`${name}-price-missing`); return; }
    if (!Number.isFinite(rate) || rate < 0) throw new ValidationError("Invalid catalog price.");
    const amount = tokens * rate * multiplier / 1000;
    if (!Number.isFinite(amount)) throw new ValidationError("Cost overflow.");
    result.components[name] = { tokens, ratePer1kTokens: rate * multiplier, amount };
  };
  const inputMultiplier = result.longContext ? entry!.longContextPricing!.inputMultiplier : 1;
  const outputMultiplier = result.longContext ? entry!.longContextPricing!.outputMultiplier : 1;
  component("input", usage?.inputTokens !== undefined && cached !== undefined && written !== undefined ? usage.inputTokens - cached - written : undefined, entry?.inputCostPer1kTokens, inputMultiplier);
  component("cachedInput", cached, entry?.cachedInputCostPer1kTokens, inputMultiplier);
  if (cacheWriteDetails && written !== undefined) {
    const priced = priceCacheWriteLifetimes({
      cacheWriteTokens: written,
      details: cacheWriteDetails,
      cacheWriteRatePer1kTokens: entry?.cacheWriteCostPer1kTokens,
      inputRatePer1kTokens: entry?.inputCostPer1kTokens,
      inputMultiplier
    });
    if (!priced.ok) {
      for (const reason of priced.reasons) unknown(reason);
    } else {
      result.components.cacheWrite = {
        tokens: priced.price.tokens,
        ratePer1kTokens: priced.price.ratePer1kTokens,
        amount: priced.price.amount
      };
      result.cacheWriteDetails = priced.price.byTtl;
    }
  } else {
    component("cacheWrite", written, entry?.cacheWriteCostPer1kTokens, inputMultiplier);
  }
  component("output", usage?.outputTokens === undefined ? undefined : usage.outputTokens + (input.reasoningAccounting === "additional" ? usage.reasoningTokens ?? 0 : 0), entry?.outputCostPer1kTokens, outputMultiplier);
  if (!result.unknownReasons.length) {
    result.amount = Object.values(result.components).reduce((sum, part) => sum + part!.amount, 0);
    result.status = input.estimated || result.assumptions.length ? "estimated" : "known";
  } else if (input.unknownPolicy === "reject") {
    throw new ValidationError(`Model cost is unknown: ${result.unknownReasons.join(", ")}.`);
  }
  return result;
};
