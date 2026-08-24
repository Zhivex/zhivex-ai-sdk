# ADR 0001: Explicit, instance-local model resolver

- Status: Accepted for Beta implementation
- Date: 2026-08-23
- Scope: `@zhivex-ai/core` and `@zhivex-ai/sdk/beta`

## Context

Applications migrating from string-based model APIs need the ergonomics of
`provider/model`, but Zhivex already has provider factories, `LanguageModel`,
`ProviderAdapter`, and an immutable `ModelCatalog`. A new global registry or
runtime would duplicate those contracts, hide credential selection, and make
tests order-dependent.

## Decision

Add `createModelResolver()` as a Beta API with these constraints:

- every resolver receives an explicit immutable catalog;
- every resolver receives exactly one source: an adapter map or configured
  backend;
- explicit IDs use `provider/model`, splitting only on the first slash;
- application aliases are simple, non-slash names stored in an array so
  collisions are detectable;
- unknown identities fail with `ModelResolutionError` before a source factory
  is called;
- `resolve()` returns the existing `LanguageModel` plus immutable identity,
  capability, catalog, and pricing metadata;
- `model()` is only a convenience projection for existing runtime APIs;
- factories remain supported and canonical;
- no mutable singleton, credential discovery, endpoint selection, routing, or
  fallback is introduced.

## Consequences

Applications get a low-boilerplate string path while retaining explicit
composition and a one-line rollback to direct factories. Catalog snapshots make
unknown-model behavior deterministic and provide budget metadata. A gateway can
be integrated without becoming a dependency or default.

The first Beta contract is intentionally language-model-only. Other model kinds,
capability requirements, asynchronous backends, and alias namespaces require
separate evidence before expanding the surface.

## Rejected alternatives

- **Process-global registry:** rejected because configuration could leak across
  applications and tests.
- **Environment-driven provider discovery:** rejected because it couples model
  identity to secret presence and makes failures non-deterministic.
- **Resolver-owned network client:** rejected because it would create a second
  runtime and choose a backend implicitly.
- **Reuse `@zhivex-ai/gateway` routing as identity lookup:** rejected because
  resolution and routing/fallback have different responsibilities.
- **Alias object map:** rejected because duplicate keys are overwritten by
  JavaScript before collisions can be reported.

## Verification

The Beta contract requires unit coverage for valid IDs, catalog aliases,
application aliases, collisions, typed preflight errors, adapter/backend modes,
metadata immutability, concurrent registry isolation, direct-factory behavior,
public type snapshots, and an installed-package entrypoint smoke.
