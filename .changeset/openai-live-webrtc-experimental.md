---
"@zhivex-ai/openai": minor
---

Add experimental browser and trusted-server WebRTC entrypoints for GPT-Live-1, including server-side SDP exchange and sideband attachment for application-owned backend delegation. Keep credentials on the server and use caller-provided audio streams without requesting device access.

Support explicit session closure with validated final usage acknowledgements, bounded connection deadlines, and cleanup of SDK-owned audio track clones. Applications remain responsible for authentication, creation quotas, session ownership, and orphan-session watchdogs. These entrypoints remain experimental and are not exported from the stable provider or SDK roots.
