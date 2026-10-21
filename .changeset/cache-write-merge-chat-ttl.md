---
"@zhivex-ai/core": patch
"@zhivex-ai/react": patch
"@zhivex-ai/openai": patch
---

Keep a cache-write lifetime split only when every write in a React or budget merge is consistent, so merged usage stays on the catalog write rate. `estimateTokenCost` clamps cache tokens that exceed input with or without a lifetime split, and prices the split only when it matches the clamped write count. Chat Completions ignore `prompt_cache_options.ttl` `"12h"` and warn once.
