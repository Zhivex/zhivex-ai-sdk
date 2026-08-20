import type { LongContextPricing } from "./pricing.js";

export type CatalogProviderId = string;

export const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;
export const MODEL_CATALOG_CONTRACT_VERSION = "1" as const;

export type ModelCatalogRecommendation = "chat" | "reasoning" | "speed" | "vision" | "tools";

export interface ModelCatalogPolicy {
  /** Whether the data is permanently pinned or can change when a new immutable snapshot is created. */
  data: "pinned" | "rolling";
  /** The boundary at which a rolling dataset is allowed to change. */
  updates: "never" | "catalog-replacement" | "package-release";
}

export interface ModelCatalogPricingSnapshotMetadata {
  version: string;
  currency: string;
  unit: "per_1k_tokens";
  effectiveAt?: string;
  source?: string;
}

export interface ModelCatalogSnapshotMetadata {
  schemaVersion: typeof MODEL_CATALOG_SCHEMA_VERSION;
  contractVersion: typeof MODEL_CATALOG_CONTRACT_VERSION;
  snapshotVersion: string;
  publishedAt?: string;
  policy: ModelCatalogPolicy;
  pricing?: ModelCatalogPricingSnapshotMetadata;
}

export interface CreateModelCatalogOptions {
  snapshotVersion?: string;
  publishedAt?: string;
  policy?: ModelCatalogPolicy;
  pricing?: ModelCatalogPricingSnapshotMetadata;
}

export interface ModelCatalogEntry {
  provider: CatalogProviderId;
  modelId: string;
  aliases?: string[];
  inputCostPer1kTokens?: number;
  cachedInputCostPer1kTokens?: number;
  cacheWriteCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  costPer1kTokens?: number;
  longContextPricing?: LongContextPricing;
  recommendedFor?: ModelCatalogRecommendation[];
}

export interface ModelCatalog {
  /** Metadata describing the immutable snapshot and how later snapshots may evolve. */
  readonly metadata: ModelCatalogSnapshotMetadata;
  find(provider: CatalogProviderId, modelId: string): ModelCatalogEntry | undefined;
  list(): ModelCatalogEntry[];
}

const recommendations = new Set<ModelCatalogRecommendation>([
  "chat",
  "reasoning",
  "speed",
  "vision",
  "tools"
]);

const costFields = [
  "inputCostPer1kTokens",
  "cachedInputCostPer1kTokens",
  "cacheWriteCostPer1kTokens",
  "outputCostPer1kTokens",
  "costPer1kTokens"
] as const;

const entryFields = new Set<keyof ModelCatalogEntry>([
  "provider",
  "modelId",
  "aliases",
  ...costFields,
  "longContextPricing",
  "recommendedFor"
]);

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${path} must be a non-empty string without surrounding whitespace or control characters`);
  }
}

function assertIsoDate(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/u.exec(
    value
  );
  if (match === null || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${path} must be an ISO 8601 date or timestamp`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    throw new TypeError(`${path} must be an ISO 8601 date or timestamp`);
  }
}

const cloneEntry = (entry: ModelCatalogEntry): ModelCatalogEntry => ({
  provider: entry.provider,
  modelId: entry.modelId,
  ...(entry.aliases === undefined ? {} : { aliases: [...entry.aliases] }),
  ...(entry.inputCostPer1kTokens === undefined ? {} : { inputCostPer1kTokens: entry.inputCostPer1kTokens }),
  ...(entry.cachedInputCostPer1kTokens === undefined
    ? {}
    : { cachedInputCostPer1kTokens: entry.cachedInputCostPer1kTokens }),
  ...(entry.cacheWriteCostPer1kTokens === undefined
    ? {}
    : { cacheWriteCostPer1kTokens: entry.cacheWriteCostPer1kTokens }),
  ...(entry.outputCostPer1kTokens === undefined ? {} : { outputCostPer1kTokens: entry.outputCostPer1kTokens }),
  ...(entry.costPer1kTokens === undefined ? {} : { costPer1kTokens: entry.costPer1kTokens }),
  ...(entry.longContextPricing === undefined
    ? {}
    : {
        longContextPricing: {
          inputTokenThreshold: entry.longContextPricing.inputTokenThreshold,
          inputMultiplier: entry.longContextPricing.inputMultiplier,
          outputMultiplier: entry.longContextPricing.outputMultiplier
        }
      }),
  ...(entry.recommendedFor === undefined ? {} : { recommendedFor: [...entry.recommendedFor] })
});

const freezeEntry = (entry: ModelCatalogEntry): ModelCatalogEntry => {
  entry.aliases && Object.freeze(entry.aliases);
  entry.longContextPricing && Object.freeze(entry.longContextPricing);
  entry.recommendedFor && Object.freeze(entry.recommendedFor);
  return Object.freeze(entry);
};

const cloneMetadata = (metadata: ModelCatalogSnapshotMetadata): ModelCatalogSnapshotMetadata => ({
  schemaVersion: metadata.schemaVersion,
  contractVersion: metadata.contractVersion,
  snapshotVersion: metadata.snapshotVersion,
  ...(metadata.publishedAt === undefined ? {} : { publishedAt: metadata.publishedAt }),
  policy: { ...metadata.policy },
  ...(metadata.pricing === undefined ? {} : { pricing: { ...metadata.pricing } })
});

const validateEntry = (entry: ModelCatalogEntry, index: number): void => {
  const path = `entries[${index}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new TypeError(`${path} must be an object`);
  }

  for (const field of Object.keys(entry)) {
    if (!entryFields.has(field as keyof ModelCatalogEntry)) {
      throw new TypeError(`${path}.${field} is not a supported model catalog field`);
    }
  }

  assertNonEmptyString(entry.provider, `${path}.provider`);
  assertNonEmptyString(entry.modelId, `${path}.modelId`);

  if (entry.aliases !== undefined) {
    if (!Array.isArray(entry.aliases)) {
      throw new TypeError(`${path}.aliases must be an array`);
    }
    const aliases = new Set<string>();
    for (const [aliasIndex, alias] of entry.aliases.entries()) {
      assertNonEmptyString(alias, `${path}.aliases[${aliasIndex}]`);
      if (aliases.has(alias)) {
        throw new TypeError(`${path}.aliases contains duplicate alias ${JSON.stringify(alias)}`);
      }
      aliases.add(alias);
    }
  }

  for (const field of costFields) {
    const value = entry[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new TypeError(`${path}.${field} must be a finite, non-negative number`);
    }
  }

  if (entry.longContextPricing !== undefined) {
    const pricing = entry.longContextPricing;
    if (typeof pricing !== "object" || pricing === null || Array.isArray(pricing)) {
      throw new TypeError(`${path}.longContextPricing must be an object`);
    }
    const pricingFields = new Set(["inputTokenThreshold", "inputMultiplier", "outputMultiplier"]);
    for (const field of Object.keys(pricing)) {
      if (!pricingFields.has(field)) {
        throw new TypeError(`${path}.longContextPricing.${field} is not supported`);
      }
    }
    if (!Number.isSafeInteger(pricing.inputTokenThreshold) || pricing.inputTokenThreshold <= 0) {
      throw new TypeError(`${path}.longContextPricing.inputTokenThreshold must be a positive safe integer`);
    }
    for (const field of ["inputMultiplier", "outputMultiplier"] as const) {
      const value = pricing[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new TypeError(`${path}.longContextPricing.${field} must be a finite, positive number`);
      }
    }
    if (
      entry.inputCostPer1kTokens === undefined &&
      entry.outputCostPer1kTokens === undefined &&
      entry.costPer1kTokens === undefined
    ) {
      throw new TypeError(`${path}.longContextPricing requires input, output, or fallback token pricing`);
    }
  }

  if (entry.recommendedFor !== undefined) {
    if (!Array.isArray(entry.recommendedFor) || entry.recommendedFor.length === 0) {
      throw new TypeError(`${path}.recommendedFor must be a non-empty array`);
    }
    const seen = new Set<ModelCatalogRecommendation>();
    for (const [recommendationIndex, recommendation] of entry.recommendedFor.entries()) {
      if (!recommendations.has(recommendation)) {
        throw new TypeError(`${path}.recommendedFor[${recommendationIndex}] is not supported`);
      }
      if (seen.has(recommendation)) {
        throw new TypeError(`${path}.recommendedFor contains duplicate value ${JSON.stringify(recommendation)}`);
      }
      seen.add(recommendation);
    }
  }
};

const createMetadata = (options: CreateModelCatalogOptions): ModelCatalogSnapshotMetadata => {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const snapshotVersion = options.snapshotVersion ?? "custom";
  assertNonEmptyString(snapshotVersion, "options.snapshotVersion");
  if (options.publishedAt !== undefined) {
    assertIsoDate(options.publishedAt, "options.publishedAt");
  }

  const policy = options.policy ?? { data: "pinned", updates: "never" };
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new TypeError("options.policy must be an object");
  }
  if (policy.data !== "pinned" && policy.data !== "rolling") {
    throw new TypeError("options.policy.data must be pinned or rolling");
  }
  if (
    policy.updates !== "never" &&
    policy.updates !== "catalog-replacement" &&
    policy.updates !== "package-release"
  ) {
    throw new TypeError("options.policy.updates must be never, catalog-replacement, or package-release");
  }
  if (
    (policy.data === "pinned" && policy.updates !== "never") ||
    (policy.data === "rolling" && policy.updates === "never")
  ) {
    throw new TypeError("options.policy must pair pinned data with never, or rolling data with an update boundary");
  }

  const pricing = options.pricing;
  if (pricing !== undefined) {
    if (typeof pricing !== "object" || pricing === null || Array.isArray(pricing)) {
      throw new TypeError("options.pricing must be an object");
    }
    assertNonEmptyString(pricing.version, "options.pricing.version");
    if (typeof pricing.currency !== "string" || !/^[A-Z]{3}$/u.test(pricing.currency)) {
      throw new TypeError("options.pricing.currency must be an uppercase ISO 4217 currency code");
    }
    if (pricing.unit !== "per_1k_tokens") {
      throw new TypeError("options.pricing.unit must be per_1k_tokens");
    }
    if (pricing.effectiveAt !== undefined) {
      assertIsoDate(pricing.effectiveAt, "options.pricing.effectiveAt");
    }
    if (pricing.source !== undefined) {
      assertNonEmptyString(pricing.source, "options.pricing.source");
    }
  }

  return {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    contractVersion: MODEL_CATALOG_CONTRACT_VERSION,
    snapshotVersion,
    ...(options.publishedAt === undefined ? {} : { publishedAt: options.publishedAt }),
    policy: { ...policy },
    ...(pricing === undefined ? {} : { pricing: { ...pricing } })
  };
};

export const createModelCatalog = (
  entries: readonly ModelCatalogEntry[],
  options: CreateModelCatalogOptions = {}
): ModelCatalog => {
  if (!Array.isArray(entries)) {
    throw new TypeError("entries must be an array");
  }

  const snapshot: ModelCatalogEntry[] = [];
  const lookup = new Map<string, Map<string, ModelCatalogEntry>>();

  for (const [index, entry] of entries.entries()) {
    validateEntry(entry, index);
    const frozenEntry = freezeEntry(cloneEntry(entry));
    const providerLookup = lookup.get(frozenEntry.provider) ?? new Map<string, ModelCatalogEntry>();
    lookup.set(frozenEntry.provider, providerLookup);

    for (const identifier of [frozenEntry.modelId, ...(frozenEntry.aliases ?? [])]) {
      const existing = providerLookup.get(identifier);
      if (existing !== undefined) {
        throw new TypeError(
          `entries[${index}] identifier ${JSON.stringify(identifier)} collides with ${JSON.stringify(existing.modelId)} for provider ${JSON.stringify(frozenEntry.provider)}`
        );
      }
      providerLookup.set(identifier, frozenEntry);
    }
    snapshot.push(frozenEntry);
  }

  Object.freeze(snapshot);
  const metadata = Object.freeze(createMetadata(options));
  Object.freeze(metadata.policy);
  metadata.pricing && Object.freeze(metadata.pricing);

  return Object.freeze({
    get metadata() {
      return cloneMetadata(metadata);
    },
    find(provider: CatalogProviderId, modelId: string) {
      const entry = lookup.get(provider)?.get(modelId);
      return entry === undefined ? undefined : cloneEntry(entry);
    },
    list() {
      return snapshot.map(cloneEntry);
    }
  });
};

/**
 * @deprecated Prefer `defaultModelCatalog` from `@zhivex-ai/sdk` for the
 * release-managed default inventory, or inject an application-owned catalog.
 * This compatibility snapshot remains available through the next major. It is
 * deliberately frozen at the migration boundary and must not receive later
 * inventory or pricing updates; only the SDK-owned snapshot advances.
 */
export const defaultModelCatalog = createModelCatalog([
  {
    provider: "openai",
    modelId: "gpt-5.6-sol",
    aliases: ["gpt-5.6"],
    inputCostPer1kTokens: 0.005,
    cachedInputCostPer1kTokens: 0.0005,
    cacheWriteCostPer1kTokens: 0.00625,
    outputCostPer1kTokens: 0.03,
    costPer1kTokens: 0.005,
    longContextPricing: {
      inputTokenThreshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5
    },
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "openai",
    modelId: "gpt-5.6-terra",
    inputCostPer1kTokens: 0.002,
    cachedInputCostPer1kTokens: 0.0002,
    cacheWriteCostPer1kTokens: 0.0025,
    outputCostPer1kTokens: 0.012,
    costPer1kTokens: 0.002,
    longContextPricing: {
      inputTokenThreshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5
    },
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "openai",
    modelId: "gpt-5.6-luna",
    inputCostPer1kTokens: 0.0002,
    cachedInputCostPer1kTokens: 0.00002,
    cacheWriteCostPer1kTokens: 0.00025,
    outputCostPer1kTokens: 0.0012,
    costPer1kTokens: 0.0002,
    longContextPricing: {
      inputTokenThreshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5
    },
    recommendedFor: ["chat", "reasoning", "speed", "tools", "vision"]
  },
  { provider: "openai", modelId: "gpt-5.5", costPer1kTokens: 0.005, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "openai", modelId: "gpt-5.4", costPer1kTokens: 0.0025, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "openai", modelId: "gpt-5.4-mini", costPer1kTokens: 0.00075, recommendedFor: ["chat", "tools", "speed", "vision"] },
  { provider: "openai", modelId: "gpt-4o-mini", costPer1kTokens: 0.0006, recommendedFor: ["chat", "tools", "speed"] },
  { provider: "openai", modelId: "gpt-image-2", recommendedFor: ["vision"] },
  { provider: "openai", modelId: "gpt-realtime-2.1", recommendedFor: ["chat", "tools", "speed", "vision"] },
  { provider: "openai", modelId: "gpt-realtime-2.1-mini", recommendedFor: ["chat", "tools", "speed", "vision"] },
  {
    provider: "xai",
    modelId: "grok-4.5",
    inputCostPer1kTokens: 0.002,
    outputCostPer1kTokens: 0.006,
    costPer1kTokens: 0.002,
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "meta",
    modelId: "muse-spark-1.2",
    inputCostPer1kTokens: 0.00125,
    cachedInputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.00425,
    costPer1kTokens: 0.00125,
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "meta",
    modelId: "muse-spark-1.2-contributor",
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "meta",
    modelId: "muse-spark-1.1",
    inputCostPer1kTokens: 0.00125,
    cachedInputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.00425,
    costPer1kTokens: 0.00125,
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  { provider: "azure-openai", modelId: "gpt-4o-mini", costPer1kTokens: 0.0006, recommendedFor: ["chat", "tools"] },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "anthropic",
    modelId: "claude-fable-5",
    aliases: ["claude-mythos-class"],
    costPer1kTokens: 0.01,
    recommendedFor: ["reasoning", "tools", "vision"]
  },
  {
    provider: "anthropic",
    modelId: "claude-mythos-5",
    costPer1kTokens: 0.01,
    recommendedFor: ["reasoning", "tools", "vision"]
  },
  {
    provider: "anthropic",
    modelId: "claude-opus-5",
    inputCostPer1kTokens: 0.005,
    cachedInputCostPer1kTokens: 0.0005,
    cacheWriteCostPer1kTokens: 0.00625,
    outputCostPer1kTokens: 0.025,
    costPer1kTokens: 0.005,
    recommendedFor: ["chat", "reasoning", "speed", "tools", "vision"]
  },
  {
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    aliases: ["claude-opus-4-7"],
    costPer1kTokens: 0.005,
    recommendedFor: ["reasoning", "tools"]
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    aliases: ["claude-haiku-4-5"],
    costPer1kTokens: 0.001,
    recommendedFor: ["chat", "reasoning", "speed", "vision"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.6-flash",
    inputCostPer1kTokens: 0.0015,
    cachedInputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.0075,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.5-flash-lite",
    inputCostPer1kTokens: 0.0003,
    cachedInputCostPer1kTokens: 0.00003,
    outputCostPer1kTokens: 0.0025,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.5-flash",
    aliases: ["gemini-flash-latest"],
    inputCostPer1kTokens: 0.0015,
    cachedInputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.009,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-pro-preview",
    recommendedFor: ["chat", "reasoning", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-pro-preview-customtools",
    recommendedFor: ["chat", "reasoning", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3-flash-preview",
    recommendedFor: ["chat", "speed", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-lite",
    recommendedFor: ["chat", "speed", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-lite-image",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-image",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3-pro-image",
    recommendedFor: ["vision", "reasoning"]
  },
  {
    provider: "gemini",
    modelId: "gemini-2.5-flash-image",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-live-preview",
    recommendedFor: ["speed", "vision", "tools"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.5-live-translate-preview",
    recommendedFor: ["speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-3.1-flash-tts-preview",
    recommendedFor: ["speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-embedding-2",
    recommendedFor: ["vision"]
  },
  {
    provider: "gemini",
    modelId: "gemini-robotics-er-1.6-preview",
    recommendedFor: ["vision", "reasoning"]
  },
  {
    provider: "gemini",
    modelId: "veo-3.1-generate-preview",
    recommendedFor: ["vision"]
  },
  {
    provider: "gemini",
    modelId: "veo-3.1-fast-generate-preview",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "veo-3.1-lite-generate-preview",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "gemini-omni-flash-preview",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "gemini",
    modelId: "lyria-3-clip-preview"
  },
  {
    provider: "gemini",
    modelId: "lyria-3-pro-preview"
  },
  {
    provider: "gemini",
    modelId: "lyria-realtime-exp",
    recommendedFor: ["speed"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.6-flash",
    inputCostPer1kTokens: 0.0015,
    cachedInputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.0075,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.5-flash-lite",
    inputCostPer1kTokens: 0.0003,
    cachedInputCostPer1kTokens: 0.00003,
    outputCostPer1kTokens: 0.0025,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.5-flash",
    aliases: ["gemini-flash-latest"],
    inputCostPer1kTokens: 0.0015,
    cachedInputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.009,
    recommendedFor: ["chat", "reasoning", "speed", "vision", "tools"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.5-live-translate-preview",
    recommendedFor: ["speed"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.1-pro-preview",
    recommendedFor: ["chat", "reasoning", "vision", "tools"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.1-flash-lite",
    recommendedFor: ["chat", "speed", "vision", "tools"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.1-flash-lite-image",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.1-flash-image",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3-pro-image",
    recommendedFor: ["vision", "reasoning"]
  },
  {
    provider: "vertex",
    modelId: "gemini-2.5-flash-image",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "vertex",
    modelId: "gemini-live-2.5-flash-native-audio",
    recommendedFor: ["speed", "vision", "tools"]
  },
  {
    provider: "vertex",
    modelId: "gemini-3.1-flash-tts-preview",
    recommendedFor: ["speed"]
  },
  {
    provider: "vertex",
    modelId: "gemini-embedding-2",
    recommendedFor: ["vision"]
  },
  {
    provider: "vertex",
    modelId: "veo-3.1-generate-001",
    recommendedFor: ["vision"]
  },
  {
    provider: "vertex",
    modelId: "veo-3.1-fast-generate-001",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "vertex",
    modelId: "veo-3.1-lite-generate-001",
    recommendedFor: ["vision", "speed"]
  },
  {
    provider: "vertex",
    modelId: "lyria-002"
  },
  { provider: "qwen", modelId: "qwen3.8-max", recommendedFor: ["chat", "tools", "reasoning", "vision"] },
  { provider: "qwen", modelId: "qwen3.8-max-preview", recommendedFor: ["chat", "tools", "reasoning", "vision"] },
  { provider: "qwen", modelId: "qwen3.7-max", costPer1kTokens: 0.0016, recommendedFor: ["chat", "tools", "reasoning"] },
  { provider: "qwen", modelId: "qwen3.7-plus", costPer1kTokens: 0.0008, recommendedFor: ["chat", "tools", "reasoning", "vision"] },
  { provider: "qwen", modelId: "qwen3.6-flash", costPer1kTokens: 0.0002, recommendedFor: ["chat", "speed", "tools", "vision"] },
  { provider: "qwen", modelId: "qwen3.5-omni-plus", recommendedFor: ["chat", "vision", "speed", "tools"] },
  { provider: "qwen", modelId: "qwen3.5-omni-plus-realtime", recommendedFor: ["vision", "speed"] },
  { provider: "qwen", modelId: "qwen3.5-ocr", recommendedFor: ["vision", "speed"] },
  { provider: "qwen", modelId: "tongyi-embedding-vision-plus", recommendedFor: ["vision"] },
  { provider: "qwen", modelId: "qwen3-vl-embedding", recommendedFor: ["vision"] },
  { provider: "qwen", modelId: "qwen3-rerank" },
  { provider: "qwen", modelId: "qwen3-asr-flash", recommendedFor: ["speed"] },
  { provider: "qwen", modelId: "qwen3-tts-flash", recommendedFor: ["speed"] },
  { provider: "qwen", modelId: "qwen-image-2.0-pro", recommendedFor: ["vision"] },
  { provider: "qwen", modelId: "wan2.7-t2v", recommendedFor: ["vision"] },
  { provider: "qwen", modelId: "qwen-plus", costPer1kTokens: 0.0008, recommendedFor: ["chat", "tools", "reasoning"] },
  {
    provider: "kimi",
    modelId: "kimi-k3",
    inputCostPer1kTokens: 0.003,
    cachedInputCostPer1kTokens: 0.0003,
    outputCostPer1kTokens: 0.015,
    costPer1kTokens: 0.003,
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "kimi",
    modelId: "kimi-k2.7-code",
    aliases: ["kimi-k2.7-code-highspeed"],
    costPer1kTokens: 0.002,
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  { provider: "kimi", modelId: "kimi-k2.6", costPer1kTokens: 0.002, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "kimi", modelId: "kimi-k2.5", costPer1kTokens: 0.002, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "kimi", modelId: "kimi-k2-0905-preview", costPer1kTokens: 0.002, recommendedFor: ["tools"] },
  {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    inputCostPer1kTokens: 0.00014,
    cachedInputCostPer1kTokens: 0.0000028,
    outputCostPer1kTokens: 0.00028,
    costPer1kTokens: 0.00014,
    recommendedFor: ["chat", "tools", "reasoning", "speed"]
  },
  {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    inputCostPer1kTokens: 0.000435,
    cachedInputCostPer1kTokens: 0.000003625,
    outputCostPer1kTokens: 0.00087,
    costPer1kTokens: 0.000435,
    recommendedFor: ["chat", "tools", "reasoning"]
  },
  {
    provider: "zai",
    modelId: "glm-5.3",
    recommendedFor: ["chat", "tools", "reasoning"]
  },
  {
    provider: "zai",
    modelId: "glm-5.2",
    inputCostPer1kTokens: 0.0014,
    cachedInputCostPer1kTokens: 0.00026,
    outputCostPer1kTokens: 0.0044,
    costPer1kTokens: 0.0014,
    recommendedFor: ["chat", "tools", "reasoning"]
  },
  {
    provider: "openrouter",
    modelId: "meta/muse-spark-1.2",
    inputCostPer1kTokens: 0.00125,
    cachedInputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.00425,
    costPer1kTokens: 0.00125,
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  {
    provider: "openrouter",
    modelId: "meta/muse-glimmer-30b",
    inputCostPer1kTokens: 0.00035,
    cachedInputCostPer1kTokens: 0.00004,
    outputCostPer1kTokens: 0.0015,
    costPer1kTokens: 0.00035,
    recommendedFor: ["chat", "reasoning", "tools", "vision"]
  },
  { provider: "openrouter", modelId: "openai/gpt-4o-mini", costPer1kTokens: 0.0007, recommendedFor: ["chat", "tools"] },
  { provider: "bedrock", modelId: "anthropic.claude-3-5-sonnet", costPer1kTokens: 0.003, recommendedFor: ["reasoning"] },
  { provider: "ollama", modelId: "gemma4", costPer1kTokens: 0, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "ollama", modelId: "qwen3.5", costPer1kTokens: 0, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "ollama", modelId: "qwen3", costPer1kTokens: 0, recommendedFor: ["chat", "reasoning", "tools"] },
  { provider: "ollama", modelId: "gpt-oss", costPer1kTokens: 0, recommendedFor: ["chat", "reasoning", "tools"] },
  { provider: "ollama", modelId: "muse-glimmer:30b", costPer1kTokens: 0, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "ollama", modelId: "muse-glimmer:30b-mlx", costPer1kTokens: 0, recommendedFor: ["chat", "reasoning", "tools", "vision"] },
  { provider: "ollama", modelId: "embeddinggemma", costPer1kTokens: 0 },
  { provider: "ollama", modelId: "llama3.2", costPer1kTokens: 0, recommendedFor: ["chat", "speed"] }
], {
  snapshotVersion: "2026-08-16",
  publishedAt: "2026-08-16T00:00:00.000Z",
  policy: {
    data: "rolling",
    updates: "package-release"
  },
  pricing: {
    version: "2026-08-16",
    currency: "USD",
    unit: "per_1k_tokens",
    effectiveAt: "2026-08-16",
    source: "zhivex-ai-sdk-default-catalog"
  }
});
