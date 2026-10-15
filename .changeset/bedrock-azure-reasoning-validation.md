---
"@zhivex-ai/core": patch
"@zhivex-ai/bedrock": patch
"@zhivex-ai/azure-openai": patch
"@zhivex-ai/sdk": patch
---

Honor Bedrock and Azure reasoning requests that the adapters already map. Older Claude `effort: "none"` no longer enables a default thinking budget. Bedrock advertises adaptive `max` and OpenAI-compatible reasoning mode and context. Azure `providerOptions.baseModel` is visible to reasoning validation.
