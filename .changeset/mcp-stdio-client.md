---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
---

Add an experimental MCP stdio client at `@zhivex-ai/core/mcp-stdio` and `@zhivex-ai/sdk/mcp-stdio`. `createMcpStdioClient` spawns a local server and implements the pluggable `McpClient` interface for the MCP 2025-11-25 newline-delimited JSON-RPC subset. Browser bundles resolve a stub that throws. `MCP_STDIO_API_STABILITY_MANIFEST` classifies every runtime export as experimental.
