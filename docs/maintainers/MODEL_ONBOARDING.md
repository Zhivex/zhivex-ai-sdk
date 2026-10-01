# Model and provider maintenance

Provider adapters own API behavior and model profiles. Core owns portable contracts;
SDK owns the catalog. Adapters must not import the SDK catalog or maintenance
registry. A catalog entry documents a route's availability, pricing and lifecycle;
it does not prove that every operation is implemented or live certified.

## Adding a model

Choose the smallest applicable path:

1. **Existing protocol and behavior:** add the model ID/alias to the provider's
   existing profile when necessary, update its SDK catalog fragment and add a
   regression fixture for capability resolution. No transport change is needed.
2. **Existing protocol with different restrictions:** add a provider profile for
   capabilities, supported reasoning/sampling options and protocol selection.
   Add fixtures for allowed and rejected options and a mocked request/stream test.
3. **New protocol or portable capability:** extend Core's contract if the behavior
   is shared, implement the adapter mapping and add contract, error and streaming
   tests. Review SDK exports when adding a public Core API.

Use primary provider documentation for model identifiers and restrictions. Keep
model authorship separate from API host/provider identity. Update lifecycle,
pricing and source dates in `packages/sdk/src/catalog/providers/<provider>.ts`.
Include aliases for supported alternate names. Unknown models should use the
provider's explicit capability policy; do not grant capabilities merely because
an ID can be submitted to an API. Mocked tests do not establish live support.

When changing a CLI default, update `defaultModel` in
`scripts/provider-registry.ts`, then run `bun run provider:sync`. The coherence
check accepts canonical catalog IDs and aliases for scaffold defaults.

## Adding a provider

Add one entry to `scripts/provider-registry.ts`. It is the maintenance authority
for package name, factory export, catalog export, scaffold credential name and
scaffold default. `scaffoldOrder: null` excludes providers needing an auth or
configuration implementation in the CLI; null defaults do not imply a model
recommendation. Preserve the existing scaffold order unless intentionally changing
CLI presentation. Credential discovery and special factory options remain in
provider adapters and CLI logic.

Create the package with complete npm metadata, factory exports, adapter tests and
its SDK catalog fragment. Add the root TypeScript project reference and Gateway's
provider union/runtime set. Run:

```bash
bun run provider:sync
bun run provider:check
bun run docs:check
bun run typecheck
bun run test
bun run build
```

The registry generator writes CLI provider metadata and the catalog fragment
inventory. `provider:check` verifies generated files, manifests, factory exports,
TypeScript references, catalog identities/defaults and Gateway inventories. CI
runs this check without writing files. Add tests for the provider's API behavior;
registry coherence checks cannot replace them.

Package versions are read from manifests rather than maintained in CLI literals.
`bun run version-packages` runs the registry generator after Changesets and starter
version synchronization. Commit the regenerated files with the version change.
Generated metadata ships inside SDK, without a runtime dependency on scripts or
provider packages.

Add a changeset for observable package behavior, public types/exports or npm-facing
metadata. Follow [the release guide](./RELEASE.md) for protected workflow publishing
and installed-artifact verification. Use [provider conformance and smoke](./PROVIDER_SMOKE.md)
for the separate live-evidence gate.
