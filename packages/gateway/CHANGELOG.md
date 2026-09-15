# @zhivex-ai/gateway

## 1.3.0

### Minor Changes

- a909491: Add catalog-backed model cost valuation with cache breakdown, long-context pricing, explicit reasoning semantics, provenance and unknown-cost handling. Gateway costAccounting adds opt-in request quotes and per-attempt reported valuations without changing the legacy rate budget or retrying successful calls on accounting errors.
- a909491: Add bounded opt-in local destination metrics with in-flight counts, rolling latency and TTFT, error/cancellation separation, and an injectable clock/store. Metrics-enabled stream iterator cancellation aborts the routed operation and releases its slot without waiting for an uncooperative provider.
- a909491: Add opt-in local circuit breaking and explainable adaptive gateway routing, portable agent history import, and configured agent composition with durable route binding.
  
  Allow explicitly independent ordinary tools to overlap with subagents configured while keeping serial barriers and journal completion ordering. Reuse validated checkpoint serialization without removing persistence boundaries, and measure the normalized next revision for state limits.

### Patch Changes

- 66162f8: Isolate idempotent agent group members by stable identity, reject key collisions, and report pending and cancelled group states instead of premature completion. Existing callers must handle the expanded group status union and reconcile legacy shared group keys before replay.
  
  Preserve complete reported TokenUsage in gateway text/object generation and streaming collection, estimating only missing base counters.
- Updated dependencies [a909491]
- Updated dependencies [66162f8]
- Updated dependencies [631b733]
- Updated dependencies [a909491]
  - @zhivex-ai/core@1.17.0

## 1.2.2

### Patch Changes

- Update provider dependencies and Zod to current stable releases. MCP output schemas now enforce uniqueItems, property-count and contains constraints through Zod 4.6.3. Bedrock requires Node.js 20 or newer; Vertex requires Node.js 22 or newer to match their upstream SDKs. Other packages retain their runtime requirements.
- Updated dependencies
  - @zhivex-ai/core@1.16.1

## 1.2.1

### Patch Changes

- Expose the shared structured output prompt helper through Core and SDK. Resolve Gateway auto object mode per destination without restarting tool loops, including fallback between native and prompted output.

  Prevent uncooperative stream cleanup from blocking timeout or cancellation. Record terminal stream attempts, reject provider error events consistently, sanitize all attempt diagnostics, and honor bounded Retry-After delays.

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.13.0

## 1.2.0

### Minor Changes

- 744dec7: Accept canonical core ModelMessage history alongside legacy gateway messages. Validate tool call/result associations and JSON payloads before routing, preserve native Anthropic tool and error blocks, and explicitly skip incompatible destinations. Continue generation, object output and streams without reexecuting resolved historical tools, and sanitize history failure/cancellation diagnostics without restarting after partial output. Agent operations retain legacy-only input.
- 744dec7: Add an optional model tool-history capability and an opt-in discriminated JSON tool-result format. OpenAI and Qwen Chat/Responses, and DeepSeek Chat, preserve all tool results and can explicitly serialize success/error envelopes for gateway continuation. Existing direct SDK calls retain raw result serialization. Gateway routing honors adapter-declared support, enables cross-provider fallback without replaying resolved tools, and rejects explicit private-thinking replay for the portable DeepSeek/Qwen subset. Their default portable replay runs without thinking.

### Patch Changes

- Updated dependencies [744dec7]
  - @zhivex-ai/core@1.12.0

## 1.1.0

### Minor Changes

- Add native Z.ai support for GLM-5.3 and GLM-5.2 with model-aware thinking controls, streamed and non-streamed reasoning preservation, function-tool loops, JSON-object structured output, Retry-After-aware backoff, catalog and Gateway registration, CLI scaffolding, and opt-in live smoke coverage.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.3.0

## 1.0.3

### Patch Changes

- Harden durable subagent recovery, file-store revision CAS, supervised approvals, ledger redaction, artifact integrity, authenticated redirects, provider diagnostics, remote-media policies, Formula tool names, local CLI exports, and release artifact trust boundaries.
- Updated dependencies [888bf99]
- Updated dependencies
  - @zhivex-ai/core@1.1.2

## 1.0.2

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
