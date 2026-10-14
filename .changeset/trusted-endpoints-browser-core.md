---
"@zhivex-ai/core": patch
"@zhivex-ai/deepseek": patch
"@zhivex-ai/kimi": patch
"@zhivex-ai/meta": patch
"@zhivex-ai/ollama": patch
"@zhivex-ai/openrouter": patch
"@zhivex-ai/gateway": patch
"@zhivex-ai/zai": patch
---

Reject private, loopback, link-local, and metadata hosts in `assertTrustedEndpoint`, including IPv6 and IPv4-mapped forms. Replace the Node-only deep-equal helper so Core can bundle for browser and edge. Share the OpenAI-compatible request and SSE loop across DeepSeek, Kimi, Meta, Z.ai, and Ollama, and raise those packages' Core floor to this release. Gateway and OpenRouter move to the same floor because their unit tests load those adapters.
