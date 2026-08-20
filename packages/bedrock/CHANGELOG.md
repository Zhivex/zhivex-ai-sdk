# @zhivex-ai/bedrock

## 1.0.2

### Patch Changes

- Harden the shared runtime and make its architectural boundaries explicit. File-backed generation caches now use private atomic hashed storage with bounded reads, safe cache-key canonicalization, and explicit authentication scopes; abort composition preserves reasons and supports cleanup; and circuit breakers cover streamed failures with per-model half-open probes.

  Add focused Core entrypoints, discriminated Beta capability profiles, provider-neutral resource dispatch, and generic callable adapters that retain every provider's modeled options. The SDK now owns the release-managed default model catalog, exposes explicit Beta and Experimental entrypoints, and machine-checks its curated relationship to Core exports.

- Updated dependencies
  - @zhivex-ai/core@1.7.0

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
