---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/openai": minor
"@zhivex-ai/azure-openai": minor
"@zhivex-ai/anthropic": minor
"@zhivex-ai/qwen": minor
"@zhivex-ai/kimi": minor
"@zhivex-ai/bedrock": minor
---

Expand agent hosted-tool capabilities across providers.

- Add normalized agent tool classes for shell, apply patch, tool search, web extraction, and skills.
- Add OpenAI and Azure OpenAI Responses helpers for code interpreter, tool search, shell, and apply patch.
- Gate OpenAI and Azure OpenAI Responses hosted-tool helpers by model before sending requests.
- Update Anthropic web search to `web_search_20260209` by default and add Claude code execution support.
- Move Qwen generation and streaming to the Responses API by default with hosted web search, web extractor, and code interpreter helpers, while keeping `providerOptions.apiMode = "chat"` as the compatibility path.
- Add Kimi official Formula tool helpers and Formula tool loading.
- Add an opt-in Bedrock Mantle/OpenAI-compatible Responses runtime while preserving native Converse as the default.
