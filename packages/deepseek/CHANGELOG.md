# @zhivex-ai/deepseek

## 0.6.1

### Patch Changes

- Raise the declared `@zhivex-ai/core` floor to 1.37.0. This package loads helpers from this Core release, and the declared minimum must match the workspace Core version.
- Updated dependencies [e3f4af2]
  - @zhivex-ai/core@1.37.0

## 0.6.0

### Minor Changes

- 8e377e4: Accept `provider/model` strings, an OpenAI-compatible provider factory, and optional AI SDK loop controls (`stopWhen`, `prepareStep`, `activeTools`, `Output`, JSON Schema tools, and shared `topP` / `seed` / `stopSequences`) without changing existing call defaults. `stopWhen` without `maxSteps` uses a 20-step safety ceiling instead of one step or an unbounded loop. OpenAI family checks reject shared `topP` on models that already reject `top_p`, and warn-and-omit shared `seed` / `stopSequences` in both API modes. `Output.object` reads the final step. MCP stdio process-exit errors keep their code and message prefix and append a stderr tail that is redacted before it is truncated.

### Patch Changes

- c4ad6d4: Select the streamed chat choice whose index is 0, treating a missing index as 0, instead of always reading the first array entry.
- Updated dependencies [8e377e4]
- Updated dependencies [7a8b754]
- Updated dependencies [f1ed0ce]
  - @zhivex-ai/core@1.36.0

## 0.5.10

### Patch Changes

- 387e15e: Gateway deployments authorize the registered region and endpoint. Credentialed provider fetches reject redirects and still load against published core 1.34.0. Gemini, DeepSeek, and Qwen file uploads reject bodies over 64 MiB before they are read. Qwen measures base64 uploads by decoded bytes. Meta streams cap tool-call state. The A2A server authenticates a JSON-RPC request before reading its body.
- Updated dependencies [e41524d]
- Updated dependencies [1a35b44]
- Updated dependencies [4b20b24]
- Updated dependencies [387e15e]
  - @zhivex-ai/core@1.35.0

## 0.5.9

### Patch Changes

- 1bf939d: Raise the `@zhivex-ai/core` dependency floor to 1.34.0 for DeepSeek, Kimi, Meta, Ollama, OpenRouter, and Z.ai. Their unit tests import Core helpers from this checkout, so the declared floor has to match the workspace Core version.

## 0.5.8

### Patch Changes

- b5833e3: Reject private, loopback, link-local, and metadata hosts in `assertTrustedEndpoint`, including IPv6 and IPv4-mapped forms. Replace the Node-only deep-equal helper so Core can bundle for browser and edge. Share the OpenAI-compatible request and SSE loop across DeepSeek, Kimi, Meta, Z.ai, and Ollama, and raise those packages' Core floor to this release. Gateway and OpenRouter move to the same floor because their unit tests load those adapters.
- Updated dependencies [b5833e3]
- Updated dependencies [56b07bf]
  - @zhivex-ai/core@1.33.0

## 0.5.7

### Patch Changes

- Updated dependencies [be12ce8]
- Updated dependencies [29ae47c]
- Updated dependencies [29ae47c]
- Updated dependencies [9e5715a]
- Updated dependencies [29ae47c]
  - @zhivex-ai/core@1.24.0

## 0.5.7-next.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.24.0-next.0

## 0.5.6

### Patch Changes

- Updated dependencies [f35fafe]
- Updated dependencies [4f51d78]
- Updated dependencies [e705a21]
  - @zhivex-ai/core@1.23.0

## 0.5.6-next.0

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0

## 0.5.5

### Patch Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.
  
  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.
  
  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0

## 0.5.4

### Patch Changes

- Align September provider releases: enable DeepSeek V4.1 Flash vision and legacy aliases, remove stale fixed DeepSeek prices, add Gemini 3.8 Live catalog entries and background-thinking protocol handling, preserve signed Anthropic compaction and billed iterations, and expose native Beta managed-agent resources for OpenAI and Anthropic. Keep managed provider state separate from the local agent runtime and document certification boundaries. Accept empty HTTP 202 acknowledgements for native OpenAI agent events and allow Anthropic compaction of completed assistant turns.
- Updated dependencies
  - @zhivex-ai/core@1.18.0

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
