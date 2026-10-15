---
"@zhivex-ai/xai": patch
---

Mark `grok-imagine-image-quality` deprecated ahead of its 2026-11-02 retirement and point callers at `grok-imagine-image-2.0`. The slug still sends as-is until xAI retires it. `grok-imagine-image-2.0` continues to accept `quality: "auto"`.
