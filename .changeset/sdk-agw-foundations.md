---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/agents": minor
"@zhivex-ai/gateway": patch
---

Isolate idempotent agent group members by stable identity, reject key collisions, and report pending and cancelled group states instead of premature completion. Existing callers must handle the expanded group status union and reconcile legacy shared group keys before replay.

Preserve complete reported TokenUsage in gateway text/object generation and streaming collection, estimating only missing base counters.
