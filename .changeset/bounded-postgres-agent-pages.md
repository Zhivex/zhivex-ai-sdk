---
"@zhivex-ai/core": patch
---

Apply agent-run scope, filters, cursor ordering and page limits inside PostgreSQL before transferring state. List and retention queries now fetch at most the requested limit plus one matching state, including when canonical and legacy run keys coexist. Preserve exact scope distinctions, UTF-16 run ID ordering, scoped cursor ties and legacy cursor compatibility. Add non-destructive indexes for logical timestamps and scope-filtered pagination, hashing indexed scope fields to support long identifiers while retaining exact comparisons.
