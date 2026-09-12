# @zhivex-ai/deepseek

## 0.5.3

### Patch Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.
- Updated dependencies
  - @zhivex-ai/core@1.16.1

## 0.5.2

### Patch Changes

- Preserve approval policies, tool choice and lifecycle hooks in object generation. Treat provider stream error events as terminal failures before executing buffered tools.

  Expose withResponseRetry in Core and SDK and use it for OpenAI, Anthropic, Gemini and Qwen language generation/stream startup. Honor Retry-After and share timeout signals with retry waits. Cancel DeepSeek backoff on timeout. Preserve exact Uint8Array and Buffer view boundaries when uploading files through Meta and xAI.

## 0.5.1

### Patch Changes

- 744dec7: Add an optional model tool-history capability and an opt-in discriminated JSON tool-result format. OpenAI and Qwen Chat/Responses, and DeepSeek Chat, preserve all tool results and can explicitly serialize success/error envelopes for gateway continuation. Existing direct SDK calls retain raw result serialization. Gateway routing honors adapter-declared support, enables cross-provider fallback without replaying resolved tools, and rejects explicit private-thinking replay for the portable DeepSeek/Qwen subset. Their default portable replay runs without thinking.
- Updated dependencies [744dec7]
  - @zhivex-ai/core@1.12.0

## 0.5.0

### Minor Changes

- 2efba2f: Add first-class support and catalog coverage for Gemini 3.7 Flash, Gemini 3.5 Transcribe and Transcribe Live, Gemini Omni 1.1 Flash, Grok 4.6, and DeepSeek V4 Flash Vision Exp with Files API. Enforce current model-specific reasoning and realtime contracts, and restore the configured Qwen realtime frame-size limit on Bun 1.4.

## 0.4.3

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.4.2

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 0.4.1

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
