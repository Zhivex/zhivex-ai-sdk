---
"@zhivex-ai/deepseek": patch
"@zhivex-ai/kimi": patch
"@zhivex-ai/meta": patch
"@zhivex-ai/ollama": patch
"@zhivex-ai/openrouter": patch
"@zhivex-ai/zai": patch
---

Raise the `@zhivex-ai/core` dependency floor to 1.34.0 for DeepSeek, Kimi, Meta, Ollama, OpenRouter, and Z.ai. Their unit tests import Core helpers from this checkout, so the declared floor has to match the workspace Core version.
