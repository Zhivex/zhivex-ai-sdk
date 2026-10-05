---
"@zhivex-ai/openrouter": patch
"@zhivex-ai/kimi": patch
"@zhivex-ai/bedrock": patch
"@zhivex-ai/azure-openai": patch
"@zhivex-ai/ollama": patch
---

Retry transient HTTP failures before language-model response consumption, honor deadlines during retry backoff, and release stream-opening resources on rejection. Preserve fragmented OpenRouter tool calls and final OpenRouter/Kimi token usage. Surface Bedrock Responses failures and truncation, and release streamed function calls only after successful completion.
