---
"@zhivex-ai/qwen": patch
---

Preserve Chat Completions token usage delivered in a terminal usage-only SSE chunk, including Qwen 3.8 Max and Flash. Emit the final finish event after consuming usage instead of dropping it after finish_reason.
