---
"@zhivex-ai/gateway": minor
---

Reduce gateway streaming, message-estimate, agent-startup, and retry overhead without changing request or response shapes. Idle streams reuse one timer and create the timeout error only when it fires. Each request serializes its messages once and reuses that size. The agent runtime loads on the first agent call, with `@zhivex-ai/gateway/agents` as the split entry. Retries use capped exponential backoff with full jitter and still honor Retry-After.
