---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/openai": minor
"@zhivex-ai/xai": minor
"@zhivex-ai/anthropic": minor
"@zhivex-ai/ollama": minor
"@zhivex-ai/azure-openai": minor
"@zhivex-ai/bedrock": minor
"@zhivex-ai/gemini": minor
"@zhivex-ai/vertex": minor
"@zhivex-ai/qwen": minor
"@zhivex-ai/openrouter": minor
"@zhivex-ai/zai": minor
"@zhivex-ai/kimi": minor
"@zhivex-ai/meta": minor
"@zhivex-ai/deepseek": minor
---

Accept `provider/model` strings, an OpenAI-compatible provider factory, and optional AI SDK loop controls (`stopWhen`, `prepareStep`, `activeTools`, `Output`, JSON Schema tools, and shared `topP` / `seed` / `stopSequences`) without changing existing call defaults. MCP stdio process-exit errors keep their code and message prefix and append a redacted stderr tail.
