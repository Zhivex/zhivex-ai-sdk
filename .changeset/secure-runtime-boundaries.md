---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
"@zhivex-ai/agents": patch
"@zhivex-ai/vertex": patch
"@zhivex-ai/qwen": patch
---

Harden runtime security boundaries: confine file artifact blobs to SDK-managed paths, supervise MCP tools unless explicitly read-only, generate cryptographically random approval tokens, redact and omit sensitive trace payloads by default, propagate cooperative cancellation to tool executions, keep Vertex `rawFetch` unauthenticated, and prevent per-request Qwen image endpoints from receiving provider credentials.
