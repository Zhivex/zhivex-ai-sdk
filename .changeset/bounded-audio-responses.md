---
"@zhivex-ai/core": patch
"@zhivex-ai/openai": patch
"@zhivex-ai/azure-openai": patch
"@zhivex-ai/qwen": patch
---

Bound provider audio responses before buffering or JSON/base64 decoding, expose configurable audio response limits and `ProviderResponseTooLargeError`, preserve bounded provider error context, and correctly upload sliced audio byte views.
