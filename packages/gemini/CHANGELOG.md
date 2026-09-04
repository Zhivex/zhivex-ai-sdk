# @zhivex-ai/gemini

## 0.11.1

### Patch Changes

- Refresh the release-managed model catalog for September 2026, including Astra, Claude 5.1, Gemini 3.8, Muse Spark 1.3, Lyria 3.5, and Qwen. Preserve the frozen core compatibility snapshot and historical retired Kimi entries while removing retired-model recommendations.

  Route OpenAI/Azure Astra through Responses by default and validate its request controls. Add explicit Azure Responses mode for opaque deployment names and normalize Responses reasoning and named tool choice. Validate Gemini 3.8 sampling/prefill/reasoning, recognize Qwen Max/Flash snapshots and Ollama Qwen 3.8, and reject forced tool choices for Claude 5.1. Add typed Claude progress-display and thinking-binding controls with automatic beta headers.

  Catalog additions and offline regression coverage do not imply authenticated model availability or complete parity with every new upstream protocol.

## 0.11.0

### Minor Changes

- 2efba2f: Add first-class support and catalog coverage for Gemini 3.7 Flash, Gemini 3.5 Transcribe and Transcribe Live, Gemini Omni 1.1 Flash, Grok 4.6, and DeepSeek V4 Flash Vision Exp with Files API. Enforce current model-specific reasoning and realtime contracts, and restore the configured Qwen realtime frame-size limit on Bun 1.4.

## 0.10.5

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.10.4

### Patch Changes

- fc64a26: Promote the shared realtime and live-agent contract to Stable. Harden session
  lifecycle, browser transport and frame encoding, tool-call deduplication,
  post-tool continuation, cancellation, durable idempotency, memory context, and
  fail-closed approvals. Correct provider capability claims and Google/Qwen Live
  protocol handling, and add deterministic installed-package plus live
  Gemini/Qwen/OpenAI certification gates.
- Updated dependencies [fc64a26]
  - @zhivex-ai/core@1.4.0

## 0.10.3

### Patch Changes

- Harden durable subagent recovery, file-store revision CAS, supervised approvals, ledger redaction, artifact integrity, authenticated redirects, provider diagnostics, remote-media policies, Formula tool names, local CLI exports, and release artifact trust boundaries.
- Updated dependencies [888bf99]
- Updated dependencies
  - @zhivex-ai/core@1.1.2

## 0.10.2

### Patch Changes

- 4188b59: Map Gemini GenerateContent usage metadata into the shared token usage contract for generated and streamed responses.
- Updated dependencies [4188b59]
- Updated dependencies [4188b59]
  - @zhivex-ai/core@1.1.0

## 0.10.1

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 0.10.0

### Minor Changes

- Add production-ready support for Gemini 3.6 Flash, Gemini 3.5 Flash-Lite, and the Token Plan-only Qwen 3.8 Max Preview, including model-specific request validation, catalog metadata, documentation, examples, and regression coverage.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.0.1

## 0.9.3

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
