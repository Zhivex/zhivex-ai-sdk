---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": patch
"@zhivex-ai/agents": patch
---

Add per-invocation memory opt-out for agent runs, streams, resumes, and declared subagents with a persisted disabled policy that survives resumes, while preserving defaults for independent runs and legacy unmarked states.

Claim execution ownership before initializing idempotent memory, including custom stores without leases and runs with leases disabled, so concurrent retries cannot duplicate memory reads.
