---
"@zhivex-ai/meta": patch
---

Preserve reported reasoning tokens in Responses generation, streaming and grounded generation. Reasoning remains a subset of output tokens, so output and total usage are unchanged. Explicit zero and unreported reasoning counts remain distinct.
