---
"@zhivex-ai/qwen": minor
"@zhivex-ai/kimi": minor
---

Add shared reasoning support for Qwen and thinking-capable Kimi models.

- map the common Qwen reasoning config to `enable_thinking` and `thinking_budget`
- map the common Kimi reasoning config to the Kimi `thinking` toggle on supported models
- preserve `reasoning_content` across multi-step loops and streaming responses for both providers
- enforce Kimi's documented restriction that forced tool choice is incompatible with enabled thinking
