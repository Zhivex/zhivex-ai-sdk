import type { ModelCatalogEntry } from "@zhivex-ai/core";

export interface ModelCatalogProviderSnapshotMetadata {
  provider: string;
  revision: string;
  verifiedAt: string;
  pricingEffectiveAt?: string;
  sources: readonly string[];
  modelCount: number;
}

export interface ModelCatalogFragmentDefinition
  extends Omit<ModelCatalogProviderSnapshotMetadata, "modelCount"> {
  entries: readonly ModelCatalogEntry[];
}

const assertValue = (value: string, path: string): void => {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${path} must be a non-empty string without surrounding whitespace or control characters`);
  }
};

const assertDate = (value: string, path: string): void => {
  assertValue(value, path);
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${path} must be an ISO 8601 date or timestamp`);
  }
};

export const defineModelCatalogFragment = (
  fragment: ModelCatalogFragmentDefinition
): Readonly<ModelCatalogFragmentDefinition> => {
  assertValue(fragment.provider, "fragment.provider");
  assertValue(fragment.revision, "fragment.revision");
  assertDate(fragment.verifiedAt, "fragment.verifiedAt");
  if (fragment.pricingEffectiveAt !== undefined) {
    assertDate(fragment.pricingEffectiveAt, "fragment.pricingEffectiveAt");
  }
  if (!Array.isArray(fragment.sources) || fragment.sources.length === 0) {
    throw new TypeError("fragment.sources must contain at least one provenance source");
  }
  const sources = fragment.sources.map((source, index) => {
    assertValue(source, `fragment.sources[${index}]`);
    return source;
  });
  if (new Set(sources).size !== sources.length) {
    throw new TypeError("fragment.sources must not contain duplicates");
  }
  if (!Array.isArray(fragment.entries) || fragment.entries.length === 0) {
    throw new TypeError("fragment.entries must contain at least one model");
  }
  const entries = fragment.entries.map((entry, index) => {
    if (entry.provider !== fragment.provider) {
      throw new TypeError(
        `fragment.entries[${index}].provider must be ${JSON.stringify(fragment.provider)}`
      );
    }
    return Object.freeze({
      ...entry,
      ...(entry.aliases ? { aliases: Object.freeze([...entry.aliases]) } : {}),
      ...(entry.longContextPricing
        ? { longContextPricing: Object.freeze({ ...entry.longContextPricing }) }
        : {}),
      ...(entry.recommendedFor
        ? { recommendedFor: Object.freeze([...entry.recommendedFor]) }
        : {})
    });
  });
  return Object.freeze({
    provider: fragment.provider,
    revision: fragment.revision,
    verifiedAt: fragment.verifiedAt,
    pricingEffectiveAt: fragment.pricingEffectiveAt,
    sources: Object.freeze(sources),
    entries: Object.freeze(entries)
  });
};

export const snapshotMetadata = (
  fragment: Readonly<ModelCatalogFragmentDefinition>
): ModelCatalogProviderSnapshotMetadata => Object.freeze({
  provider: fragment.provider,
  revision: fragment.revision,
  verifiedAt: fragment.verifiedAt,
  pricingEffectiveAt: fragment.pricingEffectiveAt,
  sources: Object.freeze([...fragment.sources]),
  modelCount: fragment.entries.length
});
