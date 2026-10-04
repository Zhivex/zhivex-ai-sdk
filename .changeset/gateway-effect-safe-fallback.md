---
"@zhivex-ai/gateway": patch
---

Preserve typed provider tool-call failures and their reported usage. Forbid retry and fallback unless the provider explicitly marks the failure retryable with no possible effects, including streaming failures before the first event.
