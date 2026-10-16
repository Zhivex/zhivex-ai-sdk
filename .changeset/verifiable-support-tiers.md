---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/agents": minor
"@zhivex-ai/qwen": minor
"@zhivex-ai/gemini": patch
"@zhivex-ai/vertex": patch
"@zhivex-ai/openai": patch
"@zhivex-ai/azure-openai": patch
"@zhivex-ai/bedrock": patch
"@zhivex-ai/anthropic": patch
"@zhivex-ai/xai": patch
"@zhivex-ai/meta": patch
"@zhivex-ai/deepseek": patch
"@zhivex-ai/zai": patch
"@zhivex-ai/kimi": patch
"@zhivex-ai/ollama": patch
"@zhivex-ai/openrouter": patch
---

Derive agent support tiers from capability flags with `deriveAgentSupportTier()`.

Tier A requires callable tools, approval-capable remote MCP (`remoteMcp` and `approvalRequests`), and hosted web search. Hosted web search is the hosted tool shared by OpenAI chat, Azure OpenAI chat, and Bedrock `runtime: "openai"`. A tool-capable realtime session with those MCP approvals is the equivalent when the session API does not advertise hosted web search. Tier B requires callable tools and `durableAgent`. Every other surface is Tier C.

`durableAgent` records that a surface can run the SDK durable agent loop. It is independent of live certification. OpenRouter, Kimi, Ollama, and Qwen Omni language models keep it false.

Qwen 3.8 Omni Flash realtime is Tier A because that session emits `mcp_approval_request`. Qwen text Responses stays Tier B: its MCP API has no approval requests. Qwen LiveTranslate, Gemini and Vertex audio-only realtime, and tool-less Vertex chat surfaces are Tier C. Other declared tiers are unchanged.
