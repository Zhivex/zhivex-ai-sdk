---
"@zhivex-ai/core": minor
"@zhivex-ai/sdk": minor
"@zhivex-ai/agents": minor
"@zhivex-ai/react": minor
---

Allow explicit JSON-safe `maxSteps: "unlimited"` in generation and agent runs, including streaming, resume, state and run-view events. Numeric defaults and independent finite operation/budget limits are preserved. Consumers of maxSteps in state and events must narrow the number/string union before arithmetic; older SDK readers must be upgraded before enabling unlimited persisted runs. Clarify existing optional run-policy timeout semantics without adding or relaxing request/tool timeouts.
