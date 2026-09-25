# @zhivex-ai/openai

## 0.13.6-next.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.24.0-next.0

## 0.13.5

### Patch Changes

- e3f1444: Preserve Responses function results named apply_patch, shell, or computer. Select native output protocols from explicit call/result metadata rather than tool names, reject conflicting metadata, and retain receipt payloads across persisted and stateless continuations.
  
  Remove the obsolete Vertex Responses tool-name workaround so canonical call/result names remain consistent.
- Updated dependencies [f35fafe]
- Updated dependencies [4f51d78]
- Updated dependencies [e705a21]
  - @zhivex-ai/core@1.23.0

## 0.13.5-next.1

### Patch Changes

- Preserve Responses function results named apply_patch, shell, or computer. Select native output protocols from explicit call/result metadata rather than tool names, reject conflicting metadata, and retain receipt payloads across persisted and stateless continuations.
  
  Remove the obsolete Vertex Responses tool-name workaround so canonical call/result names remain consistent.

## 0.13.5-next.0

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0

## 0.13.4

### Patch Changes

- Support GPT-6 Sol and Luna with automatic Responses routing, current capabilities, and Chat Completions/sampling validation. Support Claude Opus 5.5 always-on thinking, automatic tool selection, thinking display and binding controls, and the computer toolset migration. Add all three models and their direct-provider pricing to the SDK catalog.

## 0.13.3

### Patch Changes

- 62539ac: Preserve validated terminal usage on rejected Responses tool calls without emitting unsafe calls.
- Updated dependencies [62539ac]
  - @zhivex-ai/core@1.22.0

## 0.13.2

### Patch Changes

- Normalize inline base64 image inputs with their MIME type for Qwen, OpenAI, xAI, Azure OpenAI, Meta, and OpenRouter across Chat/Responses generation and streaming. Preserve HTTP(S) and existing base64 image data URLs without mutating history. Use native base64 source blocks for Anthropic. Share the adapter serializer through Core's provider entrypoint, with explicit validation and a required MIME type for bare base64.
  
  Observe streamText's internal final-result rejection for consumers that only iterate eventStream or textStream, while preserving the error event and collect() rejection. Add isolated Node regressions for HTTP, network, mid-stream, cancellation, and provider error events.
- Updated dependencies
  - @zhivex-ai/core@1.20.0

## 0.13.1

### Patch Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.
  
  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.
  
  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0

## 0.13.0

### Minor Changes

- Align September provider releases: enable DeepSeek V4.1 Flash vision and legacy aliases, remove stale fixed DeepSeek prices, add Gemini 3.8 Live catalog entries and background-thinking protocol handling, preserve signed Anthropic compaction and billed iterations, and expose native Beta managed-agent resources for OpenAI and Anthropic. Keep managed provider state separate from the local agent runtime and document certification boundaries. Accept empty HTTP 202 acknowledgements for native OpenAI agent events and allow Anthropic compaction of completed assistant turns.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.18.0

## 0.12.1

### Patch Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.
- Updated dependencies
  - @zhivex-ai/core@1.16.1

## 0.12.0

### Minor Changes

- 0679e5c: Add GPT-Live-1 server WebSocket sessions with continuous audio, timestamped transcripts, client delegation, context appends, input muting and acknowledged close with final usage. Add the provider-neutral runRealtimeDelegations bridge for application-owned agents, with bounded context, serialized backend tasks, duplicate detection and cancellation. Keep full-duplex sessions separate from the turn-based streamLiveAgent lifecycle. Add the model to the SDK catalog without inventing token pricing for duration-billed voice. Responses-managed delegation, browser WebRTC and SIP are not implemented by this adapter.

### Patch Changes

- Updated dependencies [0679e5c]
  - @zhivex-ai/core@1.16.0

## 0.11.2

### Patch Changes

- Fix persisted agent compaction counting model usage twice and use current response usage for per-step budget preflight, with or without a run store. Preserve correlated tool-call, approval, and result groups across compaction boundaries, including parallel calls. Serialize synthetic assistant text as output_text in OpenAI Responses while retaining its role and native output metadata.
- Preserve approval policies, tool choice and lifecycle hooks in object generation. Treat provider stream error events as terminal failures before executing buffered tools.

  Expose withResponseRetry in Core and SDK and use it for OpenAI, Anthropic, Gemini and Qwen language generation/stream startup. Honor Retry-After and share timeout signals with retry waits. Cancel DeepSeek backoff on timeout. Preserve exact Uint8Array and Buffer view boundaries when uploading files through Meta and xAI.

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.13.0

## 0.11.1

### Patch Changes

- 744dec7: Add an optional model tool-history capability and an opt-in discriminated JSON tool-result format. OpenAI and Qwen Chat/Responses, and DeepSeek Chat, preserve all tool results and can explicitly serialize success/error envelopes for gateway continuation. Existing direct SDK calls retain raw result serialization. Gateway routing honors adapter-declared support, enables cross-provider fallback without replaying resolved tools, and rejects explicit private-thinking replay for the portable DeepSeek/Qwen subset. Their default portable replay runs without thinking.
- Updated dependencies [744dec7]
  - @zhivex-ai/core@1.12.0

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
