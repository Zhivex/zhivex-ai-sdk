# @zhivex-ai/sdk

## 1.2.0

### Minor Changes

- Bring the Ollama adapter up to date with the native REST contract: use object-shaped tool arguments and correlated tool results, surface mid-stream NDJSON errors, preserve thinking through streamed and non-streamed tool loops, expose shared reasoning controls, and add first-class authenticated Ollama Cloud access. Refresh the default Ollama catalog with current Gemma 4, Qwen 3.5, Qwen 3, GPT-OSS, and EmbeddingGemma entries.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.2.0

## 1.1.2

### Patch Changes

- Harden durable subagent recovery, file-store revision CAS, supervised approvals, ledger redaction, artifact integrity, authenticated redirects, provider diagnostics, remote-media policies, Formula tool names, local CLI exports, and release artifact trust boundaries.
- Updated dependencies [888bf99]
- Updated dependencies
  - @zhivex-ai/core@1.1.2

## 1.1.1

### Patch Changes

- 0b8ecd5: Add first-class support for the production `qwen3.8-max` contract, including standard Model Studio endpoints, hybrid reasoning, multimodal input, tools, structured output, catalog metadata, documentation, examples, and regression coverage while preserving the separate Token Plan preview behavior.
- Updated dependencies [0b8ecd5]
  - @zhivex-ai/core@1.1.1

## 1.1.0

### Minor Changes

- 4188b59: Graduate the declarative workflow runtime, replay and schema contracts, and the in-memory and file-backed workflow state services from Beta to Stable. SQL workflow state services, workflow evaluations, artifact helpers, and CLI workflows remain Beta.

### Patch Changes

- Updated dependencies [4188b59]
- Updated dependencies [4188b59]
  - @zhivex-ai/core@1.1.0

## 1.0.2

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

## 1.0.1

### Patch Changes

- Add production-ready support for Gemini 3.6 Flash, Gemini 3.5 Flash-Lite, and the Token Plan-only Qwen 3.8 Max Preview, including model-specific request validation, catalog metadata, documentation, examples, and regression coverage.
- Updated dependencies
  - @zhivex-ai/core@1.0.1

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

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
