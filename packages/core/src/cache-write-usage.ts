import { ValidationError } from "./errors.js";
import type { TokenUsage } from "./types.js";

/**
 * OpenAI Responses bills 12-hour cache writes at 2.5× the uncached input rate.
 * The catalog `cacheWriteCostPer1kTokens` remains the 30-minute / default write rate.
 * @see https://developers.openai.com/api/docs/guides/prompt-caching
 */
const OPENAI_CACHE_WRITE_12H_INPUT_MULTIPLIER = 2.5;

export interface CacheWriteLifetimePrice {
  tokens: number;
  ratePer1kTokens: number | null;
  amount: number;
}

export interface PricedCacheWriteLifetimes {
  tokens: number;
  ratePer1kTokens: number | null;
  amount: number;
  byTtl: {
    ttl30m: CacheWriteLifetimePrice;
    ttl12h: CacheWriteLifetimePrice;
  };
}

const detailFields = ["ttl30mTokens", "ttl12hTokens"] as const;

/** Reads a lifetime split. Absent fields are omitted; unknown fields and bad counters throw. */
export const readCacheWriteTokensDetails = (
  value: unknown
): NonNullable<TokenUsage["cacheWriteTokensDetails"]> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Invalid cacheWriteTokensDetails.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!detailFields.includes(key as (typeof detailFields)[number])) {
      throw new ValidationError(`Invalid cacheWriteTokensDetails.${key}.`);
    }
  }
  const read = (key: (typeof detailFields)[number]) => {
    const count = record[key];
    if (count === undefined) return undefined;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new ValidationError(`Invalid usage counter cacheWriteTokensDetails.${key}.`);
    }
    return count;
  };
  const ttl30mTokens = read("ttl30mTokens");
  const ttl12hTokens = read("ttl12hTokens");
  if (ttl30mTokens === undefined && ttl12hTokens === undefined) {
    throw new ValidationError("Invalid cacheWriteTokensDetails.");
  }
  return {
    ...(ttl30mTokens !== undefined ? { ttl30mTokens } : {}),
    ...(ttl12hTokens !== undefined ? { ttl12hTokens } : {})
  };
};

const detailTokenSum = (details: NonNullable<TokenUsage["cacheWriteTokensDetails"]>) =>
  (details.ttl30mTokens ?? 0) + (details.ttl12hTokens ?? 0);

/**
 * Keeps a lifetime split only when every write in the group has a consistent split.
 * A response that reports `cacheWriteTokens` without the split drops the whole group's
 * split, so the total stays on the single catalog write rate instead of pricing an
 * incomplete 12-hour subset and guessing the rest.
 */
export const mergeCacheWriteTokensDetails = (
  usages: Array<TokenUsage | undefined>
): TokenUsage["cacheWriteTokensDetails"] | undefined => {
  const present = usages.filter((usage): usage is TokenUsage => usage !== undefined);
  if (!present.some((usage) => usage.cacheWriteTokensDetails)) return undefined;
  const consistent = (usage: TokenUsage) => {
    const details = usage.cacheWriteTokensDetails;
    if (!details) return (usage.cacheWriteTokens ?? 0) === 0;
    return usage.cacheWriteTokens !== undefined && detailTokenSum(details) === usage.cacheWriteTokens;
  };
  if (present.some((usage) => !consistent(usage))) return undefined;
  let saw30m = false;
  let saw12h = false;
  let ttl30mTokens = 0;
  let ttl12hTokens = 0;
  for (const usage of present) {
    const details = usage.cacheWriteTokensDetails;
    if (!details) continue;
    if (details.ttl30mTokens !== undefined) {
      saw30m = true;
      ttl30mTokens += details.ttl30mTokens;
    }
    if (details.ttl12hTokens !== undefined) {
      saw12h = true;
      ttl12hTokens += details.ttl12hTokens;
    }
  }
  if (!saw30m && !saw12h) return undefined;
  return {
    ...(saw30m ? { ttl30mTokens } : {}),
    ...(saw12h ? { ttl12hTokens } : {})
  };
};

const lifetimeLine = (
  tokens: number,
  ratePer1kTokens: number | undefined,
  inputMultiplier: number
): CacheWriteLifetimePrice | undefined => {
  if (tokens === 0) {
    return {
      tokens: 0,
      ratePer1kTokens: ratePer1kTokens === undefined ? null : ratePer1kTokens * inputMultiplier,
      amount: 0
    };
  }
  if (ratePer1kTokens === undefined) return undefined;
  if (!Number.isFinite(ratePer1kTokens) || ratePer1kTokens < 0) {
    throw new ValidationError("Invalid catalog price.");
  }
  const amount = tokens * ratePer1kTokens * inputMultiplier / 1000;
  if (!Number.isFinite(amount)) throw new ValidationError("Cost overflow.");
  return { tokens, ratePer1kTokens: ratePer1kTokens * inputMultiplier, amount };
};

/**
 * Prices a reported lifetime split. 30-minute tokens use the catalog write rate.
 * 12-hour tokens use 2.5× the uncached input rate. Both rates include `inputMultiplier`.
 * The combined `amount` is the full write charge; do not add `cacheWriteTokens` again.
 */
export const priceCacheWriteLifetimes = (input: {
  cacheWriteTokens: number;
  details: NonNullable<TokenUsage["cacheWriteTokensDetails"]>;
  cacheWriteRatePer1kTokens?: number;
  inputRatePer1kTokens?: number;
  inputMultiplier: number;
}): { ok: true; price: PricedCacheWriteLifetimes } | { ok: false; reasons: string[] } => {
  const ttl30mTokens = input.details.ttl30mTokens ?? 0;
  const ttl12hTokens = input.details.ttl12hTokens ?? 0;
  if (ttl30mTokens + ttl12hTokens !== input.cacheWriteTokens) {
    throw new ValidationError("Cache write lifetime tokens do not match cacheWriteTokens.");
  }
  const ttl30m = lifetimeLine(ttl30mTokens, input.cacheWriteRatePer1kTokens, input.inputMultiplier);
  const twelveHourRate = input.inputRatePer1kTokens === undefined
    ? undefined
    : input.inputRatePer1kTokens * OPENAI_CACHE_WRITE_12H_INPUT_MULTIPLIER;
  const ttl12h = lifetimeLine(ttl12hTokens, twelveHourRate, input.inputMultiplier);
  const reasons: string[] = [];
  if (!ttl30m) reasons.push("cacheWrite-price-missing");
  if (!ttl12h) reasons.push("cacheWrite12h-price-missing");
  if (!ttl30m || !ttl12h) return { ok: false, reasons };
  const tokens = ttl30m.tokens + ttl12h.tokens;
  const amount = ttl30m.amount + ttl12h.amount;
  return {
    ok: true,
    price: {
      tokens,
      ratePer1kTokens: tokens === 0 ? ttl30m.ratePer1kTokens ?? ttl12h.ratePer1kTokens : amount * 1000 / tokens,
      amount,
      byTtl: { ttl30m, ttl12h }
    }
  };
};

/** Maps OpenAI `cache_write_tokens_details` when either lifetime counter is present. */
export const cacheWriteTokensDetailsFromProvider = (
  details: unknown
): TokenUsage["cacheWriteTokensDetails"] | undefined => {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const record = details as Record<string, unknown>;
  const read = (key: string) => typeof record[key] === "number" ? record[key] as number : undefined;
  const ttl30mTokens = read("ttl_30m_tokens");
  const ttl12hTokens = read("ttl_12h_tokens");
  if (ttl30mTokens === undefined && ttl12hTokens === undefined) return undefined;
  return {
    ...(ttl30mTokens !== undefined ? { ttl30mTokens } : {}),
    ...(ttl12hTokens !== undefined ? { ttl12hTokens } : {})
  };
};
