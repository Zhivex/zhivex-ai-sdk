# @zhivex-ai/xai

## 0.2.8-next.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.24.0-next.0
  - @zhivex-ai/openai@0.13.6-next.0

## 0.2.7

### Patch Changes

- Updated dependencies [f35fafe]
- Updated dependencies [4f51d78]
- Updated dependencies [e705a21]
- Updated dependencies [e3f1444]
  - @zhivex-ai/core@1.23.0
  - @zhivex-ai/openai@0.13.5

## 0.2.7-next.0

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0
  - @zhivex-ai/openai@0.13.5-next.0

## 0.2.6

### Patch Changes

- Normalize inline base64 image inputs with their MIME type for Qwen, OpenAI, xAI, Azure OpenAI, Meta, and OpenRouter across Chat/Responses generation and streaming. Preserve HTTP(S) and existing base64 image data URLs without mutating history. Use native base64 source blocks for Anthropic. Share the adapter serializer through Core's provider entrypoint, with explicit validation and a required MIME type for bare base64.
  
  Observe streamText's internal final-result rejection for consumers that only iterate eventStream or textStream, while preserving the error event and collect() rejection. Add isolated Node regressions for HTTP, network, mid-stream, cancellation, and provider error events.
- Updated dependencies
  - @zhivex-ai/core@1.20.0
  - @zhivex-ai/openai@0.13.2

## 0.2.5

### Patch Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.
  
  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.
  
  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0
  - @zhivex-ai/openai@0.13.1

## 0.2.4

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.18.0
  - @zhivex-ai/openai@0.13.0

## 0.2.3

### Patch Changes

- Updated dependencies [0679e5c]
  - @zhivex-ai/core@1.16.0
  - @zhivex-ai/openai@0.12.0

## 0.2.2

### Patch Changes

- Preserve approval policies, tool choice and lifecycle hooks in object generation. Treat provider stream error events as terminal failures before executing buffered tools.

  Expose withResponseRetry in Core and SDK and use it for OpenAI, Anthropic, Gemini and Qwen language generation/stream startup. Honor Retry-After and share timeout signals with retry waits. Cancel DeepSeek backoff on timeout. Preserve exact Uint8Array and Buffer view boundaries when uploading files through Meta and xAI.

- Updated dependencies
  - @zhivex-ai/openai@0.11.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @zhivex-ai/openai@0.11.0

## 0.2.0

### Minor Changes

- 2efba2f: Add first-class support and catalog coverage for Gemini 3.7 Flash, Gemini 3.5 Transcribe and Transcribe Live, Gemini Omni 1.1 Flash, Grok 4.6, and DeepSeek V4 Flash Vision Exp with Files API. Enforce current model-specific reasoning and realtime contracts, and restore the configured Qwen realtime frame-size limit on Bun 1.4.

## 0.1.7

### Patch Changes

- Updated dependencies [8faf5c9]
  - @zhivex-ai/core@1.10.0
  - @zhivex-ai/openai@0.10.0

## 0.1.6

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0
  - @zhivex-ai/openai@0.9.6

## 0.1.5

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2
  - @zhivex-ai/openai@0.9.4

## 0.1.4

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
  - @zhivex-ai/openai@0.9.3
