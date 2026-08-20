# Stable Model Catalog Contract

`createModelCatalog()` and `defaultModelCatalog` provide a Stable lookup contract for model identity, aliases, recommendations, and optional token pricing. Stability applies to the catalog schema and lookup behavior. It does not mean that an upstream model list or price is permanent. The neutral contract and factory live in `@zhivex-ai/core`; the release-managed default inventory is owned by `@zhivex-ai/sdk` and is also available from `@zhivex-ai/sdk/catalog`.

## Immutable Snapshots

Every catalog captures an immutable snapshot when it is created. Mutating the input array, an input entry, a value returned by `find()`, a value returned by `list()`, or returned metadata does not change that snapshot.

Catalog creation fails closed for:

- empty or malformed provider/model identifiers;
- duplicate canonical IDs, aliases, or canonical/alias collisions within one provider;
- unknown entry fields or unsupported recommendation values;
- negative, infinite, or non-numeric pricing;
- invalid long-context thresholds or multipliers; and
- inconsistent snapshot, update-policy, or pricing metadata.

Aliases are provider-scoped. The same identifier may exist under different providers, but it cannot resolve to multiple entries for one provider.

## Snapshot and Pricing Metadata

```ts
import { createModelCatalog } from "@zhivex-ai/sdk";

const catalog = createModelCatalog(entries, {
  snapshotVersion: "my-models-1",
  publishedAt: "2026-08-16T00:00:00.000Z",
  policy: { data: "pinned", updates: "never" },
  pricing: {
    version: "my-prices-1",
    currency: "USD",
    unit: "per_1k_tokens",
    effectiveAt: "2026-08-16",
    source: "application-rate-card"
  }
});
```

Custom catalogs default to pinned data. A rolling catalog must state whether it changes only when the catalog is replaced or when a new package is released.

The built-in `defaultModelCatalog` is an immutable rolling snapshot. Its entries, aliases, recommendations, and prices may be updated only in a package release, together with a new snapshot/pricing version and changelog entry. A mutable upstream alias is not remapped without explicit upstream evidence. Retired entries may be removed when the upstream provider removes them; reproducible routing and cost evaluation should use a recorded package version and the catalog metadata stored with the run.

`@zhivex-ai/core` temporarily retains a deprecated compatibility export of its
previous default snapshot. New applications should import the SDK-owned default
or inject a custom catalog; the compatibility export is planned for removal in
the next major version. The two packages contain separate physical snapshots:
they are identical at the migration boundary, but the core copy is frozen.
Future inventory and pricing updates must change only
`packages/sdk/src/catalog.ts`, together with its snapshot metadata, tests,
documentation, and release changeset. Consumers that keep importing the core
compatibility export will therefore not receive later catalog revisions.

Pricing metadata establishes currency, unit, and snapshot scope. Catalog prices are routing and cost-estimation inputs tied to that package snapshot, not an authoritative billing source; verify current upstream pricing before billing users. Entries without a snapshot estimate omit cost fields. Region-specific, batch, priority, provisioned-throughput, tool, storage, and other provider-specific charges are not implied unless the catalog metadata explicitly includes them.

## Capability Boundary

The catalog is metadata, not authenticated capability evidence. `recommendedFor` helps with routing heuristics, but provider capabilities, account entitlements, regional availability, preview access, and live behavior still require the provider adapter's validations and integration certification.
