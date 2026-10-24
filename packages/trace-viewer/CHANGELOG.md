# @zhivex-ai/trace-viewer

## 0.2.0

### Minor Changes

- fb35032: Add a local read-only trace viewer for saved governance ledgers and opt-in OpenTelemetry span files. The viewer binds to loopback, redacts secrets before display, and does not change ledger or span formats.

### Patch Changes

- f1ed0ce: Accept OpenAI prompt-cache TTL `"12h"` on Responses `prompt_cache_options` and explicit breakpoints, map `cache_write_tokens_details` into `usage.cacheWriteTokensDetails`, and price 12-hour writes at 2.5× the uncached input rate when that split is present. 30-minute writes and usage without a split keep the catalog cache-write rate. React chat state, realtime frames, AG-UI usage, trace-viewer steps, and agent span attributes keep the 30-minute and 12-hour counts. Anthropic Messages and Claude on Vertex accept an optional `userProfileId` and send it as the `anthropic-user-profile-id` header. These paths (OpenAI 12-hour prompt-cache TTL and the Anthropic `userProfileId` header) are covered by unit tests only; they were not exercised in the live certification of this release.
