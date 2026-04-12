---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/anthropic": minor
"@zhivex-ai/azure-openai": minor
"@zhivex-ai/bedrock": minor
"@zhivex-ai/gemini": minor
"@zhivex-ai/openai": minor
"@zhivex-ai/ollama": minor
"@zhivex-ai/openrouter": patch
"@zhivex-ai/qwen": patch
"@zhivex-ai/kimi": patch
"@zhivex-ai/vertex": minor
---

Align provider tool support with current upstream APIs.

- add hosted tool definitions to the shared core contract and export them from `@zhivex-ai/sdk`
- add Bedrock Converse tool calling and tool choice support
- add Gemini and Vertex tool choice mapping via function calling config
- add OpenAI and Azure OpenAI Responses API support for hosted tools and mixed hosted/local tool loops
- add Ollama chat-based tool calling and native structured output support
- make providers that only support callable tools reject hosted tools explicitly
- update Anthropic tool choice handling for `none` and parallel tool call capability metadata
- fix Azure OpenAI chat completions requests to consistently forward `tool_choice`
