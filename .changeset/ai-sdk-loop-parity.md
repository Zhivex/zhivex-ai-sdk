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

Accept `provider/model` strings, an OpenAI-compatible provider factory, and optional AI SDK loop controls (`stopWhen`, `prepareStep`, `activeTools`, `Output`, JSON Schema tools, and shared `topP` / `seed` / `stopSequences`) without changing existing call defaults. `stopWhen` without `maxSteps` uses a 20-step safety ceiling instead of one step or an unbounded loop. OpenAI family checks reject shared `topP` on models that already reject `top_p`, and warn-and-omit shared `seed` / `stopSequences` in both API modes. `Output.object` reads the final step. MCP stdio process-exit errors keep their code and message prefix and append a stderr tail that is redacted before it is truncated.
