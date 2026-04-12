"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/openai": minor
"@zhivex-ai/azure-openai": minor
"@zhivex-ai/anthropic": minor
"@zhivex-ai/gemini": minor
"@zhivex-ai/vertex": minor

Add end-to-end MCP support helpers across the core SDK and major providers.

- add `createMcpToolSet()` plus MCP client/types to `@zhivex-ai/core` and re-export them from `@zhivex-ai/sdk`
- add remote MCP approval flow support for OpenAI and Azure OpenAI Responses API helpers
- add Anthropic MCP toolset support with `mcp_servers` mapping and provider-data parsing
- add shared MCP client wrappers for Gemini and Vertex
