# @zhivex-ai/zai

## 0.3.1

### Patch Changes

- Raise the declared `@zhivex-ai/core` floor to 1.37.0. This package loads helpers from this Core release, and the declared minimum must match the workspace Core version.
- Updated dependencies [e3f4af2]
  - @zhivex-ai/core@1.37.0

## 0.3.0

### Minor Changes

- 8e377e4: Accept `provider/model` strings, an OpenAI-compatible provider factory, and optional AI SDK loop controls (`stopWhen`, `prepareStep`, `activeTools`, `Output`, JSON Schema tools, and shared `topP` / `seed` / `stopSequences`) without changing existing call defaults. `stopWhen` without `maxSteps` uses a 20-step safety ceiling instead of one step or an unbounded loop. OpenAI family checks reject shared `topP` on models that already reject `top_p`, and warn-and-omit shared `seed` / `stopSequences` in both API modes. `Output.object` reads the final step. MCP stdio process-exit errors keep their code and message prefix and append a stderr tail that is redacted before it is truncated.

### Patch Changes

- Updated dependencies [8e377e4]
- Updated dependencies [7a8b754]
- Updated dependencies [f1ed0ce]
  - @zhivex-ai/core@1.36.0

## 0.2.7

### Patch Changes

- 387e15e: Gateway deployments authorize the registered region and endpoint. Credentialed provider fetches reject redirects and still load against published core 1.34.0. Gemini, DeepSeek, and Qwen file uploads reject bodies over 64 MiB before they are read. Qwen measures base64 uploads by decoded bytes. Meta streams cap tool-call state. The A2A server authenticates a JSON-RPC request before reading its body.
- Updated dependencies [e41524d]
- Updated dependencies [1a35b44]
- Updated dependencies [4b20b24]
- Updated dependencies [387e15e]
  - @zhivex-ai/core@1.35.0

## 0.2.6

### Patch Changes

- 1bf939d: Raise the `@zhivex-ai/core` dependency floor to 1.34.0 for DeepSeek, Kimi, Meta, Ollama, OpenRouter, and Z.ai. Their unit tests import Core helpers from this checkout, so the declared floor has to match the workspace Core version.

## 0.2.5

### Patch Changes

- b5833e3: Reject private, loopback, link-local, and metadata hosts in `assertTrustedEndpoint`, including IPv6 and IPv4-mapped forms. Replace the Node-only deep-equal helper so Core can bundle for browser and edge. Share the OpenAI-compatible request and SSE loop across DeepSeek, Kimi, Meta, Z.ai, and Ollama, and raise those packages' Core floor to this release. Gateway and OpenRouter move to the same floor because their unit tests load those adapters.
- Updated dependencies [b5833e3]
- Updated dependencies [56b07bf]
  - @zhivex-ai/core@1.33.0

## 0.2.4

### Patch Changes

- Updated dependencies [be12ce8]
- Updated dependencies [29ae47c]
- Updated dependencies [29ae47c]
- Updated dependencies [9e5715a]
- Updated dependencies [29ae47c]
  - @zhivex-ai/core@1.24.0

## 0.2.4-next.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.24.0-next.0

## 0.2.3

### Patch Changes

- Updated dependencies [f35fafe]
- Updated dependencies [4f51d78]
- Updated dependencies [e705a21]
  - @zhivex-ai/core@1.23.0

## 0.2.3-next.0

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0

## 0.2.2

### Patch Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.
  
  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.
  
  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0

## 0.2.1

### Patch Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.
- Updated dependencies
  - @zhivex-ai/core@1.16.1

## 0.2.0

### Minor Changes

- Add first-class GLM-5.3 Flash support with required-thinking validation, `low`/`high`/`max` reasoning efforts, ordered multi-image input, general API and Coding Plan documentation, provider smoke coverage, and current catalog metadata with list pricing.

## 0.1.1

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.1.0

### Minor Changes

- Add native Z.ai support for GLM-5.3 and GLM-5.2 with model-aware thinking controls, streamed and non-streamed reasoning preservation, function-tool loops, JSON-object structured output, Retry-After-aware backoff, catalog and Gateway registration, CLI scaffolding, and opt-in live smoke coverage.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.3.0
