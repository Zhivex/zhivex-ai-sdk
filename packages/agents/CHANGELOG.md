# @zhivex-ai/agents

## 1.5.0

### Minor Changes

- 0679e5c: Add GPT-Live-1 server WebSocket sessions with continuous audio, timestamped transcripts, client delegation, context appends, input muting and acknowledged close with final usage. Add the provider-neutral runRealtimeDelegations bridge for application-owned agents, with bounded context, serialized backend tasks, duplicate detection and cancellation. Keep full-duplex sessions separate from the turn-based streamLiveAgent lifecycle. Add the model to the SDK catalog without inventing token pricing for duration-billed voice. Responses-managed delegation, browser WebRTC and SIP are not implemented by this adapter.

### Patch Changes

- Updated dependencies [0679e5c]
  - @zhivex-ai/core@1.16.0

## 1.4.1

### Patch Changes

- Preserve response usage, finish reason and paired diagnostics when strict tool-name validation rejects a batch. Add ToolNotRegisteredError and explicit unknownToolMode recovery bounded by model steps and agent budgets, without executing or approving unknown calls.
- Updated dependencies
  - @zhivex-ai/core@1.15.0

## 1.4.0

### Minor Changes

- ca4cc73: Add opt-in toolExecution.validationErrorMode="tool-result" to return sanitized schema validation errors to the model without executing or approving invalid calls. Preserve strict validation by default, correlate results across mixed batches and approval resumes, and account for current tool errors in agent budget preflight.

### Patch Changes

- Updated dependencies [ca4cc73]
  - @zhivex-ai/core@1.14.0

## 1.3.1

### Patch Changes

- Fix persisted agent compaction counting model usage twice and use current response usage for per-step budget preflight, with or without a run store. Preserve correlated tool-call, approval, and result groups across compaction boundaries, including parallel calls. Serialize synthetic assistant text as output_text in OpenAI Responses while retaining its role and native output metadata.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zhivex-ai/core@1.13.0

## 1.3.0

### Minor Changes

- 8faf5c9: Add sanitized provider tool-call diagnostics, durable Agent error metadata, and fail-closed OpenAI Responses tool-call assembly that waits for terminal completion before local policy or execution.

### Patch Changes

- Updated dependencies [8faf5c9]
  - @zhivex-ai/core@1.10.0

## 1.2.0

### Minor Changes

- Promote SQLite/Postgres workflow state, workflow evaluation baselines and regression gates, and the focused Agent Control Plane contract to Stable. Add fail-closed real-database CI and installed-package certification, versioned workflow evaluation baseline/gate APIs with CLI support, and schema-validated durable single-consumer approval resume through `@zhivex-ai/agents/control-plane`.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.5.0

## 1.1.0

### Minor Changes

- fc64a26: Promote the shared realtime and live-agent contract to Stable. Harden session
  lifecycle, browser transport and frame encoding, tool-call deduplication,
  post-tool continuation, cancellation, durable idempotency, memory context, and
  fail-closed approvals. Correct provider capability claims and Google/Qwen Live
  protocol handling, and add deterministic installed-package plus live
  Gemini/Qwen/OpenAI certification gates.

### Patch Changes

- Updated dependencies [fc64a26]
  - @zhivex-ai/core@1.4.0

## 1.0.2

### Patch Changes

- Harden durable subagent recovery, file-store revision CAS, supervised approvals, ledger redaction, artifact integrity, authenticated redirects, provider diagnostics, remote-media policies, Formula tool names, local CLI exports, and release artifact trust boundaries.
- Updated dependencies [888bf99]
- Updated dependencies
  - @zhivex-ai/core@1.1.2

## 1.0.1

### Patch Changes

- 748944f: Harden credentialed endpoints, uploads, response and stream bounds, cancellation, provider resource identifiers, agent persistence and approvals, gateway routing, React chat rendering, local CLI output, and release provenance verification.
- Updated dependencies [748944f]
  - @zhivex-ai/core@1.0.2

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

### Patch Changes

- Updated dependencies [63f9930]
- Updated dependencies [1150a70]
  - @zhivex-ai/core@1.0.0
