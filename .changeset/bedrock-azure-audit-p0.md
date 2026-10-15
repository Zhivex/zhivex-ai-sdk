---
"@zhivex-ai/core": patch
"@zhivex-ai/bedrock": patch
"@zhivex-ai/azure-openai": patch
"@zhivex-ai/sdk": patch
---

Retry Azure millisecond `retry-after` headers, and fix Bedrock Converse and Azure OpenAI production gaps: typed retries, stream termination, stop reasons, tool-choice history, reasoning round-trip, Entra token providers, deployment base models, Responses URLs, and verified catalog ids. Bedrock Converse reports agent support Tier B. The OpenAI-compatible Bedrock runtime and Azure OpenAI stay Tier A.
