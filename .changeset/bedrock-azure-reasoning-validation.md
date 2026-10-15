---
"@zhivex-ai/core": patch
"@zhivex-ai/bedrock": patch
"@zhivex-ai/azure-openai": patch
"@zhivex-ai/sdk": patch
---

Honor Bedrock and Azure reasoning requests that the adapters already map. Older Claude `effort: "none"` no longer enables a default thinking budget. Bedrock advertises adaptive `max` and OpenAI-compatible reasoning mode and context. Azure `providerOptions.baseModel` feeds reasoning validation when core calls `resolveCapabilities`. Core 1.30.1 does not, so those checks still use the deployments map.
