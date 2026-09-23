---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
"@zhivex-ai/agents": patch
---

Preserve failed subagent links and confirmed usage across terminal errors and durable recovery. Aggregate nested descendants once by run ID, expose unknown usage run IDs in budget diagnostics, and prevent replay of failed idempotent delegations. Preserve the primary execution error when saving its failure or notifying subagent completion also fails.
