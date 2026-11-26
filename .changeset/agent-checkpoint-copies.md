---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
---

Reduce repeated full-state copies in agent tool loops. Agent run state is cloned once per validation instead of being serialized again after normalization, the in-memory run store normalizes each loaded or saved state once, and checkpoint history prefixes are compared without serializing every message on each step. Stored state shapes, validation, revisions, and public APIs are unchanged. In a local 200-step benchmark, runs complete about 2.3x faster without a store and 2.2x faster with the in-memory store.
