# @zhivex-ai/kimi

## 0.7.13

### Patch Changes

- b5833e3: Reject private, loopback, link-local, and metadata hosts in `assertTrustedEndpoint`, including IPv6 and IPv4-mapped forms. Replace the Node-only deep-equal helper so Core can bundle for browser and edge. Share the OpenAI-compatible request and SSE loop across DeepSeek, Kimi, Meta, Z.ai, and Ollama, and raise those packages' Core floor to this release. Gateway and OpenRouter move to the same floor because their unit tests load those adapters.
- Updated dependencies [b5833e3]
- Updated dependencies [56b07bf]
  - @zhivex-ai/core@1.33.0

## 0.7.12

### Patch Changes

- 0979b26: Recognize `gpt-6.1-sol` as a vision and tool model that rejects `none` and `minimal` reasoning and requires the Responses API for tools. Treat `grok-4.7` as always-reasoning with `low`, `medium`, `high`, and `xhigh`. Accept Kimi K3 `reasoning_effort` values `low`, `high`, and `max`, and remove retired Kimi ids from the SDK catalog.

## 0.7.11

### Patch Changes

- 10bd4ee: Retry transient HTTP failures before language-model response consumption, honor deadlines during retry backoff, and release stream-opening resources on rejection. Preserve fragmented OpenRouter tool calls and final OpenRouter/Kimi token usage. Surface Bedrock Responses failures and truncation, and release streamed function calls only after successful completion.
- Updated dependencies [70c4fee]
- Updated dependencies [10bd4ee]
- Updated dependencies [10bd4ee]
  - @zhivex-ai/core@1.30.1

## 0.7.10

### Patch Changes

- Updated dependencies [be12ce8]
- Updated dependencies [29ae47c]
- Updated dependencies [29ae47c]
- Updated dependencies [9e5715a]
- Updated dependencies [29ae47c]
  - @zhivex-ai/core@1.24.0

## 0.7.10-next.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.24.0-next.0

## 0.7.9

### Patch Changes

- Updated dependencies [f35fafe]
- Updated dependencies [4f51d78]
- Updated dependencies [e705a21]
  - @zhivex-ai/core@1.23.0

## 0.7.9-next.0

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0

## 0.7.8

### Patch Changes

- Add focused Core agent, generation, provider-helper, and catalog entrypoints. Migrate the Agents root, SDK runtime/catalog, and provider helper imports away from the complete Core aggregation while preserving existing public exports. Qwen also uses the focused provider helpers while retaining its multimodal and realtime behavior.
  
  Separate agent, workflow, and artifact persistence backends and the file generation cache into internal modules without changing schemas, key formats, leases, approvals, or backend behavior. Keep the legacy Core catalog frozen and compatible.
  
  Modularize agent execution helpers and shared type domains behind compatible facades, preserving public signatures and run-view streaming.
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.19.0

## 0.7.7

### Patch Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.
- Updated dependencies
  - @zhivex-ai/core@1.16.1

## 0.7.6

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

## 0.7.5

### Patch Changes

- Harden durable subagent recovery, file-store revision CAS, supervised approvals, ledger redaction, artifact integrity, authenticated redirects, provider diagnostics, remote-media policies, Formula tool names, local CLI exports, and release artifact trust boundaries.
- Updated dependencies [888bf99]
- Updated dependencies
  - @zhivex-ai/core@1.1.2

## 0.7.4

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 0.7.3

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
