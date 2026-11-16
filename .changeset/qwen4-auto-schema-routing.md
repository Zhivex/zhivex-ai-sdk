---
"@zhivex-ai/qwen": patch
---

Fix Qwen4 automatic routing for native structured output combined with hosted tools or a Responses output limit. Select Responses for the complete request while retaining Chat preference for standalone schemas and rejecting incompatible Chat-only options.
