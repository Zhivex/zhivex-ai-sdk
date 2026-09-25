---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/agents": minor
---

Add explicit paid-compaction route binding, durable reservations and attempt receipts. Preserve confirmed auxiliary consumption even when summary validation or persistence fails, block retries with unknown consumption, and recompute model output ceilings after compaction.

Add a Beta CAS-backed shared token budget coordinator with primary-call reservations, child allotments and auxiliary-call admission, retaining unknown allocations and isolating budget ledgers from ordinary run retention.
