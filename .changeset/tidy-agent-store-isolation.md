---
"@zhivex-ai/core": patch
---

Isolate agent run scopes and tool journals with canonical identity keys, preserve verified legacy runs and their leases/history, make rejected in-memory saves atomic, serialize file-store idempotency saves/claims/deletes, and use consistent ordering for cursor pagination.

Existing file/SQLite/PostgreSQL runs remain readable and writable at their original physical keys only when persisted run ID and scope match exactly. New runs use canonical keys. Upgrade all workers sharing a store together: old workers do not understand the new key format. A legacy record occupying another identity's canonical key now raises a conflict instead of being overwritten; migrate that conflicting record and its indices, lease and journal while workers are stopped. Run IDs and scopes in stored JSON must not be rewritten to bypass identity validation. Default persistent agent memory uses canonical identity envelopes; unverifiable legacy memory requires explicit offline migration. See `docs/maintainers/AGENT_STORE_MIGRATION.md`.
