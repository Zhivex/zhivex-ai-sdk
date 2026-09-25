import type { LongContextPricing } from "./pricing.js";

export type CatalogProviderId = string;

export const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;
export const MODEL_CATALOG_CONTRACT_VERSION = "1" as const;

export type ModelCatalogRecommendation = "chat" | "reasoning" | "speed" | "vision" | "tools" | "compaction";

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

/** Evidence belongs to the individual datum, never implicitly to the whole snapshot. */
export interface ModelCatalogDatumEvidence {
  source: string;
  sourceType: "primary";
  verifiedAt: string;
  /** Host-defined conditions that must all match the requested route. */
  conditions?: string[];
}

export type ModelCatalogContextWindowType = "combined" | "input";
export type ModelCatalogEvidenceField = "contextWindowTokens" | "contextWindowType" | "maxInputTokens" | "maxOutputTokens"
  | "inputCostPer1kTokens" | "outputCostPer1kTokens" | "longContextPricing";
export interface ModelCatalogCompactionEvidence {
  status: "candidate" | "evaluated";
  /** Evaluation artifacts are distinct from provider capability documentation. */
  evaluation?: { source: string; fixture: string; version: string; evaluatedAt: string; passed: boolean };
}

export interface ModelCatalogEntry {
  provider: CatalogProviderId;
  modelId: string;
  aliases?: string[];
  /** Missing limits mean unknown, never an unlimited window. */
  contextWindowTokens?: number;
  contextWindowType?: ModelCatalogContextWindowType;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  evidence?: Partial<Record<ModelCatalogEvidenceField, ModelCatalogDatumEvidence>>;
  compaction?: ModelCatalogCompactionEvidence;
  inputCostPer1kTokens?: number;
  cachedInputCostPer1kTokens?: number;
  cacheWriteCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  costPer1kTokens?: number;
  longContextPricing?: LongContextPricing;
  recommendedFor?: ModelCatalogRecommendation[];
  /** Host-specific lifecycle evidence, captured at the catalog snapshot date. */
  lifecycle?: {
    deprecatedAt?: string;
    retiredAt?: string;
    source: string;
  };
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
  "tools",
  "compaction"
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
  "recommendedFor",
  "lifecycle",
  "contextWindowTokens", "contextWindowType", "maxInputTokens", "maxOutputTokens", "evidence", "compaction"
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

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
}
function assertFields(value: object, fields: string[], path: string): void {
  for (const field of Object.keys(value)) if (!fields.includes(field)) throw new TypeError(`${path}.${field} is not supported`);
}
function assertSource(value: unknown, path: string): void {
  assertNonEmptyString(value, path);
  let source: URL;
  try { source = new URL(value); } catch { throw new TypeError(`${path} must be an HTTPS URL`); }
  if (source.protocol !== "https:" || source.username || source.password) throw new TypeError(`${path} must be an HTTPS URL without credentials`);
}

const cloneEntry = (entry: ModelCatalogEntry): ModelCatalogEntry => ({
  provider: entry.provider,
  modelId: entry.modelId,
  ...Object.fromEntries(["contextWindowTokens", "contextWindowType", "maxInputTokens", "maxOutputTokens"].filter(key => entry[key as keyof ModelCatalogEntry] !== undefined).map(key => [key, entry[key as keyof ModelCatalogEntry]])),
  ...(entry.evidence === undefined ? {} : { evidence: structuredClone(entry.evidence) }),
  ...(entry.compaction === undefined ? {} : { compaction: structuredClone(entry.compaction) }),
  ...(entry.lifecycle === undefined ? {} : { lifecycle: { ...entry.lifecycle } }),
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
  if (entry.evidence) {
    for (const evidence of Object.values(entry.evidence)) {
      if (evidence.conditions) Object.freeze(evidence.conditions);
      Object.freeze(evidence);
    }
    Object.freeze(entry.evidence);
  }
  if (entry.compaction) {
    if (entry.compaction.evaluation) Object.freeze(entry.compaction.evaluation);
    Object.freeze(entry.compaction);
  }
  entry.lifecycle && Object.freeze(entry.lifecycle);
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

  const limits = ["contextWindowTokens", "maxInputTokens", "maxOutputTokens"] as const;
  for (const field of limits) {
    if (entry[field] !== undefined && (!Number.isSafeInteger(entry[field]) || entry[field]! <= 0)) throw new TypeError(`${path}.${field} must be a positive safe integer`);
  }
  if (entry.contextWindowType !== undefined && !["combined", "input"].includes(entry.contextWindowType)) throw new TypeError(`${path}.contextWindowType is not supported`);
  if ((entry.contextWindowTokens === undefined) !== (entry.contextWindowType === undefined)) throw new TypeError(`${path} requires both contextWindowTokens and contextWindowType`);
  if (entry.contextWindowTokens !== undefined && entry.maxInputTokens !== undefined && entry.maxInputTokens > entry.contextWindowTokens) throw new TypeError(`${path}.maxInputTokens exceeds contextWindowTokens`);
  if (entry.contextWindowType === "combined" && entry.maxOutputTokens !== undefined && entry.maxOutputTokens > entry.contextWindowTokens!) throw new TypeError(`${path}.maxOutputTokens exceeds combined contextWindowTokens`);
  if (entry.evidence !== undefined) {
    assertRecord(entry.evidence, `${path}.evidence`);
    for (const [field, evidence] of Object.entries(entry.evidence)) {
      if (![...limits, "contextWindowType", "inputCostPer1kTokens", "outputCostPer1kTokens", "longContextPricing"].includes(field)) throw new TypeError(`${path}.evidence.${field} is not supported`);
      if (entry[field as keyof ModelCatalogEntry] === undefined) throw new TypeError(`${path}.evidence.${field} has no associated datum`);
      assertRecord(evidence, `${path}.evidence.${field}`);
      assertFields(evidence, ["source", "sourceType", "verifiedAt", "conditions"], `${path}.evidence.${field}`);
      assertSource(evidence.source, `${path}.evidence.${field}.source`);
      if (evidence.sourceType !== "primary") throw new TypeError(`${path}.evidence.${field}.sourceType must be primary`);
      assertIsoDate(evidence.verifiedAt, `${path}.evidence.${field}.verifiedAt`);
      if (evidence.conditions !== undefined) {
        if (!Array.isArray(evidence.conditions)) throw new TypeError(`${path}.evidence.${field}.conditions must be an array`);
        evidence.conditions.forEach((condition, i) => assertNonEmptyString(condition, `${path}.evidence.${field}.conditions[${i}]`));
      }
    }
  }
  for (const field of [...limits, "contextWindowType"] as const) {
    if (entry[field] !== undefined && entry.evidence?.[field] === undefined) throw new TypeError(`${path}.${field} requires per-datum evidence`);
  }
  if (entry.compaction !== undefined) {
    assertRecord(entry.compaction, `${path}.compaction`);
    assertFields(entry.compaction, ["status", "evaluation"], `${path}.compaction`);
    if (!["candidate", "evaluated"].includes(entry.compaction.status)) throw new TypeError(`${path}.compaction.status is not supported`);
    const evaluation = entry.compaction.evaluation;
    if (entry.compaction.status === "evaluated" && evaluation === undefined) throw new TypeError(`${path}.compaction evaluated status requires evaluation evidence`);
    if (evaluation !== undefined) {
      assertRecord(evaluation, `${path}.compaction.evaluation`);
      assertFields(evaluation, ["source", "fixture", "version", "evaluatedAt", "passed"], `${path}.compaction.evaluation`);
      assertSource(evaluation.source, `${path}.compaction.evaluation.source`);
      assertNonEmptyString(evaluation.fixture, `${path}.compaction.evaluation.fixture`);
      assertNonEmptyString(evaluation.version, `${path}.compaction.evaluation.version`);
      assertIsoDate(evaluation.evaluatedAt, `${path}.compaction.evaluation.evaluatedAt`);
      if (typeof evaluation.passed !== "boolean") throw new TypeError(`${path}.compaction.evaluation.passed must be boolean`);
    }
  }
  assertNonEmptyString(entry.provider, `${path}.provider`);
  assertNonEmptyString(entry.modelId, `${path}.modelId`);
  if (entry.lifecycle !== undefined) {
    const lifecycle = entry.lifecycle;
    if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) throw new TypeError(`${path}.lifecycle must be an object`);
    for (const field of Object.keys(lifecycle)) if (!["deprecatedAt", "retiredAt", "source"].includes(field)) throw new TypeError(`${path}.lifecycle.${field} is not supported`);
    assertNonEmptyString(lifecycle.source, `${path}.lifecycle.source`);
    let source: URL;
    try { source = new URL(lifecycle.source); } catch { throw new TypeError(`${path}.lifecycle.source must be an HTTP(S) URL`); }
    if (!["https:", "http:"].includes(source.protocol) || source.username || source.password) throw new TypeError(`${path}.lifecycle.source must be an HTTP(S) URL without credentials`);
    for (const field of ["deprecatedAt", "retiredAt"] as const) if (lifecycle[field] !== undefined) assertIsoDate(lifecycle[field], `${path}.lifecycle.${field}`);
    if (lifecycle.deprecatedAt && lifecycle.retiredAt && Date.parse(lifecycle.retiredAt) < Date.parse(lifecycle.deprecatedAt)) throw new TypeError(`${path}.lifecycle retirement cannot precede deprecation`);
  }

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
