---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
"@zhivex-ai/agents": patch
"@zhivex-ai/openai": patch
"@zhivex-ai/gateway": patch
---

Bound OpenAI PTC continuations by cumulative output tokens and actual provider request limits. Disable automatic PTC request retries and preserve confirmed versus uncertain consumption in sanitized errors and durable agent accounting. Count internal requests against Gateway limits, fail closed before extra requests under per-step token/admission/spend reservations, and clean up failed PTC streams before returning an iterator. Unsafe durable PTC failures cannot automatically resume.
