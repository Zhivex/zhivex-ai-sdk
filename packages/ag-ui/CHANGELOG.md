# @zhivex-ai/ag-ui

## 0.2.0

### Minor Changes

- a1a4d1e: Add an opt-in AG-UI 1.0 stream adapter and a server-side client approval gate that resumes runs through the existing control-plane approval API. The gate is process-local, caps approval history, rejects unsafe JSON pointer segments, and resumes in the run's stored scope. Add React useObject for streaming structured output and useApproval for those client decisions. Object streams stop when an unterminated SSE event exceeds the size cap.

### Patch Changes

- f1ed0ce: Accept OpenAI prompt-cache TTL `"12h"` on Responses `prompt_cache_options` and explicit breakpoints, map `cache_write_tokens_details` into `usage.cacheWriteTokensDetails`, and price 12-hour writes at 2.5× the uncached input rate when that split is present. 30-minute writes and usage without a split keep the catalog cache-write rate. React chat state, realtime frames, AG-UI usage, trace-viewer steps, and agent span attributes keep the 30-minute and 12-hour counts. Anthropic Messages and Claude on Vertex accept an optional `userProfileId` and send it as the `anthropic-user-profile-id` header. These paths (OpenAI 12-hour prompt-cache TTL and the Anthropic `userProfileId` header) are covered by unit tests only; they were not exercised in the live certification of this release.
- Updated dependencies [8e377e4]
- Updated dependencies [7a8b754]
- Updated dependencies [f1ed0ce]
  - @zhivex-ai/core@1.36.0
