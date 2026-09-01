---
"@zhivex-ai/anthropic": minor
"@zhivex-ai/sdk": patch
---

Add current Anthropic authentication support for Bearer tokens, personal and service-account API keys with workspace selection, rotating API-key providers, named profiles, and Workload Identity Federation with cached token refresh and one forced refresh after a 401. Teach the SDK doctor command to recognize API keys, auth tokens, configured WIF environments, and active profiles.
