---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/openai": minor
"@zhivex-ai/azure-openai": minor
"@zhivex-ai/anthropic": minor
"@zhivex-ai/gemini": minor
"@zhivex-ai/vertex": minor
"@zhivex-ai/qwen": minor
"@zhivex-ai/kimi": minor
"@zhivex-ai/deepseek": minor
"@zhivex-ai/bedrock": minor
"@zhivex-ai/openrouter": minor
"@zhivex-ai/ollama": minor
"@zhivex-ai/gateway": minor
---

Expand the provider runtime, media surfaces, agent capabilities, and compatibility coverage across the SDK.

- Add shared Google media, Files API, File Search, Context Caching, Batch, Interactions, hosted tool, and raw prediction primitives across Gemini and Vertex.
- Add normalized agent tool classes plus first-class agent runtime support, persistence, routing, telemetry, approvals, handoffs, and gateway agent execution.
- Add OpenAI and Azure OpenAI Responses helpers for code interpreter, tool search, shell, apply patch, hosted tools, and model-gated agent capabilities.
- Update Anthropic web search to the current provider tool shape and add Claude code execution support.
- Move Qwen generation and streaming to the Responses API by default with hosted web search, web extraction, code interpreter, and Chat Completions compatibility mode.
- Add Kimi official Formula tool helpers, Formula tool loading, and thinking-mode state preservation.
- Add a first-class DeepSeek provider for DeepSeek V4 Chat Completions, streaming, callable tools, JSON object output, thinking mode, and reasoning state preservation.
- Add Bedrock Mantle/OpenAI-compatible Responses runtime support while preserving native Converse as the default.
- Expand OpenRouter and Ollama compatibility coverage to match their updated provider capabilities and tests.
