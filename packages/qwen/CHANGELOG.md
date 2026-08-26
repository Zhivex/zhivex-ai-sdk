# @zhivex-ai/qwen

## 0.11.0

### Minor Changes

- Add first-class Qwen 3.8 Flash support with hybrid reasoning, multimodal image and video input, native JSON Schema output, production endpoint validation, catalog pricing, and model-aware authenticated tool-loop certification. Normalize missing, whitespace-only, and numeric placeholder tool-call IDs before deduplication across Chat, Responses, streaming, and realtime flows while continuing to reject duplicate stable provider IDs, and preserve the original Responses correlation ID across `previous_response_id` tool-loop continuations.

## 0.10.3

### Patch Changes

- ca6dfe6: Generate non-empty, conversation-durable fallback IDs when Qwen omits tool-call IDs across Chat, Responses, and realtime streams. Preserve later valid IDs, and reject duplicate provider IDs before they enter tool execution or durable agent state.

## 0.10.2

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.10.1

### Patch Changes

- fc64a26: Promote the shared realtime and live-agent contract to Stable. Harden session
  lifecycle, browser transport and frame encoding, tool-call deduplication,
  post-tool continuation, cancellation, durable idempotency, memory context, and
  fail-closed approvals. Correct provider capability claims and Google/Qwen Live
  protocol handling, and add deterministic installed-package plus live
  Gemini/Qwen/OpenAI certification gates.
- Updated dependencies [fc64a26]
  - @zhivex-ai/core@1.4.0

## 0.10.0

### Minor Changes

- 0b8ecd5: Add first-class support for the production `qwen3.8-max` contract, including standard Model Studio endpoints, hybrid reasoning, multimodal input, tools, structured output, catalog metadata, documentation, examples, and regression coverage while preserving the separate Token Plan preview behavior.

### Patch Changes

- Updated dependencies [0b8ecd5]
  - @zhivex-ai/core@1.1.1

## 0.9.2

### Patch Changes

- Fix bodyless HTTP tool responses in Node, honor Qwen realtime frame limits, and refresh GPT-5.6 Terra and Luna pricing.
- Updated dependencies
  - @zhivex-ai/core@1.0.3

## 0.9.1

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 0.9.0

### Minor Changes

- Add production-ready support for Gemini 3.6 Flash, Gemini 3.5 Flash-Lite, and the Token Plan-only Qwen 3.8 Max Preview, including model-specific request validation, catalog metadata, documentation, examples, and regression coverage.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.0.1

## 0.8.3

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
