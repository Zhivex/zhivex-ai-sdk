---
"@zhivex-ai/openai": patch
"@zhivex-ai/xai": patch
"@zhivex-ai/kimi": patch
"@zhivex-ai/sdk": patch
---

Recognize `gpt-6.1-sol` as a vision and tool model that rejects `none` and `minimal` reasoning and requires the Responses API for tools. Treat `grok-4.7` as always-reasoning with `low`, `medium`, `high`, and `xhigh`. Accept Kimi K3 `reasoning_effort` values `low`, `high`, and `max`, and remove retired Kimi ids from the SDK catalog.
