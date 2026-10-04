---
"@zhivex-ai/gateway": patch
---

Preserve typed provider tool-call failures and their reported usage. Forbid retry and fallback unless the provider explicitly marks the failure retryable with no possible effects, including streaming failures before the first event.

Retain the last typed provider error when safe retries and fallbacks are exhausted. Record validated tool-error usage after stream output, giving terminal counters precedence over earlier finish counters while keeping unreported costs unknown.
