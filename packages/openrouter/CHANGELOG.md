# @zhivex-ai/openrouter

## 0.5.21

### Patch Changes

- Updated dependencies [f35fafe]
- Updated dependencies [4f51d78]
- Updated dependencies [e705a21]
  - @zhivex-ai/core@1.23.0

## 0.5.21-next.0

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0

## 0.5.20

### Patch Changes

- Normalize inline base64 image inputs with their MIME type for Qwen, OpenAI, xAI, Azure OpenAI, Meta, and OpenRouter across Chat/Responses generation and streaming. Preserve HTTP(S) and existing base64 image data URLs without mutating history. Use native base64 source blocks for Anthropic. Share the adapter serializer through Core's provider entrypoint, with explicit validation and a required MIME type for bare base64.
  
  Observe streamText's internal final-result rejection for consumers that only iterate eventStream or textStream, while preserving the error event and collect() rejection. Add isolated Node regressions for HTTP, network, mid-stream, cancellation, and provider error events.
- Updated dependencies
  - @zhivex-ai/core@1.20.0

## 0.5.19

### Patch Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.
  
  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.
  
  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0

## 0.5.18

### Patch Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.
- Updated dependencies
  - @zhivex-ai/core@1.16.1

## 0.5.17

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.5.16

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 0.5.15

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
