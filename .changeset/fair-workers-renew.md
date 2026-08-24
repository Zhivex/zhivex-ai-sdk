---
"@zhivex-ai/core": patch
---

Keep delayed worker heartbeats fail-closed after lease expiry, and coordinate release with any in-flight heartbeat so completed runs cannot recreate worker ownership.
