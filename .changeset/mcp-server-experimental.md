---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
---

Add an experimental MCP server at `@zhivex-ai/core/mcp-server` and `@zhivex-ai/sdk/mcp-server`. It exposes local tools and agents to MCP clients over Streamable HTTP and newline-delimited stdio, pinned to protocol `2025-11-25`. Tools and agent registrations that require approval are not executed; an in-run approval pause is returned as `APPROVAL_REQUIRED` and is not resumed. Synchronous tool failures, `isEnabled`, guardrails, authentication, and reading the HTTP body stay inside the call deadline. Agent progress is not awaited after that deadline, and a throwing `toRunInput` returns `AGENT_FAILED`. Closing the server aborts in-flight HTTP calls. Numeric and string JSON-RPC ids are tracked separately. Oversized HTTP and stdio responses stay within the configured byte cap, and a fatal stdio read closes the session. The Node stdio binder is `@zhivex-ai/sdk/mcp-server-stdio`; browser bundles resolve a stub that throws. `MCP_SERVER_API_STABILITY_MANIFEST` classifies every runtime export as experimental.
