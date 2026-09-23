# @zhivex-ai/agents

## 1.9.0-next.1

### Patch Changes

- 15cd12e: Preserve failed subagent links and confirmed usage across terminal errors and durable recovery. Aggregate nested descendants once by run ID, expose unknown usage run IDs in budget diagnostics, and prevent replay of failed idempotent delegations. Preserve the primary execution error when saving its failure or notifying subagent completion also fails.
- Updated dependencies [15cd12e]
  - @zhivex-ai/core@1.23.0-next.1

## 1.9.0-next.0

### Minor Changes

- Add configurable streaming replay retention and queue limits, including opt-in bounded tail replay for long text, object, and agent streams. Preserve full replay and text-only error behavior by default and document collect-based completion checks. Separate raw agent context input from parsed schema output in class and functional APIs. Expose operational error constructors through the agents facade and reject invalid maxSteps before generation.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.23.0-next.0

## 1.8.0

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

## 1.7.0

### Minor Changes

- Add persisted task outcomes that distinguish technical completion from indeterminate effects, and a Beta API for verified external-effect reconciliation with audit history, lease fencing, replay protection, and restart recovery. Serialize file-store journal CAS and lease mutations. Agent evaluations exclude pending reconciliation from passing cases.

### Patch Changes

- Updated dependencies
  - @zhivex-ai/core@1.18.0

## 1.6.0

### Minor Changes

- 66162f8: Isolate idempotent agent group members by stable identity, reject key collisions, and report pending and cancelled group states instead of premature completion. Existing callers must handle the expanded group status union and reconcile legacy shared group keys before replay.
  
  Preserve complete reported TokenUsage in gateway text/object generation and streaming collection, estimating only missing base counters.
- 631b733: Add optional FIFO maxConcurrency to agent groups, preserving output order and default parallelism. Cancel queued members before model execution or store claims and drain pending entries after fail-fast cancellation.
- a909491: Add opt-in local circuit breaking and explainable adaptive gateway routing, portable agent history import, and configured agent composition with durable route binding.
  
  Allow explicitly independent ordinary tools to overlap with subagents configured while keeping serial barriers and journal completion ordering. Reuse validated checkpoint serialization without removing persistence boundaries, and measure the normalized next revision for state limits.

### Patch Changes

- Updated dependencies [a909491]
- Updated dependencies [66162f8]
- Updated dependencies [631b733]
- Updated dependencies [a909491]
  - @zhivex-ai/core@1.17.0

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
