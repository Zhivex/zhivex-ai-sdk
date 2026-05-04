---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/bedrock": minor
"@zhivex-ai/deepseek": patch
---

Add the agent platform foundation layer across durable agent runs, advanced tool registries, safety policies, replay/evaluation, trace observability, provider parity, fixture/report workflows, and production subagent orchestration.

This release adds compatible durable run primitives with idempotency, cooperative cancellation, schema-versioned state, production run states (`waiting_approval`, `cancel_requested`, `timed_out`, and reserved `queued`), and agent run timeout policy; experimental advanced tool registry helpers with HTTP tools, permissions, audit metadata, registry inspection, and tool fixtures; stable safety policy helpers for approvals, redaction, and budget guards; stable replay, mock, evaluation, report, trace, cost, and latency helpers; stable provider parity matrix rendering and drift reports; and native subagent primitives with shared stores, budgets, cascade cancellation, hierarchical traces, multi-agent evaluations, fail-fast parallel agent groups, and shared defaults.

Promote Bedrock OpenAI-compatible Responses runtime to Tier A agent support with typed hosted tool helpers, remote MCP approval responses, and provider-data approval parsing. Add AWS-native Bedrock AgentCore MCP client and ToolSet helpers for SDK-managed remote tools on Converse/shared agent loops.

Promote DeepSeek to Tier B agent support for portable tool loops, tool choice, JSON object output, streaming, and documented thinking mode while keeping hosted tools, remote MCP, web search, embeddings, audio, and realtime capabilities explicitly unsupported.
