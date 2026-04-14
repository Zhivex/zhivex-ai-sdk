---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/gateway": minor
"@zhivex-ai/openai": minor
"@zhivex-ai/azure-openai": minor
"@zhivex-ai/anthropic": minor
"@zhivex-ai/gemini": minor
"@zhivex-ai/vertex": minor
"@zhivex-ai/bedrock": minor
"@zhivex-ai/ollama": minor
"@zhivex-ai/openrouter": minor
"@zhivex-ai/qwen": minor
"@zhivex-ai/kimi": minor
---

Unify the next release around a fuller agent-ready SDK surface across core, gateway, and the current provider set.

- add the shared agent runtime in `@zhivex-ai/core` and `@zhivex-ai/sdk` with `createAgent()`, `runAgent()`, `resumeAgent()`, `streamAgent()`, serializable run state, approval-aware suspend/resume, UI agent streaming helpers, stores, memory hooks, handoff helpers, and agent telemetry hooks
- add gateway-level agent routing in `@zhivex-ai/gateway` with `runAgent()` and `streamAgent()`, agent capability filtering, and route metadata on agent runs
- expand the shared hosted-tool and capability contract, including normalized agent capabilities, hosted tool classes, and official provider agent support tiers
- add end-to-end MCP helpers across core and major providers, including shared `createMcpToolSet()`, OpenAI/Azure remote MCP approval flow support, Anthropic MCP toolset mapping, and shared Gemini/Vertex MCP wrappers
- align provider tool support with current upstream APIs, including OpenAI/Azure hosted tools, Bedrock tool calling, Gemini/Vertex tool choice mapping, Ollama tool calling and structured output, OpenRouter hosted web search, and clearer hosted-tool rejection where unsupported
- add Ollama embeddings support and OpenRouter hosted web search support
- add shared reasoning support for Qwen and thinking-capable Kimi models, including preserved reasoning state across multi-step loops and Kimi tool-choice restrictions while thinking is enabled
- update capability contracts, provider docs, and examples to match the actual runtime behavior across providers and agent tiers
