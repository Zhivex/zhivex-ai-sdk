---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
"@zhivex-ai/agents": patch
---

Retry cancellation revision conflicts with bounded reloads, persist tree cancellation intent before discovery, and preserve terminal descendants. Check durable ancestry around execution admission and before model/tool dispatch so late child claims observe cancellation. Preserve cancellation plus confirmed response evidence when checkpoint writes race it. Tree cancellation remains cooperative; the generic store contract does not provide an atomic cross-run admission fence.

Honor cancellation when pending memory initialization completes or fails, before input guardrails or model dispatch, while preserving persisted memory opt-out and initialization claims.
