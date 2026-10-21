---
"@zhivex-ai/core": patch
"@zhivex-ai/openai": patch
"@zhivex-ai/anthropic": patch
"@zhivex-ai/vertex": patch
"@zhivex-ai/react": patch
"@zhivex-ai/ag-ui": patch
"@zhivex-ai/trace-viewer": patch
---

Accept OpenAI prompt-cache TTL `"12h"` on Responses `prompt_cache_options` and explicit breakpoints, map `cache_write_tokens_details` into `usage.cacheWriteTokensDetails`, and price 12-hour writes at 2.5× the uncached input rate when that split is present. 30-minute writes and usage without a split keep the catalog cache-write rate. React chat state, realtime frames, AG-UI usage, trace-viewer steps, and agent span attributes keep the 30-minute and 12-hour counts. Anthropic Messages and Claude on Vertex accept an optional `userProfileId` and send it as the `anthropic-user-profile-id` header.
