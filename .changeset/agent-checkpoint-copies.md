---
"@zhivex-ai/core": patch
"@zhivex-ai/sdk": patch
---

Reduce repeated full-state copies in agent tool loops. Validate the serialized checkpoint before retaining it in the in-memory run store. Compare ordinary history data without serializing equal messages on supported runtimes, and preserve JSON serialization behavior for getters, raw JSON, and proxies.
