---
"@zhivex-ai/core": patch
---

Keep delayed worker heartbeats fail-closed after lease expiry, and use bounded release coordination with late cleanup so stalled monitors cannot hang or recreate worker ownership.
