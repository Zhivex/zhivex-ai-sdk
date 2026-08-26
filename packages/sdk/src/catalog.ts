import { createModelCatalog } from "@zhivex-ai/core";

import { defaultModelCatalogFragments } from "./catalog/fragments.js";
import { snapshotMetadata, type ModelCatalogProviderSnapshotMetadata } from "./catalog/fragment.js";

export type { ModelCatalogProviderSnapshotMetadata } from "./catalog/fragment.js";

/** Provider-scoped provenance for the release-managed default inventory. */
export const listDefaultModelCatalogFragments = (): ModelCatalogProviderSnapshotMetadata[] =>
  defaultModelCatalogFragments.map(snapshotMetadata);

/**
 * Release-managed model inventory owned by @zhivex-ai/sdk.
 *
 * Provider fragments can evolve independently while consumers retain one
 * immutable catalog view. Update a fragment, its provenance metadata, docs,
 * tests, and changeset together.
 */
export const defaultModelCatalog = createModelCatalog(
  defaultModelCatalogFragments.flatMap((fragment) => fragment.entries),
  {
    snapshotVersion: "2026-08-26",
    publishedAt: "2026-08-26T00:00:00.000Z",
    policy: {
      data: "rolling",
      updates: "package-release"
    },
    pricing: {
      version: "2026-08-26",
      currency: "USD",
      unit: "per_1k_tokens",
      effectiveAt: "2026-08-26",
      source: "zhivex-ai-sdk-default-catalog"
    }
  }
);
