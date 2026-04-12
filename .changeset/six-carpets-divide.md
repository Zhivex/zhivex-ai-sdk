---
"@zhivex-ai/anthropic": minor
"@zhivex-ai/azure-openai": patch
"@zhivex-ai/bedrock": minor
"@zhivex-ai/gemini": minor
"@zhivex-ai/ollama": minor
"@zhivex-ai/vertex": minor
---

Align provider tool support with current upstream APIs.

- add Bedrock Converse tool calling and tool choice support
- add Gemini and Vertex tool choice mapping via function calling config
- add Ollama chat-based tool calling and native structured output support
- update Anthropic tool choice handling for `none` and parallel tool call capability metadata
- fix Azure OpenAI chat completions requests to consistently forward `tool_choice`
