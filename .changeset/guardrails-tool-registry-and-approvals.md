---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/openai": minor
"@zhivex-ai/azure-openai": minor
"@zhivex-ai/gemini": minor
"@zhivex-ai/vertex": minor
---

Add first-class agent guardrails, local tool approval policies, and richer tool registry helpers.

- add `inputGuardrails` and `outputGuardrails` to the shared agent runtime with guardrail-trigger telemetry and persisted failed run state
- add `toolApprovalPolicy` support for SDK-managed local tool execution, including per-tool `requiresApproval` handling and agent telemetry for approval decisions
- add `ToolRegistry`, `createToolRegistry()`, `toToolSet()`, and `createMcpToolRegistry()` to make it easier to compose local tools, MCP-derived tools, and hosted tools before execution
- add `createOtelObserver()`, `createOtelAgentObserver()`, and `createOtelTelemetryMiddleware()` for OpenTelemetry-oriented model and agent observability
- add shared realtime contracts, `streamLiveAgent()`, and realtime session helpers in `@zhivex-ai/core` / `@zhivex-ai/sdk`
- add official-provider realtime adapters for OpenAI, Azure OpenAI, Gemini, and Vertex, including browser-token helpers where the provider exposes them
- document the new stability-facing agent/runtime capabilities in the root README
