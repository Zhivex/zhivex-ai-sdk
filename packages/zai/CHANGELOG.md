# @zhivex-ai/zai

## 0.2.0

### Minor Changes

- Add first-class GLM-5.3 Flash support with required-thinking validation, `low`/`high`/`max` reasoning efforts, ordered multi-image input, general API and Coding Plan documentation, provider smoke coverage, and current catalog metadata with list pricing.

## 0.1.1

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.1.0

### Minor Changes

- Add native Z.ai support for GLM-5.3 and GLM-5.2 with model-aware thinking controls, streamed and non-streamed reasoning preservation, function-tool loops, JSON-object structured output, Retry-After-aware backoff, catalog and Gateway registration, CLI scaffolding, and opt-in live smoke coverage.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.3.0
