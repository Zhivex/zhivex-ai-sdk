# @zhivex-ai/ollama

## 0.5.1

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.5.0

### Minor Changes

- Add first-class Muse Spark 1.2 support, align tool choice with the authenticated Meta contract, repair retry and Responses streaming behavior in the direct Meta Model API adapter, and add current Muse Glimmer 30B routes for Ollama and OpenRouter with catalog, documentation, and regression coverage.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.3.0

## 0.4.0

### Minor Changes

- Bring the Ollama adapter up to date with the native REST contract: use object-shaped tool arguments and correlated tool results, surface mid-stream NDJSON errors, preserve thinking through streamed and non-streamed tool loops, expose shared reasoning controls, and add first-class authenticated Ollama Cloud access. Refresh the default Ollama catalog with current Gemma 4, Qwen 3.5, Qwen 3, GPT-OSS, and EmbeddingGemma entries.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.2.0

## 0.3.15

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 0.3.14

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
