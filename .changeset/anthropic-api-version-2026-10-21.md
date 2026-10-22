---
"@zhivex-ai/anthropic": patch
---

Reject `temperature`, `top_p`, and `top_k`, direct assistant document blocks, and non-empty user-message citations locally when `anthropicVersion` is `2026-10-21`. The default `anthropic-version` header remains `2023-06-01`. Bedrock Messages hosts that opt into `2026-10-21` use the same checks, and that version is accepted there only for Claude 4.7 and later.
