# @zhivex-ai/openai

## 0.11.0

### Minor Changes

- Refresh the release-managed model catalog for September 2026, including Astra, Claude 5.1, Gemini 3.8, Muse Spark 1.3, Lyria 3.5, and Qwen. Preserve the frozen core compatibility snapshot and historical retired Kimi entries while removing retired-model recommendations.

  Route OpenAI/Azure Astra through Responses by default and validate its request controls. Add explicit Azure Responses mode for opaque deployment names and normalize Responses reasoning and named tool choice. Validate Gemini 3.8 sampling/prefill/reasoning, recognize Qwen Max/Flash snapshots and Ollama Qwen 3.8, and reject forced tool choices for Claude 5.1. Add typed Claude progress-display and thinking-binding controls with automatic beta headers.

  Catalog additions and offline regression coverage do not imply authenticated model availability or complete parity with every new upstream protocol.

## 0.10.0

### Minor Changes

- 8faf5c9: Add sanitized provider tool-call diagnostics, durable Agent error metadata, and fail-closed OpenAI Responses tool-call assembly that waits for terminal completion before local policy or execution.

### Patch Changes

- Updated dependencies [8faf5c9]
  - @zhivex-ai/core@1.10.0

## 0.9.6

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.9.5

### Patch Changes

- Assemble fragmented Chat Completions tool calls by stream index, preserve their provider call IDs, and emit one terminal event with late usage metadata.

## 0.9.4

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 0.9.3

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
