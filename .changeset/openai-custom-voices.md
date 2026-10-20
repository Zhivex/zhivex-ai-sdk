---
"@zhivex-ai/openai": patch
---

Accept OpenAI custom voices as `{ id: string }` on speech, Realtime, and GPT-Live. Named voices such as `"alloy"` and `"marin"` stay strings, those defaults are unchanged, and a custom voice object is sent unchanged. Shared `voice` remains a string. When a Realtime or GPT-Live session is opened with a custom voice, the returned session keeps that object on `config.voice`, and `update()` accepts the same object.
