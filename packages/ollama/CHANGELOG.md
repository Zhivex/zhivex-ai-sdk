# @zhivex-ai/ollama

## 0.6.0

### Minor Changes

- 8e377e4: Accept `provider/model` strings, an OpenAI-compatible provider factory, and optional AI SDK loop controls (`stopWhen`, `prepareStep`, `activeTools`, `Output`, JSON Schema tools, and shared `topP` / `seed` / `stopSequences`) without changing existing call defaults. `stopWhen` without `maxSteps` uses a 20-step safety ceiling instead of one step or an unbounded loop. OpenAI family checks reject shared `topP` on models that already reject `top_p`, and warn-and-omit shared `seed` / `stopSequences` in both API modes. `Output.object` reads the final step. MCP stdio process-exit errors keep their code and message prefix and append a stderr tail that is redacted before it is truncated.

### Patch Changes

- Updated dependencies [8e377e4]
- Updated dependencies [7a8b754]
- Updated dependencies [f1ed0ce]
  - @zhivex-ai/core@1.36.0

## 0.5.10

### Patch Changes

- f0a6002: Recognize Muse Spark Open as a thinking model. Map shared reasoning to `low`, `medium`, `high`, and `xhigh`, and reject `none` and `max`.
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

- 10bd4ee: Retry transient HTTP failures before language-model response consumption, honor deadlines during retry backoff, and release stream-opening resources on rejection. Preserve fragmented OpenRouter tool calls and final OpenRouter/Kimi token usage. Surface Bedrock Responses failures and truncation, and release streamed function calls only after successful completion.
- Updated dependencies [70c4fee]
- Updated dependencies [10bd4ee]
- Updated dependencies [10bd4ee]
  - @zhivex-ai/core@1.30.1

## 0.5.6

### Patch Changes

- Updated dependencies [be12ce8]
- Updated dependencies [29ae47c]
- Updated dependencies [29ae47c]
- Updated dependencies [9e5715a]
- Updated dependencies [29ae47c]
  - @zhivex-ai/core@1.24.0

## 0.5.6-next.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.24.0-next.0

## 0.5.5

### Patch Changes

- Updated dependencies [f35fafe]
- Updated dependencies [4f51d78]
- Updated dependencies [e705a21]
  - @zhivex-ai/core@1.23.0

## 0.5.5-next.0

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0

## 0.5.4

### Patch Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.
  
  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.
  
  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0

## 0.5.3

### Patch Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.
- Updated dependencies
  - @zhivex-ai/core@1.16.1

## 0.5.2

### Patch Changes

- Refresh the release-managed model catalog for September 2026, including Astra, Claude 5.1, Gemini 3.8, Muse Spark 1.3, Lyria 3.5, and Qwen. Preserve the frozen core compatibility snapshot and historical retired Kimi entries while removing retired-model recommendations.

  Route OpenAI/Azure Astra through Responses by default and validate its request controls. Add explicit Azure Responses mode for opaque deployment names and normalize Responses reasoning and named tool choice. Validate Gemini 3.8 sampling/prefill/reasoning, recognize Qwen Max/Flash snapshots and Ollama Qwen 3.8, and reject forced tool choices for Claude 5.1. Add typed Claude progress-display and thinking-binding controls with automatic beta headers.

  Catalog additions and offline regression coverage do not imply authenticated model availability or complete parity with every new upstream protocol.

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
