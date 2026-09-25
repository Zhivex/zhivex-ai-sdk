# @zhivex-ai/qwen

## 0.15.3-next.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.24.0-next.0

## 0.15.2

### Patch Changes

- Update the Token Plan endpoint to the current QwenCloud domain while retaining explicit legacy Singapore endpoint compatibility. Allow qwen3.8-max and qwen3.8-flash on Token Plan in generation and streaming, preserve preview endpoint validation, and update examples to recommend the final Max model instead of the retired preview. Plan availability remains provider-controlled and separate from offline contract coverage.

## 0.15.1

### Patch Changes

- Updated dependencies [f35fafe]
- Updated dependencies [4f51d78]
- Updated dependencies [e705a21]
  - @zhivex-ai/core@1.23.0

## 0.15.1-next.0

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0

## 0.15.0

### Minor Changes

- Add a model-specific Qwen 3.8 LiveTranslate realtime contract with automatic translation, language and audio validation, glossary and explicit cloning-option forwarding, source transcript deltas, preserved provider events, acknowledged setup and graceful close. Add the model to the SDK-owned catalog. Cloning availability and voice enrollment remain subject to the documented upstream limitations.
  
  Expose native Qwen voice enrollment, listing and deletion with explicit target selection, bounded responses and no automatic mutation retries. Add a reproducible audio comparison and optional create/use/delete audit; the exact LiveTranslate 3.8 enrollment target and create/use/delete lifecycle are verified live in Singapore.

## 0.14.4

### Patch Changes

- 35e2bb4: Preserve complete Chat tool calls when named tool selection ends with `stop`. Validate the entire buffered batch before emission, reject incomplete or invalid calls and late explicit provider errors, and retain reported usage on typed failures. Require Core 1.22.0 for failure usage accounting.

## 0.14.3

### Patch Changes

- Share the authenticated Node/Bun WebSocket transport through core. Vertex Live now connects with OAuth headers without a custom factory; Qwen reuses the same implementation. Keep browser transport selection separate, disable redirects, and handle handshake cancellation/timeout errors without unhandled socket events.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.21.0

## 0.14.2

### Patch Changes

- Reject failed Qwen Responses payloads and SSE error/response.failed events with the bounded QWEN_RESPONSE_FAILED diagnostic instead of resolving collect() with an empty error finish. Preserve error events and collect() rejection without exposing provider payloads. Verified with a real invalid-image response delivered over HTTP 200.

## 0.14.1

### Patch Changes

- Normalize inline base64 image inputs with their MIME type for Qwen, OpenAI, xAI, Azure OpenAI, Meta, and OpenRouter across Chat/Responses generation and streaming. Preserve HTTP(S) and existing base64 image data URLs without mutating history. Use native base64 source blocks for Anthropic. Share the adapter serializer through Core's provider entrypoint, with explicit validation and a required MIME type for bare base64.
  
  Observe streamText's internal final-result rejection for consumers that only iterate eventStream or textStream, while preserving the error event and collect() rejection. Add isolated Node regressions for HTTP, network, mid-stream, cancellation, and provider error events.
- Updated dependencies
  - @zhivex-ai/core@1.20.0

## 0.14.0

### Minor Changes

- Add explicit QwenCloud profiles for DeepSeek V4/V4.1, GLM 5.2/5.3, Kimi K3,
  and MiniMax M2.5, with model-specific reasoning, protocol routing, vision,
  JSON output, hosted-tool validation, and preserved reasoning in tool loops.
  Expand the SDK catalog with the exact hosted model IDs without assuming
  upstream vendor pricing or region availability.

## 0.13.0

### Minor Changes

- Add model-aware React media inputs and video rendering, bounded agent execution summaries and hierarchy, and an optional browser realtime voice hook with PCM audio and a server-owned WebSocket relay. Expose optional realtime interruption and implement Qwen response cancellation. Keep provider credentials and tool execution on the server.
  
  Fix resumed tool approvals so the original tool card completes and the final response remains an assistant message. Include a runnable Qwen Omni/voice example and browser regression coverage for uploads, approvals, replay, microphone capture and interruption.
  
  Refresh chat spacing, composer focus, responsive prompt cards and agent status badges while preserving theme tokens. Modernize the example's voice controls with explicit microphone state, surfaced action errors and a keyboard alternative. Request PCM output in the voice example and avoid idle provider cancellation when only local playback needs clearing.

### Patch Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.
  
  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.
  
  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0

## 0.12.0

### Minor Changes

- Support Qwen3.8-Omni-Flash HTTP with multimodal Chat and Responses inputs, hybrid reasoning, text-only output guardrails, and model-specific hosted-tool validation. Add the model and published pricing to the SDK catalog.

## 0.11.5

### Patch Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.
- Updated dependencies
  - @zhivex-ai/core@1.16.1

## 0.11.4

### Patch Changes

- Preserve approval policies, tool choice and lifecycle hooks in object generation. Treat provider stream error events as terminal failures before executing buffered tools.

  Expose withResponseRetry in Core and SDK and use it for OpenAI, Anthropic, Gemini and Qwen language generation/stream startup. Honor Retry-After and share timeout signals with retry waits. Cancel DeepSeek backoff on timeout. Preserve exact Uint8Array and Buffer view boundaries when uploading files through Meta and xAI.

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.13.0

## 0.11.3

### Patch Changes

- 744dec7: Add an optional model tool-history capability and an opt-in discriminated JSON tool-result format. OpenAI and Qwen Chat/Responses, and DeepSeek Chat, preserve all tool results and can explicitly serialize success/error envelopes for gateway continuation. Existing direct SDK calls retain raw result serialization. Gateway routing honors adapter-declared support, enables cross-provider fallback without replaying resolved tools, and rejects explicit private-thinking replay for the portable DeepSeek/Qwen subset. Their default portable replay runs without thinking.
- 744dec7: Preserve Chat Completions token usage delivered in a terminal usage-only SSE chunk, including Qwen 3.8 Max and Flash. Emit the final finish event after consuming usage instead of dropping it after finish_reason.
- Updated dependencies [744dec7]
  - @zhivex-ai/core@1.12.0

## 0.11.2

### Patch Changes

- Refresh the release-managed model catalog for September 2026, including Astra, Claude 5.1, Gemini 3.8, Muse Spark 1.3, Lyria 3.5, and Qwen. Preserve the frozen core compatibility snapshot and historical retired Kimi entries while removing retired-model recommendations.

  Route OpenAI/Azure Astra through Responses by default and validate its request controls. Add explicit Azure Responses mode for opaque deployment names and normalize Responses reasoning and named tool choice. Validate Gemini 3.8 sampling/prefill/reasoning, recognize Qwen Max/Flash snapshots and Ollama Qwen 3.8, and reject forced tool choices for Claude 5.1. Add typed Claude progress-display and thinking-binding controls with automatic beta headers.

  Catalog additions and offline regression coverage do not imply authenticated model availability or complete parity with every new upstream protocol.

## 0.11.1

### Patch Changes

- 2efba2f: Add first-class support and catalog coverage for Gemini 3.7 Flash, Gemini 3.5 Transcribe and Transcribe Live, Gemini Omni 1.1 Flash, Grok 4.6, and DeepSeek V4 Flash Vision Exp with Files API. Enforce current model-specific reasoning and realtime contracts, and restore the configured Qwen realtime frame-size limit on Bun 1.4.

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
