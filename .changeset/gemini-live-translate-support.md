---
"@zhivex-ai/gemini": patch
"@zhivex-ai/vertex": patch
"@zhivex-ai/core": patch
---

Add Gemini 3.5 Live Translate support across Gemini and Vertex realtime sessions, including typed translation config mapping, model-specific validation, docs, and catalog entries.

Fix Gemini tool and native structured-output requests by normalizing Zod JSON Schema into the subset accepted by the Gemini API, preserving Gemini 3 tool-call thought signatures across local tool loops, and refreshing the live Gemini embedding smoke default to the current `gemini-embedding-001` model.
