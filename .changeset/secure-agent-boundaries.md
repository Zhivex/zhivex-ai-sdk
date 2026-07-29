---
"@zhivex-ai/core": major
"@zhivex-ai/sdk": major
"@zhivex-ai/agents": major
"@zhivex-ai/bedrock": major
---

Harden the stable agent and SDK-managed MCP boundaries.

- Add resumable local-tool approvals with atomic batch preflight, replay-bound decisions, optional signatures, durable approval history, and provider-data isolation.
- Add typed ephemeral agent context, tool enablement and input/output guardrails, tool error recovery, and schema-validated final agent output.
- Treat MCP server annotations as untrusted by default, require explicit trust for read-only auto-execution, bound paginated tool discovery, validate declared structured output, and propagate cancellation, timeouts, and idempotency.
- Propagate AgentCore MCP pagination and cancellation through the Bedrock transport.

This is a major change because SDK-managed MCP tools that previously auto-executed from an unauthenticated `readOnlyHint` now require approval unless `trustServerToolAnnotations: true` is configured explicitly.
