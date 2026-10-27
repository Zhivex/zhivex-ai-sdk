---
"@zhivex-ai/anthropic": patch
---

Pin `@anthropic-ai/sdk` at 1.2.0. Messages requests still use the adapter's own body, `x-api-key`, beta headers, and `anthropic-version` (default `2023-06-01`). Managed Agents keep that header override.
