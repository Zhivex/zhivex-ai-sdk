# @zhivex-ai/core

## 1.7.0

### Minor Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

## 1.6.0

### Minor Changes

- Promote Artifact Service, Model Catalog, OpenTelemetry adapters, and the `zhivex-ai` CLI to Stable contracts. Add bounded artifact policies, immutable versioned catalog snapshots, a commit-pinned privacy-first GenAI telemetry contract with model/agent/tool/workflow spans and metrics, official OpenTelemetry SDK lifecycle coverage, strict CLI argument validation, and installed-package CLI/Postgres smoke evidence.

## 1.5.0

### Minor Changes

- Promote SQLite/Postgres workflow state, workflow evaluation baselines and regression gates, and the focused Agent Control Plane contract to Stable. Add fail-closed real-database CI and installed-package certification, versioned workflow evaluation baseline/gate APIs with CLI support, and schema-validated durable single-consumer approval resume through `@zhivex-ai/agents/control-plane`.

## 1.4.0

### Minor Changes

- fc64a26: Promote the shared realtime and live-agent contract to Stable. Harden session
  lifecycle, browser transport and frame encoding, tool-call deduplication,
  post-tool continuation, cancellation, durable idempotency, memory context, and
  fail-closed approvals. Correct provider capability claims and Google/Qwen Live
  protocol handling, and add deterministic installed-package plus live
  Gemini/Qwen/OpenAI certification gates.

## 1.3.0

### Minor Changes

- Add native Z.ai support for GLM-5.3 and GLM-5.2 with model-aware thinking controls, streamed and non-streamed reasoning preservation, function-tool loops, JSON-object structured output, Retry-After-aware backoff, catalog and Gateway registration, CLI scaffolding, and opt-in live smoke coverage.

### Patch Changes

- Add first-class Muse Spark 1.2 support, align tool choice with the authenticated Meta contract, repair retry and Responses streaming behavior in the direct Meta Model API adapter, and add current Muse Glimmer 30B routes for Ollama and OpenRouter with catalog, documentation, and regression coverage.

## 1.2.0

### Minor Changes

- Bring the Ollama adapter up to date with the native REST contract: use object-shaped tool arguments and correlated tool results, surface mid-stream NDJSON errors, preserve thinking through streamed and non-streamed tool loops, expose shared reasoning controls, and add first-class authenticated Ollama Cloud access. Refresh the default Ollama catalog with current Gemma 4, Qwen 3.5, Qwen 3, GPT-OSS, and EmbeddingGemma entries.

## 1.1.2

### Patch Changes

- 888bf99: Fix Postgres-backed agent state, tool-journal, and memory JSON persistence, retry the catalog conflict raised by concurrent table initialization, and publish file-backed execution claims atomically.
- Harden durable subagent recovery, file-store revision CAS, supervised approvals, ledger redaction, artifact integrity, authenticated redirects, provider diagnostics, remote-media policies, Formula tool names, local CLI exports, and release artifact trust boundaries.

## 1.1.1

### Patch Changes

- 0b8ecd5: Add first-class support for the production `qwen3.8-max` contract, including standard Model Studio endpoints, hybrid reasoning, multimodal input, tools, structured output, catalog metadata, documentation, examples, and regression coverage while preserving the separate Token Plan preview behavior.

## 1.1.0

### Minor Changes

- 4188b59: Graduate the declarative workflow runtime, replay and schema contracts, and the in-memory and file-backed workflow state services from Beta to Stable. SQL workflow state services, workflow evaluations, artifact helpers, and CLI workflows remain Beta.

### Patch Changes

- 4188b59: Write file-backed agent, workflow, artifact, and session state through atomic private-file replacements so concurrent readers cannot observe truncated JSON.

## 1.0.3

### Patch Changes

- Fix bodyless HTTP tool responses in Node, honor Qwen realtime frame limits, and refresh GPT-5.6 Terra and Luna pricing.

## 1.0.2

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.

## 1.0.1

### Patch Changes

- Add production-ready support for Gemini 3.6 Flash, Gemini 3.5 Flash-Lite, and the Token Plan-only Qwen 3.8 Max Preview, including model-specific request validation, catalog metadata, documentation, examples, and regression coverage.

## 1.0.0

### Major Changes

- 1150a70: Harden the stable agent and SDK-managed MCP boundaries.

  - Add resumable local-tool approvals with atomic batch preflight, replay-bound decisions, optional signatures, durable approval history, and provider-data isolation.
  - Add typed ephemeral agent context, tool enablement and input/output guardrails, tool error recovery, and schema-validated final agent output.
  - Bind durable runs to canonical harness and execution-environment fingerprints, add app-owned execution authorization, and reject mismatched resumes before side effects.
  - Add durable context compaction with replay and streaming records, plus parent-promoted subagent approvals that resume the same child run.
  - Treat MCP server annotations as untrusted by default, require explicit trust for read-only auto-execution, bound paginated tool discovery, validate declared structured output, and propagate cancellation, timeouts, and idempotency.
  - Propagate AgentCore MCP pagination and cancellation through the Bedrock transport.

  This is a major change because SDK-managed MCP tools that previously auto-executed from an unauthenticated `readOnlyHint` now require approval unless `trustServerToolAnnotations: true` is configured explicitly.

### Minor Changes

- 63f9930: Add the first Zhivex React chat package with headless state, fetch/SSE transport, accessible customizable components, and Runner-aware UI streaming.
