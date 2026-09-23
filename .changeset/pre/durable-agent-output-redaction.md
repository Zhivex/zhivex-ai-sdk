---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
"@zhivex-ai/agents": patch
---

Persist terminal agent output redaction across successful runs and later guardrail rejection. Sanitize final state, message/step text, tool result payloads, structured output and metadata while preserving durable execution controls. Document the boundary for live streams, intermediate checkpoints and historical records.
